/**
 * MAP VIEWER — continuous world exploration view
 * ------------------------------------------------
 * Loads saved chunks from the backend and renders them seamlessly.
 * Arrow keys to navigate. If a chunk doesn't exist on the server,
 * it is auto-generated with Natural (no target) biome.
 *
 * Uses the same generation logic from WorldGen.jsx (imported functions).
 */
import React, { useState, useEffect, useMemo, useRef } from "react";
import { Link, useLocation } from "react-router-dom";
import { io } from "socket.io-client";
import { drawChunk, generateChunkData, decodeAnchors, BIOME_ID_TO_KEY } from "./WorldGen";

// Increase tile size for a closer, "gameplay" view
const TILE_PX = 64; 

export default function MapViewer() {
  const location = useLocation();
  const userName = new URLSearchParams(location.search).get("user");

  const [mapId, setMapId] = useState(null);
  const [mapMeta, setMapMeta] = useState(null);
  
  // Player coordinates in tiles (not chunks)
  const [player, setPlayer] = useState({ x: 0, y: 0 });
  const [chunks, setChunks] = useState({}); // key -> chunk data
  const [loading, setLoading] = useState(true);
  const [windowSize, setWindowSize] = useState({ w: window.innerWidth, h: window.innerHeight });

  const [otherPlayers, setOtherPlayers] = useState({});
  const socketRef = useRef(null);

  // Initialize Socket.IO connection
  useEffect(() => {
    if (!userName) return;
    const socket = io("http://localhost:3001");
    socketRef.current = socket;
    
    socket.emit("join", userName);
    
    socket.on("playerMoved", (data) => {
      setOtherPlayers((prev) => ({
        ...prev,
        [data.name]: { x: data.x, y: data.y }
      }));
    });

    socket.on("playerLeft", (name) => {
      setOtherPlayers((prev) => {
        const newPlayers = { ...prev };
        delete newPlayers[name];
        return newPlayers;
      });
    });

    socket.on("mapMetaChanged", async (data) => {
      setMapMeta((prev) => {
        if (!prev) return prev;
        if (prev.mapId === data.mapId || prev.id === data.mapId) {
          return { ...prev, frozen: data.frozen };
        }
        return prev;
      });

      // When freeze state changes (e.g., Atlas Engine publishes an update), 
      // clear tracking and recipes to trigger the lazy-loader to fetch the latest state!
      if (queriedKeys.current) queriedKeys.current.clear();
      if (queriedRefreshIds.current) queriedRefreshIds.current.clear();
      setRecipes({});
    });

    return () => socket.disconnect();
  }, [userName]);

  // Track which chunk keys and refresh IDs we've already queried from the server to avoid re-fetching
  const queriedKeys = useRef(new Set());
  const queriedRefreshIds = useRef(new Set());

  const worldWrapRef = useRef(null);
  const [viewportSize, setViewportSize] = useState({ w: window.innerWidth, h: window.innerHeight - 40 }); // Fallback guess

  useEffect(() => {
    if (loading || !worldWrapRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (let entry of entries) {
        setViewportSize({ w: entry.contentRect.width, h: entry.contentRect.height });
      }
    });
    observer.observe(worldWrapRef.current);
    
    // Set initial size
    const rect = worldWrapRef.current.getBoundingClientRect();
    if (rect.width > 0) {
      setViewportSize({ w: rect.width, h: rect.height });
    }

    return () => observer.disconnect();
  }, [loading]);

  // Store the lightweight backend data
  const [recipes, setRecipes] = useState({});
  const [refreshesMap, setRefreshesMap] = useState({});

  const chunkTiles = mapMeta?.chunkTiles || 50;
  const CELL_SIZE = chunkTiles * TILE_PX;

  // Calculate true map bounds by expanding until we hit a confirmed empty chunk
  const worldBounds = useMemo(() => {
    const ct = mapMeta?.chunkTiles || 50;
    const playerCx = Math.floor(player.x / ct);
    const playerCy = Math.floor(player.y / ct);
    
    // If the player's current chunk is empty, we don't have bounds to clamp to
    if (recipes[`${playerCx},${playerCy}`]?.empty) return null;

    let minCx = playerCx;
    let maxCx = playerCx;
    let minCy = playerCy;
    let maxCy = playerCy;

    let foundLeft = false;
    let cx = playerCx;
    while (recipes[`${cx},${playerCy}`]) {
      if (recipes[`${cx},${playerCy}`].empty) { foundLeft = true; break; }
      minCx = cx;
      cx--;
    }
    if (!foundLeft) minCx = -Infinity;

    let foundRight = false;
    cx = playerCx;
    while (recipes[`${cx},${playerCy}`]) {
      if (recipes[`${cx},${playerCy}`].empty) { foundRight = true; break; }
      maxCx = cx;
      cx++;
    }
    if (!foundRight) maxCx = Infinity;

    let foundTop = false;
    let cy = playerCy;
    while (recipes[`${playerCx},${cy}`]) {
      if (recipes[`${playerCx},${cy}`].empty) { foundTop = true; break; }
      minCy = cy;
      cy--;
    }
    if (!foundTop) minCy = -Infinity;

    let foundBottom = false;
    cy = playerCy;
    while (recipes[`${playerCx},${cy}`]) {
      if (recipes[`${playerCx},${cy}`].empty) { foundBottom = true; break; }
      maxCy = cy;
      cy++;
    }
    if (!foundBottom) maxCy = Infinity;

    return { minCx, maxCx, minCy, maxCy };
  }, [player.x, player.y, recipes, mapMeta]);

  const playerPixelX = player.x * TILE_PX + TILE_PX / 2;
  const playerPixelY = player.y * TILE_PX + TILE_PX / 2;

  // Calculate ideal camera position (center on player, clamp to world bounds)
  // Calculate ideal camera position (center on player, clamp to world bounds)
  const cameraPos = useMemo(() => {
    let camX = playerPixelX;
    let camY = playerPixelY;

    if (worldBounds) {
      const minPixelX = worldBounds.minCx * CELL_SIZE;
      const maxPixelX = (worldBounds.maxCx + 1) * CELL_SIZE;
      const minPixelY = worldBounds.minCy * CELL_SIZE;
      const maxPixelY = (worldBounds.maxCy + 1) * CELL_SIZE;

      const minCamX = minPixelX + viewportSize.w / 2;
      const maxCamX = maxPixelX - viewportSize.w / 2;
      
      if (minCamX > maxCamX) {
        camX = (minPixelX + maxPixelX) / 2;
      } else {
        camX = Math.max(minCamX, Math.min(maxCamX, camX));
      }
      
      const minCamY = minPixelY + viewportSize.h / 2;
      const maxCamY = maxPixelY - viewportSize.h / 2;
      
      if (minCamY > maxCamY) {
        camY = (minPixelY + maxPixelY) / 2;
      } else {
        camY = Math.max(minCamY, Math.min(maxCamY, camY));
      }
    }

    return { x: camX, y: camY };
  }, [player, worldBounds, CELL_SIZE, viewportSize, mapMeta]);

  // Calculate which chunks are visible based on camera position and window size
  const cells = useMemo(() => {
    const px = cameraPos.x;
    const py = cameraPos.y;
    
    const minCx = Math.floor((px - viewportSize.w / 2) / CELL_SIZE) - 2;
    const maxCx = Math.floor((px + viewportSize.w / 2) / CELL_SIZE) + 2;
    const minCy = Math.floor((py - viewportSize.h / 2) / CELL_SIZE) - 2;
    const maxCy = Math.floor((py + viewportSize.h / 2) / CELL_SIZE) + 2;

    const out = [];
    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        out.push({ cx, cy });
      }
    }
    return out;
  }, [cameraPos, viewportSize, CELL_SIZE]);

  // Subscribe to visible chunks
  useEffect(() => {
    if (socketRef.current && cells.length > 0) {
      socketRef.current.emit("subscribeChunks", cells.map(c => `${c.cx},${c.cy}`));
    }
  }, [cells]);

  const didInitMap = useRef(false);
  // Load user & map metadata and all recipes on mount
  useEffect(() => {
    if (didInitMap.current) return;
    didInitMap.current = true;

    (async () => {
      try {
        let currentMapId = null;

        if (userName) {
          const userRes = await fetch(`/api/users/${encodeURIComponent(userName)}`);
          if (userRes.ok) {
            const user = await userRes.json();
            // Sanitize legacy saved positions that might be exactly on the tile boundaries
            let startX = user.player_px || 0;
            let startY = user.player_py || 0;
            
            // If they are exactly on the .5 boundary at the end of a chunk, nudge them back inside
            const ct = 50; // default chunkTiles
            if (startX % ct === ct - 0.5) startX -= 0.5;
            if (startY % ct === ct - 0.5) startY -= 0.5;
            
            setPlayer({ x: startX, y: startY });
            currentMapId = user.map_id;
          }
        }

        if (!currentMapId) {
          const res = await fetch("/api/maps");
          const maps = await res.json();
          if (maps.length > 0) {
            currentMapId = maps[maps.length - 1].mapId || maps[maps.length - 1].id;
          } else {
            // Auto-create a new map!
            const seed = Math.floor(Math.random() * 1e7);
            const createRes = await fetch("/api/maps", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ seed, chunkTiles: 50 }),
            });
            const newMap = await createRes.json();
            currentMapId = newMap.mapId;
          }
        }

        if (currentMapId) {
          const metaRes = await fetch(`/api/maps/${currentMapId}`);
          const meta = await metaRes.json();
          setMapId(meta.mapId || meta.id);
          setMapMeta(meta);

          // Don't fetch all refreshes or chunks on mount!
          // They are fetched lazily as the player walks near chunk edges.
        }
      } catch (e) {
        console.warn("Backend not available:", e.message);
      }
      setLoading(false);
    })();
  }, [userName]);

  // Which chunks should be generated/loaded in memory?
  // We only load the current chunk + neighbors if we are close to the edge.
  const chunksToLoad = useMemo(() => {
    if (!mapMeta) return [];
    const ct = mapMeta.chunkTiles || 50;
    const cx = Math.floor(player.x / ct);
    const cy = Math.floor(player.y / ct);
    
    // Player's local tile within the chunk
    let lx = player.x % ct;
    if (lx < 0) lx += ct;
    let ly = player.y % ct;
    if (ly < 0) ly += ct;

    const EDGE = 15; // Generate next chunk earlier (within 15 tiles) to avoid black flashes
    const needed = new Set([`${cx},${cy}`]);

    if (lx < EDGE) needed.add(`${cx-1},${cy}`);
    else if (lx > ct - EDGE) needed.add(`${cx+1},${cy}`);

    if (ly < EDGE) needed.add(`${cx},${cy-1}`);
    else if (ly > ct - EDGE) needed.add(`${cx},${cy+1}`);

    // Corners
    if (lx < EDGE && ly < EDGE) needed.add(`${cx-1},${cy-1}`);
    else if (lx > ct - EDGE && ly < EDGE) needed.add(`${cx+1},${cy-1}`);
    else if (lx < EDGE && ly > ct - EDGE) needed.add(`${cx-1},${cy+1}`);
    else if (lx > ct - EDGE && ly > ct - EDGE) needed.add(`${cx+1},${cy+1}`);

    return Array.from(needed);
  }, [player.x, player.y, mapMeta]);

  // Track which chunk keys and refresh IDs we've already queried from the server to avoid re-fetching
  // (Moved to top level)

  // Lazy load chunk recipes ONLY for chunks the player is about to enter (chunksToLoad)
  useEffect(() => {
    if (!mapId || chunksToLoad.length === 0) return;

    // Find which of the needed chunks we haven't fetched from the server yet
    const toFetch = chunksToLoad.filter(key => !recipes[key] && !queriedKeys.current.has(key));
    if (toFetch.length === 0) return;

    // Mark them as queried immediately to prevent duplicate requests
    toFetch.forEach(key => queriedKeys.current.add(key));

    const fetchNearby = async () => {
      try {
        const res = await fetch(`/api/maps/${mapId}/chunks-fetch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ keys: toFetch })
        });
        const { chunks: fetched } = await res.json();
        
        // Collect any refresh IDs we need to fetch
        const neededRefreshIds = new Set();
        for (const data of Object.values(fetched)) {
          if (data.refresh_ids) data.refresh_ids.forEach(rid => {
            if (!queriedRefreshIds.current.has(rid)) {
              neededRefreshIds.add(rid);
              queriedRefreshIds.current.add(rid); // mark immediately
            }
          });
        }

        // Fetch only the missing refresh IDs
        if (neededRefreshIds.size > 0) {
          try {
            const rRes = await fetch('/api/refreshes-fetch', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ids: Array.from(neededRefreshIds) })
            });
            const { refreshes } = await rRes.json();
            if (refreshes && refreshes.length > 0) {
              const newRefreshes = {};
              refreshes.forEach(r => { newRefreshes[r.id] = { ...r, anchors: decodeAnchors(r.anchors) }; });
              setRefreshesMap(prev => ({ ...prev, ...newRefreshes }));
            }
          } catch (e) {
            console.warn("Failed to fetch refresh data", e);
          }
        }

        setRecipes(prev => {
          const newRecipes = {};
          for (const [key, data] of Object.entries(fetched)) {
            const parsedTarget = data.target !== null && data.target !== undefined ? BIOME_ID_TO_KEY[data.target] : null;
            newRecipes[key] = { ...data, target: parsedTarget };
          }
          // Mark requested chunks that didn't come back as empty so we know the fetch resolved
          toFetch.forEach(key => {
            if (!newRecipes[key] && !prev[key]) {
              newRecipes[key] = { empty: true };
            }
          });
          return { ...prev, ...newRecipes };
        });
      } catch(e) {
        console.warn("Failed to fetch nearby chunks", e);
      }
    };
    fetchNearby();
  }, [mapId, chunksToLoad]);

  // Build the global anchors from the recipes
  const globalAnchors = useMemo(() => {
    const anchors = [];
    for (const [key, data] of Object.entries(recipes)) {
      if (data.target) {
        const [cx, cy] = key.split(",").map(Number);
        anchors.push({ cx, cy, biome: data.target });
      }
    }
    return anchors;
  }, [recipes]);

  // Lazy Generate / Save missing chunks
  useEffect(() => {
    if (!mapId || !mapMeta) return;
    
    const generateNewChunks = async () => {
      let madeChanges = false;
      const nextChunks = { ...chunks };
      const nextRecipes = { ...recipes };

      for (const key of chunksToLoad) {
        if (!nextChunks[key]) {
          const recipe = nextRecipes[key];
          
          // If the recipe is entirely undefined, we are still waiting for the chunks-fetch API to return!
          if (!recipe) continue; 
          
          const [cx, cy] = key.split(",").map(Number);
          
          // If map is frozen and chunk doesn't exist on server, we normally skip generation.
          // HOWEVER, if this missing chunk forms an "inner corner" (bounded by at least 2 adjacent sides),
          // we generate it anyway to prevent players from snagging on diagonal map edges.
          if (mapMeta.frozen && recipe.empty) {
            const hasTop = nextRecipes[`${cx},${cy - 1}`] && !nextRecipes[`${cx},${cy - 1}`].empty;
            const hasBottom = nextRecipes[`${cx},${cy + 1}`] && !nextRecipes[`${cx},${cy + 1}`].empty;
            const hasLeft = nextRecipes[`${cx - 1},${cy}`] && !nextRecipes[`${cx - 1},${cy}`].empty;
            const hasRight = nextRecipes[`${cx + 1},${cy}`] && !nextRecipes[`${cx + 1},${cy}`].empty;
            
            const isInnerCorner = 
              (hasTop && hasLeft) || 
              (hasTop && hasRight) || 
              (hasBottom && hasLeft) || 
              (hasBottom && hasRight);

            if (!isInnerCorner) {
              continue;
            }
          }

          let chunkAnchors = globalAnchors;
          if (recipe && recipe.refresh_ids && recipe.refresh_ids.length > 0) {
            const latestId = recipe.refresh_ids[recipe.refresh_ids.length - 1];
            if (refreshesMap[latestId]) {
              chunkAnchors = refreshesMap[latestId].anchors;
            }
          }

          const world = { seed: mapMeta.seed, chunkTiles: mapMeta.chunkTiles || 50, anchors: chunkAnchors };
          const data = generateChunkData(cx, cy, world, nextChunks);
          
          if (!recipe.empty) {
            data.paintedBiome = recipe.target;
            data.generatedAt = Date.now();
          } else {
            // New chunk! It was not found on the server.
            data.paintedBiome = null;
            data.generatedAt = Date.now();
            nextRecipes[key] = { target: null, refresh_ids: [] }; // convert empty to active recipe
            // Save to backend asynchronously
            fetch(`/api/maps/${mapId}/chunks/${key}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ target: null, refresh_ids: [] }),
            }).catch(() => {});
          }
          
          nextChunks[key] = data;
          madeChanges = true;
        }
      }

      if (madeChanges) {
        setChunks(nextChunks);
        setRecipes(nextRecipes);
      }
    };
    
    generateNewChunks();
  }, [chunksToLoad, mapId, mapMeta, globalAnchors, refreshesMap]); // eslint-disable-line react-hooks/exhaustive-deps

  const chunksRef = useRef(chunks);
  const mapMetaRef = useRef(mapMeta);

  useEffect(() => {
    chunksRef.current = chunks;
    mapMetaRef.current = mapMeta;
  }, [chunks, mapMeta]);

  // Keyboard navigation (moves the player)
  useEffect(() => {
    const handler = (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
      
      const tryMove = (dx, dy) => {
        setPlayer((p) => {
          const nx = p.x + dx;
          const ny = p.y + dy;
          
          const meta = mapMetaRef.current;
          const currentChunks = chunksRef.current;

          if (meta) {
            const ct = meta.chunkTiles || 50;
            const cellSize = ct * TILE_PX;

            // Calculate exact pixel position of the player's center for the NEXT frame
            const playerPixelX = nx * TILE_PX + TILE_PX / 2;
            const playerPixelY = ny * TILE_PX + TILE_PX / 2;

            // Define the 4 corners of the player's physical bounding box (player is 32x32 px)
            // We use 15px radius instead of 16px to give a tiny 1px margin of forgiveness
            const leftEdge = playerPixelX - 15;
            const rightEdge = playerPixelX + 15;
            const topEdge = playerPixelY - 15;
            const bottomEdge = playerPixelY + 15;

            // Convert physical pixel edges into absolute chunk coordinates
            const leftCx = Math.floor(leftEdge / cellSize);
            const rightCx = Math.floor(rightEdge / cellSize);
            const topCy = Math.floor(topEdge / cellSize);
            const bottomCy = Math.floor(bottomEdge / cellSize);

            // If ANY corner of the player's body touches a chunk that doesn't exist yet, BLOCK movement!
            if (
              !currentChunks[`${leftCx},${topCy}`] ||
              !currentChunks[`${rightCx},${topCy}`] ||
              !currentChunks[`${leftCx},${bottomCy}`] ||
              !currentChunks[`${rightCx},${bottomCy}`]
            ) {
              return p; // Block movement
            }
          }
          
          return { x: nx, y: ny };
        });
      };

      switch (e.key) {
        case "ArrowUp": e.preventDefault(); tryMove(0, -0.5); break;
        case "ArrowDown": e.preventDefault(); tryMove(0, 0.5); break;
        case "ArrowLeft": e.preventDefault(); tryMove(-0.5, 0); break;
        case "ArrowRight": e.preventDefault(); tryMove(0.5, 0); break;
        default: break;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Save and stream player position
  useEffect(() => {
    if (!userName) return;

    // 1. Instantly stream position via WebSockets
    if (socketRef.current) {
      const cx = Math.floor(player.x / chunkTiles);
      const cy = Math.floor(player.y / chunkTiles);
      socketRef.current.emit("move", {
        x: player.x,
        y: player.y,
        chunkKey: `${cx},${cy}`
      });
    }

    // 2. Debounced save to Database
    const timeout = setTimeout(() => {
      fetch(`/api/users/${encodeURIComponent(userName)}/position`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ x: player.x, y: player.y }),
      }).catch((err) => console.error("Failed to save position", err));
    }, 500);

    return () => clearTimeout(timeout);
  }, [player, userName]);

  if (loading) {
    return (
      <div style={viewerStyles.root}>
        <div style={viewerStyles.loadingText}>Loading map data...</div>
      </div>
    );
  }

  if (!mapId) {
    return (
      <div style={viewerStyles.root}>
        <div style={viewerStyles.loadingText}>Failed to load or create map. Check server.</div>
      </div>
    );
  }

  const offsetX = viewportSize.w / 2 - cameraPos.x;
  const offsetY = viewportSize.h / 2 - cameraPos.y;

  return (
    <div style={viewerStyles.root}>
        {/* Minimal header */}
        <div style={viewerStyles.header}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={viewerStyles.title}>User: {userName}</span>
          </div>
          <span style={viewerStyles.coordLabel}>
            player pos ({Math.floor(player.x / chunkTiles)}.{player.x - Math.floor(player.x / chunkTiles) * chunkTiles}, {Math.floor(player.y / chunkTiles)}.{player.y - Math.floor(player.y / chunkTiles) * chunkTiles})
          </span>
        </div>

      {/* World container */}
      <div ref={worldWrapRef} style={viewerStyles.worldWrap}>
        <div style={{
          ...viewerStyles.world,
          transform: `translate(${offsetX}px, ${offsetY}px)`
        }}>
          {cells.map(({ cx, cy }) => {
            const key = `${cx},${cy}`;
            const chunk = chunks[key];
            return (
              <div 
                key={key} 
                style={{
                  ...viewerStyles.cell,
                  width: CELL_SIZE,
                  height: CELL_SIZE,
                  left: cx * CELL_SIZE,
                  top: cy * CELL_SIZE
                }}
              >
                {chunk ? (
                  <ChunkCanvas chunk={chunk} chunkTiles={chunkTiles} tilePx={TILE_PX} />
                ) : (
                  <div style={viewerStyles.cellEmpty}>
                    Loading {cx},{cy}...
                  </div>
                )}
              </div>
            );
          })}
          
          {/* Other players rendered in the world coordinates */}
          {Object.entries(otherPlayers).map(([name, p]) => {
            const px = p.x * TILE_PX + TILE_PX / 2;
            const py = p.y * TILE_PX + TILE_PX / 2;
            return (
              <div
                key={name}
                style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  width: 32,
                  height: 32,
                  transform: `translate(${px}px, ${py}px) translate(-50%, -50%)`,
                  transition: "transform 0.1s linear",
                  borderRadius: "50%",
                  border: "2px solid #fff",
                  background: "#4da6ff",
                  boxShadow: "0 0 10px rgba(0,0,0,0.8)",
                  zIndex: 15,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center"
                }}
              >
                <span style={{
                  position: "absolute",
                  top: -20,
                  fontSize: 10,
                  fontFamily: "'IBM Plex Mono', monospace",
                  color: "#fff",
                  background: "rgba(0,0,0,0.5)",
                  padding: "2px 4px",
                  borderRadius: 4,
                  whiteSpace: "nowrap"
                }}>{name}</span>
              </div>
            );
          })}
          {/* The current player */}
          <div style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: 32, height: 32,
            transform: `translate(${playerPixelX}px, ${playerPixelY}px) translate(-50%, -50%)`,
            transition: "transform 0.1s linear",
            borderRadius: "50%",
            border: "3px solid #fff",
            background: "#c98a3e",
            boxShadow: "0 0 10px rgba(0,0,0,0.8)",
            zIndex: 20
          }} />
        </div>

      </div>

      {/* Nav hint */}
      <div style={viewerStyles.hint}>
        Use ← ↑ → ↓ arrow keys to move player
      </div>
    </div>
  );
}

function ChunkCanvas({ chunk, chunkTiles, tilePx }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !chunk) return;
    canvas.width = chunkTiles * tilePx;
    canvas.height = chunkTiles * tilePx;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    drawChunk(ctx, chunk, chunkTiles, tilePx, "terrain");
  }, [chunk, chunkTiles, tilePx]);

  return <canvas ref={canvasRef} style={{ width: "100%", height: "100%", imageRendering: "pixelated", display: "block" }} />;
}

const viewerStyles = {
  root: {
    height: "100vh", width: "100vw", background: "#0d0f10", color: "#e7e2d3",
    fontFamily: "'Inter', sans-serif", display: "flex", flexDirection: "column",
    overflow: "hidden",
  },
  header: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    padding: "8px 16px", background: "#14171a", borderBottom: "1px solid #2a2f33",
    flexShrink: 0, zIndex: 10,
  },
  title: {
    fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, letterSpacing: "0.06em",
    color: "#c98a3e", fontWeight: 600,
  },
  coordLabel: {
    fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: "#8a9099",
    letterSpacing: "0.03em",
  },
  worldWrap: {
    flex: 1, position: "relative", overflow: "hidden"
  },
  world: {
    position: "absolute", left: 0, top: 0,
    willChange: "transform", transition: "transform 0.1s linear"
  },
  cell: {
    position: "absolute",
    background: "#0d0f10",
    display: "flex", alignItems: "center", justifyContent: "center",
  },
  cellEmpty: {
    color: "#3a4046", fontSize: 12, fontFamily: "'IBM Plex Mono', monospace",
  },
  hint: {
    position: "fixed", bottom: 16, left: "50%", transform: "translateX(-50%)",
    background: "rgba(20,23,26,0.9)", border: "1px solid #3a4046", borderRadius: 6,
    padding: "6px 16px", fontSize: 11, color: "#8a9099",
    fontFamily: "'IBM Plex Mono', monospace", zIndex: 10,
  },
  loadingText: {
    display: "flex", alignItems: "center", justifyContent: "center", flex: 1,
    fontSize: 14, color: "#8a9099", fontFamily: "'IBM Plex Mono', monospace",
  }
};
