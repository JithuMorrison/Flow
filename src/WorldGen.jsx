/**
 * ATLAS ENGINE — chunk-based procedural pixel-art world generator (v2)
 * ------------------------------------------------------------------
 * DESIGN NOTES:
 *
 * 1. SEAMLESSNESS. Every terrain layer (elevation, temperature, moisture,
 *    rivers, lakes) is a pure function of GLOBAL tile coordinates:
 *    f(worldX, worldY, seed, anchors). A chunk is a window into that field,
 *    so two chunks generated in any order line up at the border.
 *
 * 2. RIVERS. A river channel is the near-zero level-set of a continuous
 *    noise field (abs(fbm) < threshold) — the classic "valley line" trick,
 *    which is naturally a connected curve network, not scattered blobs.
 *    On top of that, a large-scale "reliability" field marks about a
 *    quarter of the world's regions as INTERMITTENT: within those regions
 *    only, a second noise mask carves occasional dry gaps into the channel
 *    (like a seasonal wash). Most rivers (the "reliable" regions) flow
 *    fully connected from source band to sea; a minority show breaks.
 *    The valid elevation band itself now fades in/out at its edges instead
 *    of cutting off hard, so rivers taper near their source and mouth
 *    rather than snapping off.
 *
 * 3. BIOME PAINTING. Selecting a target biome for a chunk drops a "climate
 *    anchor" at that chunk's center — not a stamp. Nearby tiles get their
 *    elevation/temperature/moisture RECENTERED toward the target biome's
 *    typical values (an additive shift, with strength fading smoothly with
 *    distance), while the full multi-octave noise texture underneath is
 *    left untouched. That's why painting "Cliff/Canyon" over a chunk still
 *    yields a mix of sea, rock, and grass — the same machinery that
 *    naturally produces coastlines and mountain flanks is just recentered
 *    on a different point in climate-space. Rare biomes (volcano, oasis,
 *    and the fantastical ones below) are additionally boosted by lowering
 *    their natural rarity-roll threshold near a matching anchor, so they
 *    become common locally without being forced onto every tile.
 *
 * 4. RELIEF. The detail view always hillshades terrain using the stored
 *    per-tile elevation grid (simple directional Lambertian shading from
 *    finite-difference slope), so mountain ranges read as raised relief,
 *    not just a color change. A view-mode switcher additionally offers
 *    Elevation / Temperature / Moisture heatmaps for literal height/
 *    climate readouts. Temperature and moisture aren't persisted per tile
 *    (keeps world.json small); they're recomputed on demand, from the
 *    same pure functions used at generation time, only for whichever
 *    chunk is currently open in the detail view.
 *
 * 5. NEW BIOMES. Eight biomes were added: Scorched Earth (+ Lava Lake),
 *    Mistlands, Toxic Wasteland (+ Poison Lake), Bioluminescent Forest,
 *    Stormlands, and Crystal Wastes. Each occurs at low natural rarity in
 *    its own climate niche (so exploring can turn one up unpainted) and
 *    can be reliably summoned via the paint dropdown.
 *
 * 6. STORAGE & DETERMINISM unchanged from v1: every random decision comes
 *    from integer hashing of (seed, coords) — never Math.random() — and a
 *    generated chunk is never recomputed unless explicitly cleared.
 */

import React, { useState, useRef, useCallback, useMemo, useEffect } from "react";
import * as pako from "pako";

/* ============================================================
   1. NOISE ENGINE
   ============================================================ */

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildPermutation(seed) {
  const rand = mulberry32(seed >>> 0);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = p[i];
    p[i] = p[j];
    p[j] = tmp;
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  return perm;
}

const permCache = new Map();
function getPerm(seed, channel) {
  const key = (seed * 131 + channel) >>> 0;
  if (!permCache.has(key)) {
    permCache.set(key, buildPermutation((seed * 2654435761 ^ (channel * 40503)) >>> 0));
  }
  return permCache.get(key);
}

const GRAD = [
  [1, 1], [-1, 1], [1, -1], [-1, -1],
  [1, 0], [-1, 0], [0, 1], [0, -1],
];
function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
function lerp(a, b, t) { return a + t * (b - a); }
function gradDot(hash, x, y) {
  const g = GRAD[hash & 7];
  return g[0] * x + g[1] * y;
}
function perlin2(x, y, perm) {
  const X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
  const xf = x - Math.floor(x), yf = y - Math.floor(y);
  const u = fade(xf), v = fade(yf);
  const aa = perm[perm[X] + Y], ab = perm[perm[X] + Y + 1];
  const ba = perm[perm[X + 1] + Y], bb = perm[perm[X + 1] + Y + 1];
  const x1 = lerp(gradDot(aa, xf, yf), gradDot(ba, xf - 1, yf), u);
  const x2 = lerp(gradDot(ab, xf, yf - 1), gradDot(bb, xf - 1, yf - 1), u);
  return lerp(x1, x2, v);
}

function fbm(x, y, perm, opts) {
  const octaves = (opts && opts.octaves) || 4;
  const lacunarity = (opts && opts.lacunarity) || 2;
  const gain = (opts && opts.gain) || 0.5;
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += perlin2(x * freq, y * freq, perm) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}

function ridgedFbm(x, y, perm, opts) {
  const octaves = (opts && opts.octaves) || 4;
  const lacunarity = (opts && opts.lacunarity) || 2;
  const gain = (opts && opts.gain) || 0.5;
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    let n = 1 - Math.abs(perlin2(x * freq, y * freq, perm));
    n = n * n;
    sum += n * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return norm > 0 ? (sum / norm) * 2 - 1 : 0;
}

function domainWarp(x, y, perm, strength) {
  const wx = fbm(x + 11.7, y - 3.2, perm, { octaves: 3 });
  const wy = fbm(x - 7.1, y + 9.4, perm, { octaves: 3 });
  return [x + wx * strength, y + wy * strength];
}

function hash2i(x, y, seed) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967295;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function smoothstep(a, b, x) {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/* ============================================================
   2. WORLD LAYERS  (all pure functions of GLOBAL tile coords)
   ============================================================ */

const SEA_LEVEL = 0;

function getContinent(gx, gy, seed) {
  return fbm(gx * 0.0022, gy * 0.0022, getPerm(seed, 1), { octaves: 5, lacunarity: 2.15, gain: 0.5 });
}

function getElevation(gx, gy, seed) {
  const c = getContinent(gx, gy, seed);
  let elev = c * 0.75;
  if (c > -0.08) {
    const [wx, wy] = domainWarp(gx * 0.012, gy * 0.012, getPerm(seed, 3), 0.8);
    const ridge = ridgedFbm(wx, wy, getPerm(seed, 2), { octaves: 5, lacunarity: 2.05, gain: 0.55 });
    const landFactor = smoothstep(-0.08, 0.25, c);
    elev += ridge * 0.5 * landFactor;
  }
  const detail = fbm(gx * 0.035, gy * 0.035, getPerm(seed, 4), { octaves: 3 });
  elev += detail * 0.06;
  return clamp(elev, -1, 1);
}

function getTemperature(gx, gy, seed, elevation) {
  const POLE_DIST = 8000;
  const lat = clamp(Math.abs(gy) / POLE_DIST, 0, 1);
  let t = 1 - lat * 2;
  const wobble = fbm(gx * 0.004, gy * 0.004, getPerm(seed, 10), { octaves: 3 }) * 0.25;
  t += wobble;
  t -= Math.max(0, elevation) * 0.5;
  return clamp(t, -1, 1);
}

function getMoisture(gx, gy, seed, elevation) {
  const raw = fbm(gx * 0.006, gy * 0.006, getPerm(seed, 11), { octaves: 4 });
  let m = raw * 0.85 + 0.5;
  if (elevation < 0.06 && elevation > -0.1) m += 0.15;
  return clamp(m, 0, 1);
}

function getRiverValue(gx, gy, seed) {
  const [wx, wy] = domainWarp(gx * 0.02, gy * 0.02, getPerm(seed, 5), 0.6);
  const n = fbm(wx, wy, getPerm(seed, 6), { octaves: 2, lacunarity: 2, gain: 0.5 });
  return Math.abs(n);
}

/* ============================================================
   3. BIOME TABLE
   ============================================================ */

export const BIOME_LIST = [
  ["DEEP_OCEAN", "Deep Ocean", "#0a3854", 0, []],
  ["OCEAN", "Ocean", "#12588a", 0, []],
  ["ROCKY_SHORE", "Rocky Shore", "#7c8f86", 0.02, ["stone_small"]],
  ["BEACH", "Beach", "#ddc98d", 0.015, ["stone_small", "log"]],
  ["RIVER", "River", "#2f8fc7", 0, []],
  ["LAVA_RIVER", "Lava River", "#e04010", 0, []],
  ["LAKE", "Lake", "#2c78b5", 0, []],
  ["MARSH", "Marsh", "#5c6b3c", 0.14, ["dead_bush", "mushroom"]],
  ["SWAMP", "Swamp", "#445226", 0.16, ["tree_dead", "mushroom"]],
  ["PLAINS", "Plains", "#74a13e", 0.05, ["flower", "bush"]],
  ["GRASSLAND", "Grassland", "#5e9e2b", 0.06, ["flower", "bush"]],
  ["FOREST", "Forest", "#4d8f3d", 0.22, ["tree_oak", "tree_birch"]],
  ["DENSE_FOREST", "Dense Forest", "#316a2b", 0.38, ["tree_oak", "tree_pine", "tree_birch"]],
  ["JUNGLE", "Jungle", "#1e8a4a", 0.34, ["tree_palm", "tree_oak"]],
  ["SAVANNAH", "Savannah", "#c3a642", 0.04, ["tree_palm", "bush"]],
  ["DESERT", "Desert", "#e2c368", 0.025, ["cactus", "rock"]],
  ["ROCKY_DESERT", "Rocky Desert", "#b7975d", 0.03, ["rock", "dead_bush"]],
  ["OASIS", "Oasis", "#43bd8b", 0.3, ["tree_palm"]],
  ["SNOW_PLAINS", "Snow Plains", "#eaf1f3", 0.03, ["tree_pine", "rock"]],
  ["TUNDRA", "Tundra", "#b8c5b0", 0.025, ["dead_bush", "rock"]],
  ["GLACIER", "Glacier", "#d6ecf3", 0.008, ["rock"]],
  ["MOUNTAINS", "Mountains", "#8b8479", 0.1, ["rock", "stone_small"]],
  ["HIGH_MOUNTAINS", "High Mountains", "#aca79b", 0.05, ["rock"]],
  ["VOLCANO", "Volcano", "#5a3a34", 0.06, ["rock"]],
  ["CANYON", "Canyon", "#a8623f", 0.06, ["rock", "dead_bush"]],
  ["DEEP_SCORCHED_EARTH", "Deep Scorched Earth", "#7a2418", 0.12, ["charred_tree", "ash_rock", "lava_vent"]],
  ["SCORCHED_EARTH", "Scorched Earth", "#7a2418", 0.09, ["charred_tree", "ash_rock", "lava_vent"]],
  ["LAVA_LAKE", "Lava Lake", "#ff5a1f", 0, []],
  ["MISTLANDS", "Mistlands", "#5a6b6e", 0.10, ["dead_bush", "will_o_wisp", "stone_small"]],
  ["TOXIC_WASTELAND", "Toxic Wasteland", "#5a4a6e", 0.1, ["toxic_shrub", "dead_bush"]],
  ["POISON_LAKE", "Poison Lake", "#8b2fc9", 0, []],
  ["BIOLUMINESCENT_FOREST", "Bioluminescent Forest", "#0a1420", 0.35, ["tree_glow", "mushroom_glow"]],
  ["STORMLANDS", "Stormlands", "#2a2830", 0.12, ["lightning_scorch", "rock"]],
  ["CRYSTAL_WASTES", "Crystal Wastes", "#2a1848", 0.28, ["crystal_cluster"]],
];

export const BIOME_KEY_TO_ID = {};
export const BIOME_ID_TO_KEY = {};
BIOME_LIST.forEach((b, i) => {
  BIOME_KEY_TO_ID[b[0]] = i;
  BIOME_ID_TO_KEY[i] = b[0];
});

export function encodeAnchors(anchorsList) {
  if (!anchorsList || anchorsList.length === 0) return [];
  const output = [];
  const unvisited = [...anchorsList];
  
  while(unvisited.length > 0) {
    const startNode = unvisited.shift();
    const biomeId = BIOME_KEY_TO_ID[startNode.biome];
    if (biomeId === undefined) continue;
    let currentX = startNode.cx;
    let currentY = startNode.cy;
    let seq = "";
    
    // Greedy snake path finding
    let foundNext = true;
    while(foundNext) {
      foundNext = false;
      const dirs = [[0, -1, '0'], [1, 0, '1'], [0, 1, '2'], [-1, 0, '3']];
      for (const [dx, dy, code] of dirs) {
        const nx = currentX + dx;
        const ny = currentY + dy;
        const idx = unvisited.findIndex(a => a.cx === nx && a.cy === ny && a.biome === startNode.biome);
        if (idx !== -1) {
          seq += code;
          currentX = nx;
          currentY = ny;
          unvisited.splice(idx, 1);
          foundNext = true;
          break;
        }
      }
    }
    
    output.push(`start:${startNode.cx};${startNode.cy},biome:${biomeId},seq:${seq}`);
  }
  return output;
}

export function decodeAnchors(encodedList) {
  if (!encodedList || !Array.isArray(encodedList)) return [];
  const anchors = [];
  for (const str of encodedList) {
    const match = str.match(/start:(-?\d+);(-?\d+),biome:(\d+),seq:([0-3]*)/);
    if (!match) continue;
    let cx = parseInt(match[1]);
    let cy = parseInt(match[2]);
    const biome = BIOME_ID_TO_KEY[parseInt(match[3])];
    if (!biome) continue;
    anchors.push({cx, cy, biome});
    for (let i = 0; i < match[4].length; i++) {
      const code = match[4][i];
      if (code === '0') cy -= 1;
      else if (code === '1') cx += 1;
      else if (code === '2') cy += 1;
      else if (code === '3') cx -= 1;
      anchors.push({cx, cy, biome});
    }
  }
  return anchors;
}

const B = {};
BIOME_LIST.forEach((row, i) => { B[row[0]] = i; });
const BIOME_DEFS = BIOME_LIST.map(([key, name, color, objectDensity, objectKinds]) => ({
  key, name, color, objectDensity, objectKinds,
}));

// Biomes a person can pick from the "paint" dropdown. Water-transition types
// (river/lake/beach/rocky-shore/lava-lake/poison-lake/deep-ocean) are left
// out since they're derived features, not sensible whole-chunk targets.
const PAINTABLE_GROUPS = [
  ["Deep Ocean", ["DEEP_OCEAN"]],
  ["Coast", ["OCEAN", "BEACH"]],
  ["Temperate", ["PLAINS", "GRASSLAND", "FOREST", "DENSE_FOREST"]],
  ["Tropical", ["JUNGLE", "SAVANNAH", "SWAMP"]],
  ["Arid", ["DESERT", "ROCKY_DESERT", "OASIS", "CANYON"]],
  ["Cold", ["SNOW_PLAINS", "TUNDRA", "GLACIER"]],
  ["Highland", ["MOUNTAINS", "HIGH_MOUNTAINS", "VOLCANO"]],
  ["Fantastical", ["DEEP_SCORCHED_EARTH", "SCORCHED_EARTH", "MISTLANDS", "TOXIC_WASTELAND", "BIOLUMINESCENT_FOREST", "STORMLANDS", "CRYSTAL_WASTES"]],
];

// Target climate profile each paintable biome recenters toward. rarityKey
// (only on low-natural-probability biomes) also lowers that biome's
// hash-roll threshold near a matching anchor.
const BIOME_PROFILES = {
  DEEP_OCEAN: { elevation: -0.65, temperature: 0, moisture: 0.5 },
  OCEAN: { elevation: -0.5, temperature: 0, moisture: 0.5 },
  BEACH: { elevation: 0.03, temperature: 0.1, moisture: 0.5 },
  PLAINS: { elevation: 0.12, temperature: 0.1, moisture: 0.43 },
  GRASSLAND: { elevation: 0.12, temperature: 0.15, moisture: 0.58 },
  FOREST: { elevation: 0.15, temperature: -0.1, moisture: 0.75 },
  DENSE_FOREST: { elevation: 0.18, temperature: -0.15, moisture: 0.9 },
  JUNGLE: { elevation: 0.12, temperature: 0.5, moisture: 0.68 },
  SAVANNAH: { elevation: 0.1, temperature: 0.4, moisture: 0.45 },
  SWAMP: { elevation: 0.06, temperature: 0.15, moisture: 0.9 },
  DESERT: { elevation: 0.08, temperature: 0.5, moisture: 0.08 },
  ROCKY_DESERT: { elevation: 0.15, temperature: 0.35, moisture: 0.28 },
  OASIS: { elevation: 0.1, temperature: 0.55, moisture: 0.12, rarityKey: "OASIS" },
  CANYON: { elevation: 0.6, temperature: 0.3, moisture: 0.15 },
  SNOW_PLAINS: { elevation: 0.15, temperature: -0.45, moisture: 0.4 },
  TUNDRA: { elevation: 0.15, temperature: -0.4, moisture: 0.25 },
  GLACIER: { elevation: 0.6, temperature: -0.7, moisture: 0.15 },
  MOUNTAINS: { elevation: 0.7, temperature: 0, moisture: 0.5 },
  HIGH_MOUNTAINS: { elevation: 0.9, temperature: -0.2, moisture: 0.4 },
  VOLCANO: { elevation: 0.9, temperature: 0.85, moisture: 0.35, rarityKey: "VOLCANO" },
  DEEP_SCORCHED_EARTH: { elevation: 0.12, temperature: 0.95, moisture: 0.02, rarityKey: "DEEP_SCORCHED_EARTH" },
  SCORCHED_EARTH: { elevation: 0.12, temperature: 0.85, moisture: 0.06, rarityKey: "SCORCHED_EARTH" },
  MISTLANDS: { elevation: 0.25, temperature: -0.1, moisture: 0.6, rarityKey: "MISTLANDS" },
  TOXIC_WASTELAND: { elevation: 0.05, temperature: 0.2, moisture: 0.82, rarityKey: "TOXIC_WASTELAND" },
  BIOLUMINESCENT_FOREST: { elevation: 0.14, temperature: -0.1, moisture: 0.78, rarityKey: "BIOLUMINESCENT_FOREST" },
  STORMLANDS: { elevation: 0.1, temperature: 0.1, moisture: 0.5, rarityKey: "STORMLANDS" },
  CRYSTAL_WASTES: { elevation: 0.6, temperature: -0.25, moisture: 0.35, rarityKey: "CRYSTAL_WASTES" },
};

const ELEV_BASELINE = 0.12, TEMP_BASELINE = 0, MOIST_BASELINE = 0.5;

/**
 * Sums the pull of every nearby biome anchor at a global tile position.
 * Returns additive biases (not absolute targets) so the natural noise
 * texture is preserved underneath — recentering climate-space rather than
 * overwriting it. Also returns per-biome rarity-roll weights so rare
 * biomes become locally common without forcing every tile to match.
 */
function computeAnchorEffect(gx, gy, anchors, chunkTiles) {
  if (!anchors || anchors.length === 0) {
    return { elevBias: 0, tempBias: 0, moistBias: 0, rarityWeights: {} };
  }
  const radius = chunkTiles * 1.5;
  let elevSum = 0, tempSum = 0, moistSum = 0, weightSum = 0;
  const rarityWeights = {};
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i];
    const profile = BIOME_PROFILES[a.biome];
    if (!profile) continue;
    const acx = a.cx * chunkTiles + chunkTiles / 2;
    const acy = a.cy * chunkTiles + chunkTiles / 2;
    const dist = Math.max(Math.abs(gx - acx), Math.abs(gy - acy));
    if (dist >= radius) continue;
    const t = 1 - dist / radius;
    const w = t * t * (3 - 2 * t);
    elevSum += w * profile.elevation;
    tempSum += w * profile.temperature;
    moistSum += w * profile.moisture;
    weightSum += w;
    if (profile.rarityKey) {
      rarityWeights[profile.rarityKey] = Math.min(1, (rarityWeights[profile.rarityKey] || 0) + w);
    }
  }
  if (weightSum <= 0) return { elevBias: 0, tempBias: 0, moistBias: 0, rarityWeights };
  // Tighter radius (1.5×) makes the bias decay visibly from chunk center
  // to edges, creating within-chunk gradients (e.g. scorched → rocky desert).
  // Softer elevation pull for ocean-type targets preserves coast gradients;
  // stronger pull for land targets reaches mountain/highland elevation.
  const rawPull = Math.min(1, weightSum);
  const targetElev = elevSum / weightSum;
  const elevPull = rawPull * (targetElev < ELEV_BASELINE ? 0.5 : 0.8);
  const climatePull = rawPull * 0.95; // Stronger pull to ensure biome changes
  return {
    elevBias: elevPull * (targetElev - ELEV_BASELINE),
    targetTemp: tempSum / weightSum,
    targetMoist: moistSum / weightSum,
    climatePull,
    rarityWeights,
  };
}

/** Land classification only — ocean/beach/river/lake are decided by the caller. */
function classifyLandBiome(gx, gy, seed, elevation, temperature, moisture, rarityWeights) {
  const rw = rarityWeights || {};

  // PAINTED RARITY BIOME OVERRIDES (Seamless Fade-out)
  // If explicitly painted, these biomes bypass climate bounds to fade out smoothly.
  if (rw.MISTLANDS > 0 && hash2i(gx, gy, seed + 8600) > lerp(0.99, -0.1, rw.MISTLANDS)) return B.MISTLANDS;
  if (rw.BIOLUMINESCENT_FOREST > 0 && hash2i(gx, gy, seed + 8300) > lerp(0.992, -0.1, rw.BIOLUMINESCENT_FOREST)) return B.BIOLUMINESCENT_FOREST;
  if (rw.STORMLANDS > 0 && hash2i(gx, gy, seed + 8400) > lerp(0.99, -0.1, rw.STORMLANDS)) return B.STORMLANDS;
  if (rw.CRYSTAL_WASTES > 0 && hash2i(gx, gy, seed + 8500) > lerp(0.992, -0.1, rw.CRYSTAL_WASTES)) return B.CRYSTAL_WASTES;
  if (rw.TOXIC_WASTELAND > 0 && hash2i(gx, gy, seed + 8200) > lerp(0.985, -0.1, rw.TOXIC_WASTELAND)) return B.TOXIC_WASTELAND;
  if (rw.OASIS > 0 && hash2i(gx, gy, seed + 8002) > lerp(0.997, -0.1, rw.OASIS)) return B.OASIS;
  const effScorch = Math.max(rw.SCORCHED_EARTH || 0, rw.DEEP_SCORCHED_EARTH || 0);
  if (effScorch > 0 && hash2i(gx, gy, seed + 8100) > lerp(0.985, -0.3, effScorch)) {
    if (hash2i(gx, gy, seed + 8101) > lerp(0.99, -0.1, rw.DEEP_SCORCHED_EARTH || 0)) return B.DEEP_SCORCHED_EARTH;
    return B.SCORCHED_EARTH;
  }

  if (elevation > 0.72) {
    const regionalRarity = hash2i(Math.floor(gx / 40), Math.floor(gy / 40), seed + 7001);
    if ((regionalRarity > 0.95 && temperature > 0.2) || temperature > 0.75) return B.VOLCANO;
    const crystalRoll = hash2i(gx, gy, seed + 8500);
    if (temperature < -0.15 && crystalRoll > lerp(0.992, -0.1, rw.CRYSTAL_WASTES || 0)) return B.CRYSTAL_WASTES;
    return temperature < -0.1 ? B.HIGH_MOUNTAINS : B.MOUNTAINS;
  }
  if (elevation > 0.5) {
    if (temperature < -0.35) return B.GLACIER;
    const crystalRoll2 = hash2i(gx, gy, seed + 8501);
    if (temperature < -0.2 && crystalRoll2 > lerp(0.99, -0.1, rw.CRYSTAL_WASTES || 0)) return B.CRYSTAL_WASTES;
    if (moisture < 0.22 && temperature > 0.1) return B.CANYON;
    return B.MOUNTAINS;
  }
  if (temperature < -0.35) {
    const crystalRoll3 = hash2i(gx, gy, seed + 8502);
    if (elevation > 0.3 && crystalRoll3 > lerp(0.995, -0.1, rw.CRYSTAL_WASTES || 0)) return B.CRYSTAL_WASTES;
    return moisture > 0.35 ? B.SNOW_PLAINS : B.TUNDRA;
  }
  if (temperature < -0.05) {
    if (moisture < 0.3) return B.TUNDRA;
    const mistRoll = hash2i(gx, gy, seed + 8600);
    if (moisture > 0.45 && mistRoll > lerp(0.99, -0.1, rw.MISTLANDS || 0)) return B.MISTLANDS;
    if (moisture < 0.55) return B.SNOW_PLAINS;
    if (moisture < 0.85) {
      const glowRoll = hash2i(gx, gy, seed + 8300);
      if (glowRoll > lerp(0.992, -0.1, rw.BIOLUMINESCENT_FOREST || 0)) return B.BIOLUMINESCENT_FOREST;
      return B.FOREST;
    }
    const glowRoll2 = hash2i(gx, gy, seed + 8301);
    if (glowRoll2 > lerp(0.99, -0.1, rw.BIOLUMINESCENT_FOREST || 0)) return B.BIOLUMINESCENT_FOREST;
    return B.DENSE_FOREST;
  }
  if (temperature < 0.3) {
    if (moisture < 0.2) return B.DESERT;
    if (moisture < 0.35) return B.ROCKY_DESERT;
    if (moisture < 0.5) return B.PLAINS;
    const stormRoll = hash2i(gx, gy, seed + 8400);
    if (moisture < 0.6 && stormRoll > lerp(0.99, -0.1, rw.STORMLANDS || 0)) return B.STORMLANDS;
    if (moisture < 0.65) return B.GRASSLAND;
    if (moisture < 0.8) return B.FOREST;
    const toxicRoll = hash2i(gx, gy, seed + 8200);
    if (toxicRoll > lerp(0.985, -0.1, rw.TOXIC_WASTELAND || 0)) return B.TOXIC_WASTELAND;
    return B.SWAMP;
  }
  // hot
  if (moisture < 0.18) {
    const effectiveScorch = Math.max(rw.SCORCHED_EARTH || 0, rw.DEEP_SCORCHED_EARTH || 0);
    const scorchRoll = hash2i(gx, gy, seed + 8100);
    // Lower lerp target (-0.3) makes scorched earth spread much further outwards
    if (elevation > 0.15 && scorchRoll > lerp(0.985, -0.3, effectiveScorch)) {
      const deepScorchRoll = hash2i(gx, gy, seed + 8101);
      if (deepScorchRoll > lerp(0.99, -0.1, rw.DEEP_SCORCHED_EARTH || 0)) return B.DEEP_SCORCHED_EARTH;
      return B.SCORCHED_EARTH;
    }
    const oasisRoll = hash2i(gx, gy, seed + 8002);
    return oasisRoll > lerp(0.997, -0.1, rw.OASIS || 0) ? B.OASIS : B.DESERT;
  }
  if (moisture < 0.38) return B.ROCKY_DESERT;
  if (moisture < 0.55) return B.SAVANNAH;
  if (moisture < 0.75) return B.JUNGLE;
  const toxicRoll2 = hash2i(gx, gy, seed + 8201);
  if (toxicRoll2 > lerp(0.985, -0.1, rw.TOXIC_WASTELAND || 0)) return B.TOXIC_WASTELAND;
  return moisture < 0.96 ? B.SWAMP : B.MARSH;
}

function sampleTile(gx, gy, seed, anchors, chunkTiles) {
  const eff = computeAnchorEffect(gx, gy, anchors, chunkTiles);
  let elevation = clamp(getElevation(gx, gy, seed) + eff.elevBias, -1, 1);
  let temperature = getTemperature(gx, gy, seed, elevation);
  let moisture = getMoisture(gx, gy, seed, elevation);

  // Interpolate climate to strictly guarantee the painted biome spawns,
  // overriding extreme natural noise while leaving a fraction for organic borders.
  if (eff.climatePull > 0) {
    temperature = temperature * (1 - eff.climatePull) + eff.targetTemp * eff.climatePull;
    moisture = moisture * (1 - eff.climatePull) + eff.targetMoist * eff.climatePull;
  }
  temperature = clamp(temperature, -1, 1);
  moisture = clamp(moisture, 0, 1);

  if (elevation < -0.32) {
    return { elevation, temperature, moisture, isRiver: false, isLake: false, biomeId: B.DEEP_OCEAN };
  }
  if (elevation < SEA_LEVEL) {
    return { elevation, temperature, moisture, isRiver: false, isLake: false, biomeId: B.OCEAN };
  }

  let isRiver = false, isLake = false;
  if (elevation > SEA_LEVEL - 0.04 && elevation < 0.68) {
    const riverVal = getRiverValue(gx, gy, seed);
    const widthN = fbm(gx * 0.0015, gy * 0.0015, getPerm(seed, 12), { octaves: 2 }) * 0.5 + 0.5;
    // Wider fade band so rivers flow smoothly to the coast and taper
    // gently near their mountain source.
    const bandFade = smoothstep(SEA_LEVEL - 0.04, SEA_LEVEL + 0.02, elevation)
      * (1 - smoothstep(0.56, 0.68, elevation));
    const threshold = (0.0025 + widthN * 0.006) * clamp(bandFade, 0.12, 1);
    let flowing = riverVal < threshold;
    if (flowing) {
      // ~12% of large-scale regions are "intermittent": rare dry gaps.
      // The vast majority of rivers flow fully connected.
      const reliability = hash2i(Math.floor(gx / 260), Math.floor(gy / 260), seed + 55501);
      if (reliability > 0.88) {
        const gapNoise = fbm(gx * 0.02 + 91, gy * 0.02 + 91, getPerm(seed, 14), { octaves: 2 });
        if (gapNoise < -0.28) flowing = false;
      }
    }
    isRiver = flowing;
    if (isRiver) moisture = clamp(moisture + 0.25, 0, 1);
  }
  if (!isRiver && elevation > SEA_LEVEL + 0.01 && elevation < 0.3) {
    const basin = fbm(gx * 0.012, gy * 0.012, getPerm(seed, 13), { octaves: 3 }) * 0.5 + 0.5;
    isLake = basin > 0.66 && elevation < 0.2;
    if (isLake) moisture = clamp(moisture + 0.3, 0, 1);
  }

  const landBiomeId = classifyLandBiome(gx, gy, seed, elevation, temperature, moisture, eff.rarityWeights);
  let biomeId;
  if (isLake) {
    biomeId = (landBiomeId === B.SCORCHED_EARTH || landBiomeId === B.DEEP_SCORCHED_EARTH) ? B.LAVA_LAKE
      : landBiomeId === B.TOXIC_WASTELAND ? B.POISON_LAKE
      : B.LAKE;
  } else if (isRiver) {
    // Lava rivers in scorched earth and hot arid zones
    const isScorchedArea = landBiomeId === B.SCORCHED_EARTH || landBiomeId === B.DEEP_SCORCHED_EARTH ||
      (temperature > 0.6 && moisture < 0.2);
    biomeId = isScorchedArea ? B.LAVA_RIVER : B.RIVER;
  } else if (elevation < SEA_LEVEL + 0.06) {
    biomeId = temperature < -0.25 ? B.ROCKY_SHORE : B.BEACH;
  } else {
    biomeId = landBiomeId;
  }
  return { elevation, temperature, moisture, isRiver, isLake, biomeId };
}

/* ============================================================
   4. OBJECT PLACEMENT + PIXEL SPRITES
   ============================================================ */

function pickObjectKind(def, gx, gy, seed) {
  const r = hash2i(gx, gy, seed + 777);
  const kinds = def.objectKinds;
  const idx = Math.min(kinds.length - 1, Math.floor(r * kinds.length));
  return kinds[idx];
}

function neighborHasObjectNear(cx, cy, tx, ty, chunkTiles, chunks) {
  const dirs = [];
  if (tx === 0) dirs.push([-1, 0]);
  if (tx === chunkTiles - 1) dirs.push([1, 0]);
  if (ty === 0) dirs.push([0, -1]);
  if (ty === chunkTiles - 1) dirs.push([0, 1]);
  for (const [dx, dy] of dirs) {
    const neighbor = chunks[`${cx + dx},${cy + dy}`];
    if (!neighbor) continue;
    const mx = dx !== 0 ? (dx > 0 ? 0 : chunkTiles - 1) : tx;
    const my = dy !== 0 ? (dy > 0 ? 0 : chunkTiles - 1) : ty;
    const found = neighbor.objects.some((o) => {
      const ox = o.t % chunkTiles, oy = Math.floor(o.t / chunkTiles);
      return Math.abs(ox - mx) <= 1 && Math.abs(oy - my) <= 1;
    });
    if (found) return true;
  }
  return false;
}

function shadeColor(hex, factor) {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  const rr = clamp(Math.round(r * factor), 0, 255);
  const gg = clamp(Math.round(g * factor), 0, 255);
  const bb = clamp(Math.round(b * factor), 0, 255);
  return `rgb(${rr},${gg},${bb})`;
}

function drawObjectSprite(ctx, x, y, tilePx, obj) {
  const cx = x + tilePx / 2, cy = y + tilePx / 2;
  const s = (obj.s / 100) * (tilePx / 10);
  const variant = obj.v;
  switch (obj.k) {
    case "tree_oak":
    case "tree_birch":
    case "tree_cherry": {
      const canopy = { tree_oak: ["#2e6b2a", "#245420"], tree_birch: ["#4a8f3f", "#3a7332"], tree_cherry: ["#e37fa0", "#d46a8c"] }[obj.k];
      ctx.fillStyle = obj.k === "tree_birch" ? "#e8e4d8" : "#5a3d24";
      ctx.fillRect(cx - 1 * s, cy - 0.5 * s, 2 * s, 4 * s);
      ctx.fillStyle = canopy[variant % 2];
      ctx.fillRect(cx - 3.5 * s, cy - 6 * s, 7 * s, 5 * s);
      ctx.fillRect(cx - 2.5 * s, cy - 7.5 * s, 5 * s, 2.5 * s);
      break;
    }
    case "tree_pine": {
      ctx.fillStyle = "#5a3d24";
      ctx.fillRect(cx - 1 * s, cy - 0.5 * s, 2 * s, 3 * s);
      ctx.fillStyle = variant % 2 ? "#1f5c2e" : "#245c33";
      ctx.fillRect(cx - 1.5 * s, cy - 8 * s, 3 * s, 3 * s);
      ctx.fillRect(cx - 2.5 * s, cy - 5.5 * s, 5 * s, 3 * s);
      ctx.fillRect(cx - 3.5 * s, cy - 3 * s, 7 * s, 3 * s);
      break;
    }
    case "tree_palm": {
      ctx.fillStyle = "#7a5a30";
      ctx.fillRect(cx - 1 * s, cy - 7 * s, 2 * s, 7 * s);
      ctx.fillStyle = "#2e9c4f";
      ctx.fillRect(cx - 4 * s, cy - 9 * s, 4 * s, 2 * s);
      ctx.fillRect(cx, cy - 9 * s, 4 * s, 2 * s);
      ctx.fillRect(cx - 3 * s, cy - 10.5 * s, 6 * s, 2 * s);
      break;
    }
    case "tree_dead": {
      ctx.fillStyle = "#6b5a4a";
      ctx.fillRect(cx - 0.7 * s, cy - 6 * s, 1.4 * s, 6 * s);
      ctx.fillRect(cx - 2.5 * s, cy - 5 * s, 2 * s, 0.8 * s);
      ctx.fillRect(cx + 0.5 * s, cy - 4 * s, 2 * s, 0.8 * s);
      break;
    }
    case "bush": {
      ctx.fillStyle = variant % 2 ? "#3f7a35" : "#4a8a3e";
      ctx.fillRect(cx - 2 * s, cy - 2 * s, 4 * s, 3 * s);
      break;
    }
    case "flower": {
      const colors = ["#e0475b", "#e8c93a", "#8a4fd8", "#e8e8e8"];
      ctx.fillStyle = colors[variant % colors.length];
      ctx.fillRect(cx - 0.6 * s, cy - 0.6 * s, 1.2 * s, 1.2 * s);
      break;
    }
    case "cactus": {
      ctx.fillStyle = "#3f7a4a";
      ctx.fillRect(cx - 1 * s, cy - 5 * s, 2 * s, 5 * s);
      ctx.fillRect(cx - 2.5 * s, cy - 3 * s, 1.5 * s, 2.5 * s);
      ctx.fillRect(cx + 1 * s, cy - 3.5 * s, 1.5 * s, 2.5 * s);
      break;
    }
    case "dead_bush": {
      ctx.fillStyle = "#8a6b47";
      ctx.fillRect(cx - 1.8 * s, cy - 2 * s, 3.6 * s, 2 * s);
      break;
    }
    case "mushroom": {
      ctx.fillStyle = "#e8e0d0";
      ctx.fillRect(cx - 0.4 * s, cy - 1.2 * s, 0.8 * s, 1.2 * s);
      ctx.fillStyle = variant % 2 ? "#c0453f" : "#b8863f";
      ctx.fillRect(cx - 1 * s, cy - 2 * s, 2 * s, 1 * s);
      break;
    }
    case "rock":
    case "stone_small": {
      ctx.fillStyle = variant % 2 ? "#8a887f" : "#6f6d64";
      ctx.fillRect(cx - 1.5 * s, cy - 1.3 * s, 3 * s, 2.2 * s);
      break;
    }
    case "log": {
      ctx.fillStyle = "#6b4a2c";
      ctx.fillRect(cx - 2 * s, cy - 0.8 * s, 4 * s, 1.2 * s);
      break;
    }
    case "ruins": {
      ctx.fillStyle = "#8a8578";
      ctx.fillRect(cx - 1 * s, cy - 5 * s, 1.6 * s, 5 * s);
      ctx.fillRect(cx + 1.5 * s, cy - 3 * s, 1.6 * s, 3 * s);
      break;
    }
    case "charred_tree": {
      ctx.fillStyle = "#2a2422";
      ctx.fillRect(cx - 1 * s, cy - 0.5 * s, 2 * s, 4 * s);
      ctx.fillStyle = "#1a1614";
      ctx.fillRect(cx - 2.5 * s, cy - 5 * s, 2 * s, 0.8 * s);
      ctx.fillRect(cx + 0.5 * s, cy - 4 * s, 2 * s, 0.8 * s);
      break;
    }
    case "ash_rock": {
      ctx.fillStyle = variant % 2 ? "#3a332f" : "#4a4038";
      ctx.fillRect(cx - 1.5 * s, cy - 1.3 * s, 3 * s, 2.2 * s);
      break;
    }
    case "lava_vent": {
      ctx.fillStyle = "#2a1a14";
      ctx.fillRect(cx - 1.6 * s, cy - 1 * s, 3.2 * s, 1.8 * s);
      ctx.shadowColor = "#ff6a2a";
      ctx.shadowBlur = 4 * s;
      ctx.fillStyle = "#ff9a3f";
      ctx.fillRect(cx - 0.6 * s, cy - 0.5 * s, 1.2 * s, 1 * s);
      ctx.shadowBlur = 0;
      break;
    }
    case "will_o_wisp": {
      ctx.shadowColor = "#c9f0ff";
      ctx.shadowBlur = 5 * s;
      ctx.fillStyle = "#e8fbff";
      ctx.fillRect(cx - 0.5 * s, cy - 4 * s, 1 * s, 1 * s);
      ctx.shadowBlur = 0;
      break;
    }
    case "toxic_shrub": {
      ctx.fillStyle = variant % 2 ? "#7a3fae" : "#6a8f3f";
      ctx.fillRect(cx - 2 * s, cy - 2.2 * s, 4 * s, 3 * s);
      ctx.fillStyle = "#a8e83f";
      ctx.fillRect(cx - 0.5 * s, cy - 1.5 * s, 1 * s, 1 * s);
      break;
    }
    case "tree_glow": {
      ctx.fillStyle = "#0a0e18";
      ctx.fillRect(cx - 1 * s, cy - 0.5 * s, 2 * s, 4 * s);
      ctx.shadowColor = variant % 2 ? "#00e5ff" : "#4080ff";
      ctx.shadowBlur = 7 * s;
      ctx.fillStyle = variant % 2 ? "#00d4ff" : "#3060e0";
      ctx.fillRect(cx - 3 * s, cy - 6.5 * s, 6 * s, 5 * s);
      ctx.shadowBlur = 0;
      break;
    }
    case "mushroom_glow": {
      ctx.fillStyle = "#1a2030";
      ctx.fillRect(cx - 0.4 * s, cy - 1.2 * s, 0.8 * s, 1.2 * s);
      ctx.shadowColor = "#00e5ff";
      ctx.shadowBlur = 6 * s;
      ctx.fillStyle = "#00d4ff";
      ctx.fillRect(cx - 1 * s, cy - 2 * s, 2 * s, 1 * s);
      ctx.shadowBlur = 0;
      break;
    }
    case "lightning_scorch": {
      ctx.fillStyle = "#2a2830";
      ctx.fillRect(cx - 1.6 * s, cy - 0.5 * s, 3.2 * s, 1 * s);
      ctx.shadowColor = "#e8d84f";
      ctx.shadowBlur = 4 * s;
      ctx.strokeStyle = "#f0e878";
      ctx.lineWidth = Math.max(1, s * 0.4);
      ctx.beginPath();
      ctx.moveTo(cx - 0.5 * s, cy - 7 * s);
      ctx.lineTo(cx + 0.6 * s, cy - 3 * s);
      ctx.lineTo(cx - 0.3 * s, cy - 3 * s);
      ctx.lineTo(cx + 0.7 * s, cy + 0.5 * s);
      ctx.stroke();
      ctx.shadowBlur = 0;
      break;
    }
    case "crystal_cluster": {
      ctx.shadowColor = variant % 2 ? "#40c0ff" : "#a040e0";
      ctx.shadowBlur = 5 * s;
      ctx.fillStyle = variant % 2 ? "#60d8ff" : "#c060ff";
      ctx.fillRect(cx - 0.7 * s, cy - 5 * s, 1.4 * s, 5 * s);
      ctx.fillRect(cx - 2.5 * s, cy - 3 * s, 1.3 * s, 3 * s);
      ctx.fillRect(cx + 1.2 * s, cy - 3.5 * s, 1.3 * s, 3.5 * s);
      // Additional small crystals
      ctx.fillStyle = variant % 2 ? "#80e0ff" : "#d080ff";
      ctx.fillRect(cx - 3.5 * s, cy - 1.5 * s, 1 * s, 1.5 * s);
      ctx.fillRect(cx + 2.5 * s, cy - 2 * s, 1 * s, 2 * s);
      ctx.shadowBlur = 0;
      break;
    }
    default:
      break;
  }
}

/* ============================================================
   5. CHUNK GENERATION
   ============================================================ */

function generateChunkData(cx, cy, world, existingChunks) {
  const { seed, chunkTiles, anchors = [] } = world;
  const n = chunkTiles * chunkTiles;
  const biomes = new Array(n);
  const elevations = new Array(n);
  const temperatures = new Array(n);
  const moistures = new Array(n);
  const objects = [];
  let elevMin = 1, elevMax = -1, elevSum = 0, riverCount = 0, lakeCount = 0;
  const biomeFreq = {};

  for (let ty = 0; ty < chunkTiles; ty++) {
    for (let tx = 0; tx < chunkTiles; tx++) {
      const gx = cx * chunkTiles + tx, gy = cy * chunkTiles + ty;
      const s = sampleTile(gx, gy, seed, anchors, chunkTiles);
      const idx = ty * chunkTiles + tx;
      biomes[idx] = s.biomeId;
      elevations[idx] = Math.round((s.elevation + 1) * 127.5);
      temperatures[idx] = Math.round((s.temperature + 1) * 127.5);
      moistures[idx] = Math.round(s.moisture * 255);
      elevMin = Math.min(elevMin, s.elevation);
      elevMax = Math.max(elevMax, s.elevation);
      elevSum += s.elevation;
      if (s.isRiver) riverCount++;
      if (s.isLake) lakeCount++;
      biomeFreq[s.biomeId] = (biomeFreq[s.biomeId] || 0) + 1;

      const def = BIOME_DEFS[s.biomeId];
      if (def.objectDensity > 0) {
        const r = hash2i(gx, gy, seed + 911);
        if (r < def.objectDensity) {
          const nearEdge = tx === 0 || tx === chunkTiles - 1 || ty === 0 || ty === chunkTiles - 1;
          const blocked = nearEdge && neighborHasObjectNear(cx, cy, tx, ty, chunkTiles, existingChunks);
          if (!blocked) {
            let kind = pickObjectKind(def, gx, gy, seed);
            if ((s.biomeId === B.PLAINS || s.biomeId === B.GRASSLAND || s.biomeId === B.FOREST) &&
                hash2i(gx, gy, seed + 9009) > 0.9985) {
              kind = "ruins";
            }
            const variant = Math.floor(hash2i(gx, gy, seed + 222) * 4);
            const rot = Math.floor(hash2i(gx, gy, seed + 333) * 4);
            const scale = Math.round((0.8 + hash2i(gx, gy, seed + 444) * 0.5) * 100);
            objects.push({ t: idx, k: kind, v: variant, r: rot, s: scale });
          }
        }
      }
    }
  }

  let dominant = 0, domCount = -1;
  for (const k in biomeFreq) {
    if (biomeFreq[k] > domCount) { domCount = biomeFreq[k]; dominant = Number(k); }
  }
  const neighborsAtGeneration = {};
  [["n", 0, -1], ["s", 0, 1], ["e", 1, 0], ["w", -1, 0]].forEach(([dir, dx, dy]) => {
    neighborsAtGeneration[dir] = !!existingChunks[`${cx + dx},${cy + dy}`];
  });

  return {
    cx, cy,
    biomes, elevations, temperatures, moistures, objects,
    stats: {
      elevMin: +elevMin.toFixed(3),
      elevMax: +elevMax.toFixed(3),
      elevAvg: +(elevSum / n).toFixed(3),
      riverTiles: riverCount,
      lakeTiles: lakeCount,
      objectCount: objects.length,
      dominantBiome: BIOME_DEFS[dominant].name,
    },
    neighborsAtGeneration,
  };
}

/** Recomputes per-tile temperature/moisture for the detail heatmap views.
 *  Not persisted in world.json — cheap to redo on demand for one chunk. */
function computeClimateGrid(cx, cy, seed, anchors, chunkTiles) {
  const n = chunkTiles * chunkTiles;
  const temperature = new Float32Array(n);
  const moisture = new Float32Array(n);
  for (let ty = 0; ty < chunkTiles; ty++) {
    for (let tx = 0; tx < chunkTiles; tx++) {
      const gx = cx * chunkTiles + tx, gy = cy * chunkTiles + ty;
      const eff = computeAnchorEffect(gx, gy, anchors, chunkTiles);
      const elev = clamp(getElevation(gx, gy, seed) + eff.elevBias, -1, 1);
      const temp = clamp(getTemperature(gx, gy, seed, elev) + eff.tempBias, -1, 1);
      const moist = clamp(getMoisture(gx, gy, seed, elev) + eff.moistBias, 0, 1);
      const idx = ty * chunkTiles + tx;
      temperature[idx] = temp;
      moisture[idx] = moist;
    }
  }
  return { temperature, moisture };
}

function makeThumbnail(chunk, chunkTiles) {
  const THUMB = 32;
  const c = document.createElement("canvas");
  c.width = THUMB;
  c.height = THUMB;
  const ctx = c.getContext("2d");
  const step = chunkTiles / THUMB;
  for (let ty = 0; ty < THUMB; ty++) {
    for (let tx = 0; tx < THUMB; tx++) {
      const sx = Math.min(chunkTiles - 1, Math.floor(tx * step));
      const sy = Math.min(chunkTiles - 1, Math.floor(ty * step));
      const idx = sy * chunkTiles + sx;
      ctx.fillStyle = BIOME_DEFS[chunk.biomes[idx]].color;
      ctx.fillRect(tx, ty, 1, 1);
    }
  }
  return c.toDataURL();
}

function elevationToColor(byte) {
  const e = byte / 255;
  if (e < 0.34) {
    const t = e / 0.34;
    return `rgb(${Math.round(8 + t * 10)}, ${Math.round(30 + t * 40)}, ${Math.round(70 + t * 60)})`;
  } else if (e < 0.5) {
    const t = (e - 0.34) / 0.16;
    return `rgb(${Math.round(60 + t * 80)}, ${Math.round(110 + t * 70)}, ${Math.round(60 + t * 30)})`;
  } else if (e < 0.68) {
    const t = (e - 0.5) / 0.18;
    return `rgb(${Math.round(140 - t * 30)}, ${Math.round(120 - t * 20)}, ${Math.round(70 + t * 10)})`;
  } else if (e < 0.85) {
    const t = (e - 0.68) / 0.17;
    return `rgb(${Math.round(110 + t * 80)}, ${Math.round(100 + t * 80)}, ${Math.round(80 + t * 90)})`;
  }
  const t = (e - 0.85) / 0.15;
  return `rgb(${Math.round(230 + t * 25)}, ${Math.round(230 + t * 25)}, ${Math.round(235 + t * 20)})`;
}
function temperatureToColor(t) {
  const c = clamp(t, -1, 1);
  if (c < 0) {
    const k = c + 1;
    return `rgb(${Math.round(40 + k * 180)}, ${Math.round(60 + k * 170)}, ${Math.round(120 + k * 120)})`;
  }
  const k = c;
  return `rgb(${Math.round(220 + k * 30)}, ${Math.round(220 - k * 160)}, ${Math.round(210 - k * 190)})`;
}
function moistureToColor(m) {
  const k = clamp(m, 0, 1);
  return `rgb(${Math.round(150 - k * 110)}, ${Math.round(120 + k * 80)}, ${Math.round(70 - k * 20)})`;
}
function elevToMeters(e) { return Math.round(e * 4200); }

function drawChunk(ctx, chunk, chunkTiles, tilePx, viewMode, sampleGrid) {
  ctx.clearRect(0, 0, chunkTiles * tilePx, chunkTiles * tilePx);
  const at = (x, y) => Math.max(0, Math.min(chunkTiles - 1, y)) * chunkTiles + Math.max(0, Math.min(chunkTiles - 1, x));

  for (let ty = 0; ty < chunkTiles; ty++) {
    for (let tx = 0; tx < chunkTiles; tx++) {
      const idx = ty * chunkTiles + tx;
      let color;
      if (viewMode === "elevation") {
        color = elevationToColor(chunk.elevations[idx]);
      } else if (viewMode === "temperature") {
        const tempVal = chunk.temperatures ? (chunk.temperatures[idx] / 127.5 - 1) : 0;
        color = temperatureToColor(tempVal);
      } else if (viewMode === "moisture") {
        const moistVal = chunk.moistures ? (chunk.moistures[idx] / 255) : 0;
        color = moistureToColor(moistVal);
      } else {
        const def = BIOME_DEFS[chunk.biomes[idx]];
        const eL = chunk.elevations[at(tx - 1, ty)], eR = chunk.elevations[at(tx + 1, ty)];
        const eU = chunk.elevations[at(tx, ty - 1)], eD = chunk.elevations[at(tx, ty + 1)];
        const dx = (eR - eL) / 2, dy = (eD - eU) / 2;
        const nx = -dx, ny = -dy, nz = 95;
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        const dot = (nx * -0.5 + ny * -0.5 + nz * 0.62) / (len * 0.938);
        const hill = clamp(dot, 0, 1);
        const elevNorm = chunk.elevations[idx] / 255;
        const shade = clamp((0.6 + hill * 0.75) * (0.9 + elevNorm * 0.18), 0.4, 1.4);
        color = shadeColor(def.color, shade);
      }
      ctx.fillStyle = color;
      ctx.fillRect(tx * tilePx, ty * tilePx, tilePx + 0.5, tilePx + 0.5);

      if (viewMode === "terrain") {
        const biomeId = chunk.biomes[idx];
        if (biomeId === B.MISTLANDS) {
          // Heavy fog overlay with scattered cloud wisps
          const fogHash = hash2i(tx * 3, ty * 3, 44401);
          const fogAlpha = 0.25 + fogHash * 0.2;
          ctx.globalAlpha = fogAlpha;
          ctx.fillStyle = "#c8d0d4";
          ctx.fillRect(tx * tilePx, ty * tilePx, tilePx + 0.5, tilePx + 0.5);
          if ((tx * 7 + ty * 11) % 9 < 3) {
            ctx.globalAlpha = 0.15 + fogHash * 0.1;
            ctx.fillStyle = "#e0e8ec";
            ctx.fillRect(tx * tilePx, ty * tilePx, tilePx + 0.5, tilePx * 0.6);
          }
          ctx.globalAlpha = 1;
        } else if (biomeId === B.BIOLUMINESCENT_FOREST) {
          // Glowing ground patches and tiny glow dots
          const glowHash = hash2i(tx, ty, 55501);
          if (glowHash > 0.6) {
            ctx.globalAlpha = 0.3 + glowHash * 0.2;
            ctx.fillStyle = glowHash > 0.85 ? "#00e5ff" : "#0a2060";
            ctx.fillRect(tx * tilePx, ty * tilePx, tilePx + 0.5, tilePx + 0.5);
            ctx.globalAlpha = 1;
          }
          if (glowHash > 0.75) {
            ctx.shadowColor = "#00d4ff";
            ctx.shadowBlur = tilePx * 0.8;
            ctx.fillStyle = "#40ffea";
            const dotSize = tilePx * 0.25;
            ctx.fillRect(
              tx * tilePx + tilePx * 0.5 - dotSize / 2,
              ty * tilePx + tilePx * 0.5 - dotSize / 2,
              dotSize, dotSize
            );
            ctx.shadowBlur = 0;
          }
        } else if (biomeId === B.CRYSTAL_WASTES) {
          // Purple rock texture with crystal glints
          const crystalHash = hash2i(tx, ty, 66601);
          if (crystalHash > 0.5) {
            ctx.fillStyle = crystalHash > 0.8 ? "#60c8ff" : "#4a2868";
            ctx.globalAlpha = 0.5 + crystalHash * 0.3;
            ctx.fillRect(tx * tilePx, ty * tilePx, tilePx + 0.5, tilePx + 0.5);
            ctx.globalAlpha = 1;
          }
          if (crystalHash > 0.88) {
            ctx.shadowColor = "#80d0ff";
            ctx.shadowBlur = tilePx * 0.6;
            ctx.fillStyle = "#b0e8ff";
            const gs = tilePx * 0.3;
            ctx.fillRect(tx * tilePx + tilePx * 0.35, ty * tilePx + tilePx * 0.35, gs, gs);
            ctx.shadowBlur = 0;
          }
        } else if (biomeId === B.STORMLANDS) {
          // Dark rocky texture variation
          const stormHash = hash2i(tx, ty, 77701);
          if (stormHash > 0.4) {
            ctx.fillStyle = stormHash > 0.7 ? "#35303a" : "#1e1c24";
            ctx.globalAlpha = 0.4;
            ctx.fillRect(tx * tilePx, ty * tilePx, tilePx + 0.5, tilePx + 0.5);
            ctx.globalAlpha = 1;
          }
          // Lightning flash tiles
          if ((tx * 7 + ty * 13) % 37 === 0) {
            ctx.shadowColor = "#ffe840";
            ctx.shadowBlur = tilePx * 1.2;
            ctx.fillStyle = "#fff8c0";
            ctx.fillRect(tx * tilePx, ty * tilePx, tilePx + 0.5, tilePx + 0.5);
            ctx.shadowBlur = 0;
          }
        } else if (biomeId === B.LAVA_LAKE && (tx + ty) % 5 === 0) {
          ctx.fillStyle = "#ffb15a";
          ctx.fillRect(tx * tilePx + tilePx * 0.25, ty * tilePx + tilePx * 0.25, tilePx * 0.5, tilePx * 0.5);
        } else if (biomeId === B.LAVA_RIVER) {
          // Bright lava flow spots
          if ((tx + ty) % 4 === 0) {
            ctx.fillStyle = "#ff8030";
            ctx.fillRect(tx * tilePx + tilePx * 0.2, ty * tilePx + tilePx * 0.2, tilePx * 0.6, tilePx * 0.6);
          }
        } else if (biomeId === B.POISON_LAKE && (tx + ty) % 5 === 0) {
          ctx.fillStyle = "#c96fef";
          ctx.fillRect(tx * tilePx + tilePx * 0.25, ty * tilePx + tilePx * 0.25, tilePx * 0.5, tilePx * 0.5);
        }
      }
    }
  }

  if (viewMode === "terrain") {
    const sorted = chunk.objects.slice().sort((a, b) => Math.floor(a.t / chunkTiles) - Math.floor(b.t / chunkTiles));
    for (const o of sorted) {
      const tx = o.t % chunkTiles, ty = Math.floor(o.t / chunkTiles);
      drawObjectSprite(ctx, tx * tilePx, ty * tilePx, tilePx, o);
    }
  }
}

/* ============================================================
   6. UI
   ============================================================ */

const GRID_COLS = 7;
const GRID_ROWS = 5;

export { B, BIOME_DEFS, drawChunk, elevToMeters, makeThumbnail, generateChunkData };

export default function AtlasEngine() {
  const [seed, setSeed] = useState(9842374);
  const [seedInput, setSeedInput] = useState("9842374");
  const [chunkTiles, setChunkTiles] = useState(50);
  const [tilePxDetail, setTilePxDetail] = useState(11);
  const [chunks, setChunks] = useState({});
  const [anchors, setAnchors] = useState([]);
  const [paintBiome, setPaintBiome] = useState("NATURAL");
  const [viewMode, setViewMode] = useState("terrain");
  const [center, setCenter] = useState({ cx: 0, cy: 0 });
  const [selected, setSelected] = useState({ cx: 0, cy: 0 });
  const [showLegend, setShowLegend] = useState(false);
  const detailCanvasRef = useRef(null);

  // Backend save state
  const [mapId, setMapId] = useState(null);
  const [isFrozen, setIsFrozen] = useState(false);
  const [mapsList, setMapsList] = useState([]);
  const [savedKeys, setSavedKeys] = useState(new Set()); // keys already saved to backend
  const [saveMsg, setSaveMsg] = useState("");

  // Undo/Redo stacks (compressed for memory efficiency)
  const [undoStack, setUndoStack] = useState([]); // [{type, keys, compressed, anchorsSnap}]
  const [redoStack, setRedoStack] = useState([]);
  const MAX_UNDO = 20;

  const cells = useMemo(() => {
    const out = [];
    for (let ry = 0; ry < GRID_ROWS; ry++) {
      for (let rx = 0; rx < GRID_COLS; rx++) {
        out.push({
          cx: center.cx + rx - Math.floor(GRID_COLS / 2),
          cy: center.cy + ry - Math.floor(GRID_ROWS / 2),
        });
      }
    }
    return out;
  }, [center]);

  // --- Compressed Undo/Redo helpers ---
  const compressChunks = useCallback((chunksObj, keys) => {
    const subset = {};
    for (const k of keys) {
      subset[k] = chunksObj[k] || null; // null = didn't exist
    }
    const json = JSON.stringify(subset);
    return pako.deflate(json); // returns Uint8Array
  }, []);

  const decompressChunks = useCallback((compressed) => {
    const inflated = pako.inflate(compressed);
    const json = new TextDecoder().decode(inflated);
    return JSON.parse(json);
  }, []);

  const pushUndo = useCallback((type, keys, prevChunks, prevAnchors) => {
    const compressed = compressChunks(prevChunks, keys);
    setUndoStack((prev) => [...prev.slice(-(MAX_UNDO - 1)), { type, keys, compressed, anchorsSnap: prevAnchors }]);
    setRedoStack([]); // clear redo on new action
  }, [compressChunks, MAX_UNDO]);

  const performUndo = useCallback(() => {
    if (undoStack.length === 0) return;
    const entry = undoStack[undoStack.length - 1];
    // Save current state for redo before restoring
    const redoCompressed = compressChunks(chunks, entry.keys);
    setRedoStack((prev) => [...prev, { type: entry.type, keys: entry.keys, compressed: redoCompressed, anchorsSnap: anchors }]);
    // Restore previous state
    const prevChunks = decompressChunks(entry.compressed);
    setChunks((cur) => {
      const next = { ...cur };
      for (const k of entry.keys) {
        if (prevChunks[k] === null) delete next[k];
        else next[k] = prevChunks[k];
      }
      return next;
    });
    setAnchors(entry.anchorsSnap);
    setUndoStack((prev) => prev.slice(0, -1));
  }, [undoStack, chunks, anchors, compressChunks, decompressChunks]);

  const performRedo = useCallback(() => {
    if (redoStack.length === 0) return;
    const entry = redoStack[redoStack.length - 1];
    // Save current state for undo before restoring
    const undoCompressed = compressChunks(chunks, entry.keys);
    setUndoStack((prev) => [...prev, { type: entry.type, keys: entry.keys, compressed: undoCompressed, anchorsSnap: anchors }]);
    // Restore redo state
    const redoChunks = decompressChunks(entry.compressed);
    setChunks((cur) => {
      const next = { ...cur };
      for (const k of entry.keys) {
        if (redoChunks[k] === null) delete next[k];
        else next[k] = redoChunks[k];
      }
      return next;
    });
    setAnchors(entry.anchorsSnap);
    setRedoStack((prev) => prev.slice(0, -1));
  }, [redoStack, chunks, anchors, compressChunks, decompressChunks]);

  const generateChunk = useCallback((cx, cy, targetBiome) => {
    const key = `${cx},${cy}`;
    if (chunks[key]) { setSelected({ cx, cy }); return; }
    // Push undo entry (previous state for this key)
    pushUndo("single", [key], chunks, anchors);
    const painted = targetBiome && targetBiome !== "NATURAL" ? targetBiome : null;
    let nextAnchors = anchors;
    if (painted && !anchors.some((a) => a.cx === cx && a.cy === cy)) {
      nextAnchors = [...anchors, { cx, cy, biome: painted }];
      setAnchors(nextAnchors);
    }
    const world = { seed, chunkTiles, anchors: nextAnchors };
    const data = generateChunkData(cx, cy, world, chunks);
    const thumb = makeThumbnail(data, chunkTiles);
    setChunks((prev) => ({ ...prev, [key]: { ...data, thumb, generatedAt: Date.now(), paintedBiome: painted } }));
    setSelected({ cx, cy });
  }, [seed, chunkTiles, chunks, anchors, pushUndo]);

  const generateAllVisible = useCallback(() => {
    let accAnchors = anchors;
    const accChunks = { ...chunks };
    const painted = paintBiome !== "NATURAL" ? paintBiome : null;
    const newKeys = []; // track newly generated for undo
    for (const { cx, cy } of cells) {
      const key = `${cx},${cy}`;
      if (accChunks[key]) continue;
      newKeys.push(key);
      if (painted && !accAnchors.some((a) => a.cx === cx && a.cy === cy)) {
        accAnchors = [...accAnchors, { cx, cy, biome: painted }];
      }
      const world = { seed, chunkTiles, anchors: accAnchors };
      const data = generateChunkData(cx, cy, world, accChunks);
      const thumb = makeThumbnail(data, chunkTiles);
      accChunks[key] = { ...data, thumb, generatedAt: Date.now(), paintedBiome: painted };
    }
    if (newKeys.length > 0) pushUndo("batch", newKeys, chunks, anchors);
    setAnchors(accAnchors);
    setChunks(accChunks);
  }, [cells, seed, chunkTiles, chunks, anchors, paintBiome, pushUndo]);

  const refreshVisible = useCallback(async () => {
    const accChunks = { ...chunks };
    const toRemove = [];
    for (const { cx, cy } of cells) {
      if (accChunks[`${cx},${cy}`]) toRemove.push(`${cx},${cy}`);
    }
    
    let refreshId = null;
    if (mapId && toRemove.length > 0) {
      try {
        const rRes = await fetch(`/api/maps/${mapId}/refresh`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ anchors: encodeAnchors(anchors) })
        });
        const rData = await rRes.json();
        refreshId = rData.id;
      } catch (e) {
        console.warn("Failed to create refresh event", e);
      }
    }

    for (const key of toRemove) {
      const [cx, cy] = key.split(",").map(Number);
      const world = { seed, chunkTiles, anchors };
      const data = generateChunkData(cx, cy, world, accChunks);
      const thumb = makeThumbnail(data, chunkTiles);
      const painted = anchors.find(a => a.cx === cx && a.cy === cy)?.biome || null;
      
      const oldRefreshIds = accChunks[key].refresh_ids || [];
      const nextRefreshIds = refreshId ? [...oldRefreshIds, refreshId] : oldRefreshIds;
      
      accChunks[key] = { ...data, thumb, generatedAt: Date.now(), paintedBiome: painted, refresh_ids: nextRefreshIds };
    }
    
    if (toRemove.length > 0) {
      setSavedKeys((prev) => {
        const next = new Set(prev);
        toRemove.forEach((k) => next.delete(k));
        return next;
      });
      setChunks(accChunks);
    }
  }, [cells, seed, chunkTiles, chunks, anchors, mapId]);

  const refreshSelected = useCallback(async () => {
    const key = `${selected.cx},${selected.cy}`;
    if (!chunks[key]) return;
    
    let refreshId = null;
    if (mapId) {
      try {
        const rRes = await fetch(`/api/maps/${mapId}/refresh`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ anchors: encodeAnchors(anchors) })
        });
        const rData = await rRes.json();
        refreshId = rData.id;
      } catch (e) {
        console.warn("Failed to create refresh event", e);
      }
    }

    const accChunks = { ...chunks };
    const world = { seed, chunkTiles, anchors };
    const data = generateChunkData(selected.cx, selected.cy, world, accChunks);
    const thumb = makeThumbnail(data, chunkTiles);
    const painted = anchors.find(a => a.cx === selected.cx && a.cy === selected.cy)?.biome || null;
    
    const oldRefreshIds = accChunks[key].refresh_ids || [];
    const nextRefreshIds = refreshId ? [...oldRefreshIds, refreshId] : oldRefreshIds;

    accChunks[key] = { ...data, thumb, generatedAt: Date.now(), paintedBiome: painted, refresh_ids: nextRefreshIds };
    
    setSavedKeys((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    setChunks(accChunks);
  }, [selected, seed, chunkTiles, chunks, anchors, mapId]);

  const clearChunk = useCallback((cx, cy) => {
    const key = `${cx},${cy}`;
    setChunks((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
    setAnchors((prev) => prev.filter((a) => !(a.cx === cx && a.cy === cy)));
    setSavedKeys((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }, []);

  const resetWorld = useCallback((newSeed) => {
    const s = newSeed === undefined ? Math.floor(Math.random() * 1e7) : newSeed;
    setChunks({});
    setAnchors([]);
    setSeed(s);
    setSeedInput(String(s));
    setCenter({ cx: 0, cy: 0 });
    setSelected({ cx: 0, cy: 0 });
  }, []);

  const applySeedInput = useCallback(() => {
    const v = parseInt(seedInput, 10);
    resetWorld(Number.isFinite(v) ? v : Math.floor(Math.random() * 1e7));
  }, [seedInput, resetWorld]);

  useEffect(() => {
    const key = `${selected.cx},${selected.cy}`;
    const chunk = chunks[key];
    const canvas = detailCanvasRef.current;
    if (!canvas) return;
    canvas.width = chunkTiles * tilePxDetail;
    canvas.height = chunkTiles * tilePxDetail;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    if (!chunk) {
      ctx.fillStyle = "#0d0f10";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return;
    }
    let sampleGrid = null;
    if (viewMode === "temperature" || viewMode === "moisture") {
      sampleGrid = computeClimateGrid(chunk.cx, chunk.cy, seed, anchors, chunkTiles);
    }
    drawChunk(ctx, chunk, chunkTiles, tilePxDetail, viewMode, sampleGrid);
  }, [selected, chunks, chunkTiles, tilePxDetail, viewMode, seed, anchors]);

  const selectedChunk = chunks[`${selected.cx},${selected.cy}`];
  const chunkCount = Object.keys(chunks).length;

  // --- Backend Save/Load ---
  const loadMap = useCallback(async (targetMapId) => {
    try {
      const mRes = await fetch('/api/maps');
      const maps = await mRes.json();
      const m = maps.find(x => x.id === targetMapId || x.mapId === targetMapId);
      if (!m) return;
      
      setMapId(m.mapId || m.id);
      setSeed(m.seed);
      setSeedInput(String(m.seed));
      setChunkTiles(m.chunkTiles || 50);
      setIsFrozen(!!m.frozen);
      
      const cRes = await fetch(`/api/maps/${m.mapId || m.id}/chunks`);
      const { chunks: stored } = await cRes.json();
      
      if (stored && Object.keys(stored).length > 0) {
        // 1. Build anchors from chunks that have a target
        const loadedAnchors = [];
        for (const [key, data] of Object.entries(stored)) {
          if (data.target !== null && data.target !== undefined) {
            const biomeStr = BIOME_ID_TO_KEY[data.target];
            if (biomeStr) {
              const [cx, cy] = key.split(",").map(Number);
              loadedAnchors.push({ cx, cy, biome: biomeStr });
            }
          }
        }
        setAnchors(loadedAnchors);
        
        // 2. Fetch refreshes to replay them correctly
        const rRes = await fetch(`/api/maps/${m.mapId || m.id}/refreshes`);
        const { refreshes } = await rRes.json();
        const refreshMap = {};
        refreshes.forEach(r => { refreshMap[r.id] = { ...r, anchors: decodeAnchors(r.anchors) }; });

        // 3. Generate all chunks client-side using recipes
        const loaded = {};
        const sKeys = new Set();
        for (const [key, data] of Object.entries(stored)) {
          const [cx, cy] = key.split(",").map(Number);
          
          let chunkAnchors = loadedAnchors;
          // If chunk was part of refreshes, use the anchors from its latest refresh
          if (data.refresh_ids && data.refresh_ids.length > 0) {
            const latestId = data.refresh_ids[data.refresh_ids.length - 1];
            if (refreshMap[latestId]) {
              chunkAnchors = refreshMap[latestId].anchors;
            }
          }
          
          const world = { seed: m.seed, chunkTiles: m.chunkTiles || 50, anchors: chunkAnchors };
          // We pass an empty object for existingChunks, or loaded, since neighbor dependencies are removed/hash-based
          const chunkData = generateChunkData(cx, cy, world, loaded);
          const thumb = makeThumbnail(chunkData, m.chunkTiles || 50);
          
          const parsedTarget = data.target !== null && data.target !== undefined ? BIOME_ID_TO_KEY[data.target] : null;
          loaded[key] = { ...chunkData, thumb, generatedAt: data.generatedAt || Date.now(), paintedBiome: parsedTarget, refresh_ids: data.refresh_ids || [] };
          sKeys.add(key);
        }
        setChunks(loaded);
        setSavedKeys(sKeys);
      } else {
        setChunks({});
        setSavedKeys(new Set());
        setAnchors([]);
      }
    } catch (e) {
      console.warn("Failed to load map:", e);
    }
  }, []);

  const didInit = useRef(false);
  // Initialize maps list on mount
  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;

    (async () => {
      try {
        const res = await fetch("/api/maps");
        const maps = await res.json();
        // maps API returns { mapId, seed, chunkTiles }
        const mappedList = maps.map(m => ({ id: m.mapId || m.id, seed: m.seed }));
        setMapsList(mappedList);
        
        if (maps.length > 0) {
          // Load the most recent map
          loadMap(maps[maps.length - 1].mapId || maps[maps.length - 1].id);
        } else {
          // Create a new map
          const createRes = await fetch("/api/maps", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ seed, chunkTiles }),
          });
          const { mapId: newId } = await createRes.json();
          setMapId(newId);
          setMapsList([{ id: newId, seed }]);
        }
      } catch (e) {
        console.warn("Backend not available, running in offline mode:", e.message);
      }
    })();
  }, [loadMap]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveCell = useCallback(async () => {
    if (!mapId) return;
    if (!isFrozen) { setSaveMsg("Must Freeze to save"); setTimeout(() => setSaveMsg(""), 1500); return; }
    const key = `${selected.cx},${selected.cy}`;
    const chunk = chunks[key];
    if (!chunk || savedKeys.has(key)) return;
    try {
      setSaveMsg("Saving...");
      // Save chunk recipe (convert painted biome string to integer ID for DB optimization)
      const targetId = chunk.paintedBiome ? BIOME_KEY_TO_ID[chunk.paintedBiome] : null;
      const res = await fetch(`/api/maps/${mapId}/chunks/${key}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: targetId, refresh_ids: chunk.refresh_ids || [] }),
      });
      
      const result = await res.json();
      if (result.saved) {
        setSavedKeys((prev) => new Set([...prev, key]));
        setSaveMsg("Saved");
      }
    } catch (e) {
      setSaveMsg("Save failed");
    }
    setTimeout(() => setSaveMsg(""), 2000);
  }, [mapId, selected, chunks, savedKeys, isFrozen]);

  const saveVisible = useCallback(async () => {
    if (!mapId) return;
    if (!isFrozen) { setSaveMsg("Must Freeze to save"); setTimeout(() => setSaveMsg(""), 1500); return; }
    const toSave = {};
    const newKeys = [];
    for (const { cx, cy } of cells) {
      const key = `${cx},${cy}`;
      if (chunks[key] && !savedKeys.has(key)) {
        const targetId = chunks[key].paintedBiome ? BIOME_KEY_TO_ID[chunks[key].paintedBiome] : null;
        toSave[key] = { target: targetId, refresh_ids: chunks[key].refresh_ids || [] };
        newKeys.push(key);
      }
    }
    if (Object.keys(toSave).length === 0) { setSaveMsg("Nothing new to save"); setTimeout(() => setSaveMsg(""), 1500); return; }
    try {
      setSaveMsg("Saving...");
      const res = await fetch(`/api/maps/${mapId}/chunks-batch`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chunks: toSave }),
      });
      
      const result = await res.json();
      if (result.saved) {
        setSavedKeys((prev) => new Set([...prev, ...newKeys]));
        setSaveMsg(`Saved ${result.count} recipes`);
      }
    } catch (e) {
      setSaveMsg("Save failed");
    }
    setTimeout(() => setSaveMsg(""), 2000);
  }, [mapId, cells, chunks, savedKeys, isFrozen]);

  const saveAll = useCallback(async () => {
    if (!mapId) return;
    if (!isFrozen) { setSaveMsg("Must Freeze to save"); setTimeout(() => setSaveMsg(""), 1500); return; }
    const toSave = {};
    const newKeys = [];
    for (const key of Object.keys(chunks)) {
      if (!savedKeys.has(key)) {
        const targetId = chunks[key].paintedBiome ? BIOME_KEY_TO_ID[chunks[key].paintedBiome] : null;
        toSave[key] = { target: targetId, refresh_ids: chunks[key].refresh_ids || [] };
        newKeys.push(key);
      }
    }
    if (Object.keys(toSave).length === 0) { setSaveMsg("Nothing new to save"); setTimeout(() => setSaveMsg(""), 1500); return; }
    try {
      setSaveMsg("Saving...");
      const res = await fetch(`/api/maps/${mapId}/chunks-batch`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chunks: toSave }),
      });
      
      const result = await res.json();
      if (result.saved) {
        setSavedKeys((prev) => new Set([...prev, ...newKeys]));
        setSaveMsg(`Saved ${result.count} recipes`);
      }
    } catch (e) {
      setSaveMsg("Save failed");
    }
    setTimeout(() => setSaveMsg(""), 2000);
  }, [mapId, chunks, savedKeys, isFrozen]);

  // --- Keyboard Navigation ---
  const pan = useCallback((dx, dy) => setCenter((c) => ({ cx: c.cx + dx, cy: c.cy + dy })), []);

  useEffect(() => {
    const handler = (e) => {
      // Don't capture if user is typing in an input/select
      if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "TEXTAREA") return;
      switch (e.key) {
        case "ArrowUp": e.preventDefault(); pan(0, -1); break;
        case "ArrowDown": e.preventDefault(); pan(0, 1); break;
        case "ArrowLeft": e.preventDefault(); pan(-1, 0); break;
        case "ArrowRight": e.preventDefault(); pan(1, 0); break;
        case "z":
          if (e.ctrlKey || e.metaKey) { e.preventDefault(); performUndo(); }
          break;
        case "y":
          if (e.ctrlKey || e.metaKey) { e.preventDefault(); performRedo(); }
          break;
        default: break;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [pan, performUndo, performRedo]);

  return (
    <div style={styles.root}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=IBM+Plex+Mono:wght@400;500;600&family=Inter:wght@400;500;600&display=swap');
        * { box-sizing: border-box; }
        .ae-btn { font-family: 'Inter', sans-serif; font-size: 12px; font-weight: 600; letter-spacing: 0.02em;
          background: #22272b; color: #e7e2d3; border: 1px solid #3a4046; border-radius: 4px;
          padding: 7px 12px; cursor: pointer; transition: all 0.12s ease; }
        .ae-btn:hover { background: #2a3136; border-color: #c98a3e; }
        .ae-btn:active { transform: translateY(1px); }
        .ae-btn.primary { background: #c98a3e; color: #17181a; border-color: #c98a3e; }
        .ae-btn.primary:hover { background: #dc9c4c; }
        .ae-btn.ghost { background: transparent; }
        .ae-btn.danger:hover { background: #3a2222; border-color: #b8544a; }
        .ae-input { font-family: 'IBM Plex Mono', monospace; font-size: 12px; background: #14171a;
          color: #e7e2d3; border: 1px solid #3a4046; border-radius: 4px; padding: 6px 8px; width: 100%; }
        .ae-input:focus { outline: none; border-color: #c98a3e; }
        .ae-select { font-family: 'IBM Plex Mono', monospace; font-size: 11.5px; background: #14171a;
          color: #e7e2d3; border: 1px solid #3a4046; border-radius: 4px; padding: 6px 8px; }
        .ae-select:focus { outline: none; border-color: #c98a3e; }
        .ae-cell { position: relative; border: 1px solid #2a2f33; background: #1a1d20; cursor: pointer;
          display: flex; align-items: center; justify-content: center; transition: border-color 0.12s ease; overflow: hidden; }
        .ae-cell:hover { border-color: #c98a3e; }
        .ae-cell.selected { border-color: #c98a3e; border-width: 2px; }
        .ae-cell img { width: 100%; height: 100%; image-rendering: pixelated; display: block; }
        .ae-scroll::-webkit-scrollbar { width: 8px; height: 8px; }
        .ae-scroll::-webkit-scrollbar-track { background: #1a1d20; }
        .ae-scroll::-webkit-scrollbar-thumb { background: #3a4046; border-radius: 4px; }
      `}</style>

      {/* Header */}
      <div style={styles.header}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <span style={styles.wordmark}>ATLAS ENGINE</span>
          <span style={styles.wordmarkSub}>chunk-based world survey · relief + biome painting</span>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span style={styles.label}>WORLD</span>
          <select 
            className="ae-select" 
            style={{ width: 140 }}
            value={mapId || ""}
            onChange={(e) => {
              if (e.target.value === "new") {
                resetWorld();
                setMapId(null);
                setSaveMsg("Unsaved New Map");
              } else {
                loadMap(e.target.value);
              }
            }}
          >
            <option value="new">+ New World...</option>
            {mapsList.map((m, i) => (
              <option key={m.id || i} value={m.id}>{m.id?.slice(0,8)} (s: {m.seed})</option>
            ))}
          </select>
          <div style={{ width: 1, height: 20, background: "#3a4046", margin: "0 4px" }} />
          <span style={styles.label}>SEED</span>
          <input
            className="ae-input"
            style={{ width: 110 }}
            value={seedInput}
            onChange={(e) => setSeedInput(e.target.value.replace(/[^0-9-]/g, ""))}
            onKeyDown={(e) => e.key === "Enter" && applySeedInput()}
          />
          <button className="ae-btn" onClick={applySeedInput}>Apply</button>
          <button className="ae-btn" onClick={() => resetWorld()}>🎲 New</button>
          <div style={{ width: 1, height: 20, background: "#3a4046", margin: "0 4px" }} />
          <span style={styles.label}>CHUNK</span>
          <select
            className="ae-input"
            style={{ width: 90 }}
            value={chunkTiles}
            onChange={(e) => { setChunkTiles(Number(e.target.value)); resetWorld(seed); }}
          >
            <option value={24}>24×24 tiles</option>
            <option value={32}>32×32 tiles</option>
            <option value={40}>40×40 tiles</option>
            <option value={50}>50×50 tiles</option>
          </select>
          <div style={{ width: 1, height: 20, background: "#3a4046", margin: "0 4px" }} />
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#e7e2d3', fontSize: 12, fontFamily: 'Inter, sans-serif' }}>
            <input 
              type="checkbox" 
              checked={isFrozen} 
              onChange={async (e) => {
                const frozenState = e.target.checked;
                setIsFrozen(frozenState);
                if (mapId) {
                  try {
                    await fetch(`/api/maps/${mapId}/frozen`, {
                      method: "PUT",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ frozen: frozenState }),
                    });
                    if (frozenState) {
                      loadMap(mapId);
                    }
                  } catch (err) {
                    console.warn("Failed to save frozen state");
                  }
                }
              }} 
            />
            Freeze
          </label>
        </div>
      </div>

      <div style={styles.body}>
        {/* Left: chart / minimap */}
        <div style={styles.panel}>
          <div style={styles.panelHeader}>
            <span>SURVEY CHART</span>
            <button 
              className="ae-btn" 
              style={{ padding: "2px 8px", fontSize: 11, marginLeft: "auto", marginRight: 8, height: 20 }} 
              onClick={saveAll} 
              disabled={!mapId}
            >
              Save All
            </button>
            <span style={styles.coordReadout}>center ({center.cx}, {center.cy})</span>
          </div>

          <div style={styles.paintRow}>
            <span
              style={{
                ...styles.paintSwatch,
                background: paintBiome === "NATURAL" ? "transparent" : BIOME_DEFS[B[paintBiome]].color,
                border: paintBiome === "NATURAL" ? "1px dashed #4a5056" : "1px solid rgba(255,255,255,0.2)",
              }}
            />
            <select className="ae-select" style={{ flex: 1 }} value={paintBiome} onChange={(e) => setPaintBiome(e.target.value)}>
              <option value="NATURAL">Natural (no target)</option>
              {PAINTABLE_GROUPS.map(([group, keys]) => (
                <optgroup key={group} label={group}>
                  {keys.map((k) => <option key={k} value={k}>{BIOME_DEFS[B[k]].name}</option>)}
                </optgroup>
              ))}
            </select>
          </div>
          <div style={styles.paintHint}>
            Generating a chunk with a target selected recenters that area's climate toward it — expect a
            blended mix (sea, cliff, land, etc.), never a solid block.
          </div>

          <div style={styles.chartWrap}>
            <div style={styles.panDial}>
              <button className="ae-btn ghost" style={styles.panBtnN} onClick={() => pan(0, -1)}>▲</button>
              <button className="ae-btn ghost" style={styles.panBtnW} onClick={() => pan(-1, 0)}>◀</button>
              <button className="ae-btn ghost" style={styles.panBtnCenter} onClick={() => setCenter({ cx: 0, cy: 0 })} title="Recenter to origin">◎</button>
              <button className="ae-btn ghost" style={styles.panBtnE} onClick={() => pan(1, 0)}>▶</button>
              <button className="ae-btn ghost" style={styles.panBtnS} onClick={() => pan(0, 1)}>▼</button>
            </div>

            <div style={styles.grid}>
              {cells.map(({ cx, cy }) => {
                const key = `${cx},${cy}`;
                const chunk = chunks[key];
                const isSel = selected.cx === cx && selected.cy === cy;
                return (
                  <div
                    key={key}
                    className={`ae-cell${isSel ? " selected" : ""}`}
                    onClick={() => (chunk ? setSelected({ cx, cy }) : generateChunk(cx, cy, paintBiome))}
                    title={chunk ? `(${cx}, ${cy}) — ${chunk.stats.dominantBiome}${chunk.paintedBiome ? ` (painted: ${BIOME_DEFS[B[chunk.paintedBiome]].name})` : ""}` : `(${cx}, ${cy}) — click to generate`}
                  >
                    {chunk ? (
                      <img src={chunk.thumb} alt="" />
                    ) : (
                      <span style={styles.cellPlus}>+</span>
                    )}
                    <span style={styles.cellCoord}>{cx},{cy}</span>
                    {chunk && (chunk.stats.riverTiles > 0 || chunk.stats.lakeTiles > 0) && (
                      <span style={styles.cellWaterDot} title="contains fresh water" />
                    )}
                    {chunk && chunk.paintedBiome && (
                      <span style={{ ...styles.cellPaintDot, background: BIOME_DEFS[B[chunk.paintedBiome]].color }} title="hand-painted chunk" />
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div style={{ display: "flex", gap: 6, marginTop: 12, flexWrap: "wrap" }}>
            <button className="ae-btn primary" style={{ flex: 1 }} onClick={generateAllVisible}>
              Generate visible
            </button>
            <button className="ae-btn primary" style={{ flex: 1 }} onClick={refreshVisible}>
              Refresh visible
            </button>
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
            <button className="ae-btn" style={{ flex: 1 }} onClick={saveVisible} disabled={!mapId}>
              Save visible
            </button>
            <button className="ae-btn" style={{ flex: 1 }} onClick={performUndo} disabled={undoStack.length === 0} title="Undo (Ctrl+Z)">
              ↩ Undo
            </button>
            <button className="ae-btn" style={{ flex: 1 }} onClick={performRedo} disabled={redoStack.length === 0} title="Redo (Ctrl+Y)">
              ↪ Redo
            </button>
          </div>
          {saveMsg && <div style={{ ...styles.label, color: "#c98a3e", marginTop: 6 }}>{saveMsg}</div>}
          <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
            <button className="ae-btn" onClick={() => setShowLegend((v) => !v)}>
              {showLegend ? "Hide legend" : "Biome legend"}
            </button>
          </div>

          {showLegend && (
            <div style={styles.modalOverlay} onClick={() => setShowLegend(false)}>
              <div style={styles.modalContent} onClick={(e) => e.stopPropagation()}>
                <div style={styles.modalHeader}>
                  <h3 style={{ margin: 0, fontSize: 14 }}>BIOME LEGEND</h3>
                  <button className="ae-btn" style={{ padding: "4px 10px" }} onClick={() => setShowLegend(false)}>Close</button>
                </div>
                <div style={styles.legendGrid} className="ae-scroll">
                  {BIOME_DEFS.map((b) => (
                    <div key={b.key} style={styles.legendRow}>
                      <span style={{ ...styles.legendSwatch, background: b.color }} />
                      <span>{b.name}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          <div style={styles.footnote}>
            Rule 1. Generate 3 Neutral layer from existing chunks, before intended biome generation.<br/> Rule 2. If a empty box has 2 neighbour chunks, only neutral target be generated there, then rule 1
          </div>
          <div style={styles.footnote}>
            {chunkCount} chunk{chunkCount === 1 ? "" : "s"} generated · seed {seed} · {anchors.length} biome anchor{anchors.length === 1 ? "" : "s"}
            {mapId && <> · map {mapId.slice(0, 8)}</>}
            {undoStack.length > 0 && <> · {undoStack.length} undo</>}
          </div>
        </div>

        {/* Right: detail viewport + stats */}
        <div style={styles.panel}>
          <div style={styles.panelHeader}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span>CHUNK DETAIL — ({selected.cx}, {selected.cy})</span>
              <button className="ae-btn" onClick={refreshSelected} style={{ padding: "4px 8px" }} disabled={!selectedChunk}>
                Refresh
              </button>
              {selectedChunk && (
                <button
                  className="ae-btn primary"
                  onClick={saveCell}
                  style={{ padding: "4px 8px" }}
                  disabled={!mapId || savedKeys.has(`${selected.cx},${selected.cy}`)}
                >
                  {savedKeys.has(`${selected.cx},${selected.cy}`) ? "✓ Saved" : "💾 Save cell"}
                </button>
              )}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={styles.label}>VIEW</span>
              <select className="ae-select" value={viewMode} onChange={(e) => setViewMode(e.target.value)}>
                <option value="terrain">Terrain (relief)</option>
                <option value="elevation">Elevation</option>
                <option value="temperature">Temperature</option>
                <option value="moisture">Moisture</option>
              </select>
              <span style={styles.label}>ZOOM</span>
              <input
                type="range" min={6} max={16} value={tilePxDetail}
                onChange={(e) => setTilePxDetail(Number(e.target.value))}
                style={{ width: 80 }}
              />
              {selectedChunk && (
                <button className="ae-btn danger" onClick={() => clearChunk(selected.cx, selected.cy)} title="Delete this chunk so it can be regenerated">
                  🗑
                </button>
              )}
            </div>
          </div>

          <div style={styles.detailRow}>
            <div style={styles.canvasWrap} className="ae-scroll">
              {selectedChunk ? (
                <canvas ref={detailCanvasRef} style={{ imageRendering: "pixelated", display: "block" }} />
              ) : (
                <div style={styles.emptyState}>
                  <div style={{ fontSize: 28, marginBottom: 8 }}>⛭</div>
                  <div>Chunk ({selected.cx}, {selected.cy}) hasn't been surveyed yet.</div>
                  <button className="ae-btn primary" style={{ marginTop: 12 }} onClick={() => generateChunk(selected.cx, selected.cy, paintBiome)}>
                    Generate this chunk
                  </button>
                </div>
              )}
            </div>

            {selectedChunk && (
              <div style={styles.statsColumn}>
                <Stat label="Dominant biome" value={selectedChunk.stats.dominantBiome} />
                <Stat label="Painted target" value={selectedChunk.paintedBiome ? BIOME_DEFS[B[selectedChunk.paintedBiome]].name : "— natural —"} />
                <Stat label="Elevation range" value={`${selectedChunk.stats.elevMin} → ${selectedChunk.stats.elevMax}`} />
                <Stat label="Peak height" value={`${elevToMeters(selectedChunk.stats.elevMax)} m`} />
                <Stat label="River / lake tiles" value={`${selectedChunk.stats.riverTiles} / ${selectedChunk.stats.lakeTiles}`} />
                <Stat label="Objects placed" value={selectedChunk.stats.objectCount} />
                <Stat label="Status" value={savedKeys.has(`${selected.cx},${selected.cy}`) ? "✓ Saved" : "Unsaved"} />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div style={styles.statCard}>
      <div style={styles.statLabel}>{label}</div>
      <div style={styles.statValue}>{value}</div>
    </div>
  );
}

/* ============================================================
   7. STYLES
   ============================================================ */

const styles = {
  root: {
    height: "100vh", width: "100vw", background: "#14171a", color: "#e7e2d3",
    fontFamily: "'Inter', sans-serif", padding: "8px 12px", display: "flex", flexDirection: "column",
    overflow: "hidden",
  },
  header: {
    display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10,
    paddingBottom: 8, borderBottom: "1px solid #2a2f33", flexShrink: 0,
  },
  wordmark: {
    fontFamily: "'Fraunces', serif", fontWeight: 600, fontSize: 22, letterSpacing: "0.02em", color: "#e7e2d3",
  },
  wordmarkSub: {
    fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: "#8a9099", letterSpacing: "0.03em",
  },
  label: {
    fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: "#8a9099", letterSpacing: "0.05em",
  },
  body: {
    display: "grid", gridTemplateColumns: "minmax(300px, 380px) 1fr", gap: 10,
    flex: 1, overflow: "hidden", marginTop: 8,
  },
  panel: {
    background: "#1a1d20", border: "1px solid #2a2f33", borderRadius: 6, padding: 12,
    overflow: "auto", display: "flex", flexDirection: "column",
  },
  panelHeader: {
    display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10,
    fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, letterSpacing: "0.06em", color: "#c98a3e",
    flexShrink: 0, flexWrap: "wrap", gap: 6,
  },
  coordReadout: { color: "#8a9099" },
  paintRow: { display: "flex", alignItems: "center", gap: 8, marginBottom: 6 },
  paintSwatch: { width: 16, height: 16, borderRadius: 3, flexShrink: 0 },
  paintHint: {
    fontSize: 10.5, lineHeight: 1.4, color: "#6b7178", fontFamily: "'IBM Plex Mono', monospace",
    marginBottom: 10,
  },
  chartWrap: { position: "relative" },
  panDial: {
    position: "absolute", top: -6, right: -6, display: "grid",
    gridTemplateColumns: "24px 24px 24px", gridTemplateRows: "20px 20px 20px", zIndex: 2, gap: 1,
  },
  panBtnN: { gridColumn: 2, gridRow: 1, padding: 0, fontSize: 10, lineHeight: "18px" },
  panBtnW: { gridColumn: 1, gridRow: 2, padding: 0, fontSize: 10, lineHeight: "18px" },
  panBtnCenter: { gridColumn: 2, gridRow: 2, padding: 0, fontSize: 10, lineHeight: "18px" },
  panBtnE: { gridColumn: 3, gridRow: 2, padding: 0, fontSize: 10, lineHeight: "18px" },
  panBtnS: { gridColumn: 2, gridRow: 3, padding: 0, fontSize: 10, lineHeight: "18px" },
  grid: {
    display: "grid", gridTemplateColumns: `repeat(${GRID_COLS}, 1fr)`, gridTemplateRows: `repeat(${GRID_ROWS}, 1fr)`,
    gap: 3, aspectRatio: `${GRID_COLS} / ${GRID_ROWS}`, width: "100%",
  },
  cellPlus: { color: "#4a5056", fontSize: 16, fontFamily: "'IBM Plex Mono', monospace" },
  cellCoord: {
    position: "absolute", bottom: 2, left: 3, fontSize: 8, fontFamily: "'IBM Plex Mono', monospace",
    color: "rgba(255,255,255,0.55)", textShadow: "0 1px 1px rgba(0,0,0,0.8)", pointerEvents: "none",
  },
  cellWaterDot: {
    position: "absolute", top: 3, right: 3, width: 5, height: 5, borderRadius: "50%",
    background: "#4fb0e0", boxShadow: "0 0 3px rgba(0,0,0,0.6)",
  },
  cellPaintDot: {
    position: "absolute", top: 3, left: 3, width: 6, height: 6, borderRadius: "50%",
    border: "1px solid rgba(255,255,255,0.7)", boxShadow: "0 0 3px rgba(0,0,0,0.6)",
  },
  legendGrid: {
    padding: "16px", overflowY: "auto", display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: "8px 12px",
  },
  modalOverlay: {
    position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
    background: "rgba(0, 0, 0, 0.7)", zIndex: 1000,
    display: "flex", alignItems: "center", justifyContent: "center",
  },
  modalContent: {
    background: "#1a1d20", border: "1px solid #2a2f33", borderRadius: 8,
    width: "80%", maxWidth: 600, maxHeight: "80vh", display: "flex", flexDirection: "column",
    boxShadow: "0 10px 30px rgba(0,0,0,0.5)",
  },
  modalHeader: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    padding: "12px 16px", borderBottom: "1px solid #2a2f33",
    fontFamily: "'IBM Plex Mono', monospace", color: "#c98a3e",
  },
  legendRow: { display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#c7c2b3" },
  legendSwatch: { width: 10, height: 10, borderRadius: 2, flexShrink: 0, border: "1px solid rgba(255,255,255,0.15)" },
  footnote: {
    marginTop: 10, fontSize: 10.5, lineHeight: 1.5, color: "#6b7178",
    fontFamily: "'IBM Plex Mono', monospace", borderTop: "1px solid #2a2f33", paddingTop: 8,
  },
  detailRow: {
    display: "flex", gap: 12, flex: 1, minHeight: 0,
  },
  canvasWrap: {
    background: "#0d0f10", border: "1px solid #2a2f33", borderRadius: 4, minHeight: 300,
    overflow: "auto", display: "flex", alignItems: "center", justifyContent: "center", padding: 8,
    flex: 1,
  },
  statsColumn: {
    display: "flex", flexDirection: "column", gap: 8, width: 180, flexShrink: 0,
  },
  emptyState: {
    display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
    color: "#6b7178", fontSize: 13, textAlign: "center", padding: 30, fontFamily: "'IBM Plex Mono', monospace",
  },
  statCard: {
    background: "#14171a", border: "1px solid #2a2f33", borderRadius: 4, padding: "8px 10px",
  },
  statLabel: {
    fontSize: 9.5, color: "#8a9099", fontFamily: "'IBM Plex Mono', monospace", letterSpacing: "0.05em", marginBottom: 3,
  },
  statValue: { fontSize: 13, color: "#e7e2d3", fontWeight: 600 },
};