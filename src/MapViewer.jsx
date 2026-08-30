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
import { drawChunk, generateChunkData } from "./WorldGen";

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

    return () => socket.disconnect();
  }, [userName]);

  useEffect(() => {
    const handleResize = () => setWindowSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const chunkTiles = mapMeta?.chunkTiles || 50;
  const CELL_SIZE = chunkTiles * TILE_PX;

  // Calculate which chunks are visible based on player position and window size
  const cells = useMemo(() => {
    const px = player.x * TILE_PX + TILE_PX / 2;
    const py = player.y * TILE_PX + TILE_PX / 2;
    
    const minCx = Math.floor((px - windowSize.w / 2) / CELL_SIZE) - 1;
    const maxCx = Math.floor((px + windowSize.w / 2) / CELL_SIZE) + 1;
    const minCy = Math.floor((py - windowSize.h / 2) / CELL_SIZE) - 1;
    const maxCy = Math.floor((py + windowSize.h / 2) / CELL_SIZE) + 1;

    const out = [];
    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        out.push({ cx, cy });
      }
    }
    return out;
  }, [player, windowSize, CELL_SIZE]);

  // Subscribe to visible chunks
  useEffect(() => {
    if (socketRef.current && cells.length > 0) {
      socketRef.current.emit("subscribeChunks", cells.map(c => `${c.cx},${c.cy}`));
    }
  }, [cells]);

  // Load user & map metadata on mount
  useEffect(() => {
    (async () => {
      try {
        let currentMapId = null;

        if (userName) {
          const userRes = await fetch(`/api/users/${encodeURIComponent(userName)}`);
          if (userRes.ok) {
            const user = await userRes.json();
            setPlayer({ x: user.player_px || 0, y: user.player_py || 0 });
            currentMapId = user.map_id;
          }
        }

        if (!currentMapId) {
          // If no map bound to user, find latest map
          const res = await fetch("/api/maps");
          const maps = await res.json();
          if (maps.length > 0) {
            currentMapId = maps[maps.length - 1].mapId;
          } else {
            // Auto-create a new map!
            const seed = Math.floor(Math.random() * 1e7);
            const createRes = await fetch("/api/maps", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ seed, chunkTiles: 50, anchors: [] }),
            });
            const newMap = await createRes.json();
            currentMapId = newMap.mapId;
          }
        }

        if (currentMapId) {
          const metaRes = await fetch(`/api/maps/${currentMapId}`);
          const meta = await metaRes.json();
          setMapId(meta.mapId);
          setMapMeta(meta);
        }
      } catch (e) {
        console.warn("Backend not available:", e.message);
      }
      setLoading(false);
    })();
  }, [userName]);

  // Load visible chunks from backend
  useEffect(() => {
    if (!mapId || !mapMeta) return;
    (async () => {
      const keysToLoad = cells
        .map(({ cx, cy }) => `${cx},${cy}`)
        .filter((k) => !chunks[k]);
      if (keysToLoad.length === 0) return;

      for (const key of keysToLoad) {
        try {
          const res = await fetch(`/api/maps/${mapId}/chunks/${key}`);
          if (res.ok) {
            const data = await res.json();
            setChunks((prev) => ({ ...prev, [key]: data }));
          } else if (res.status === 404) {
            // Auto-generate missing chunk with Natural biome
            const [cx, cy] = key.split(",").map(Number);
            const world = { seed: mapMeta.seed, chunkTiles: mapMeta.chunkTiles || 50, anchors: [] };
            const data = generateChunkData(cx, cy, world, chunks);
            data.generatedAt = Date.now();
            data.paintedBiome = null;
            
            // Save it immediately
            await fetch(`/api/maps/${mapId}/chunks/${key}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(data),
            });
            
            setChunks((prev) => ({ ...prev, [key]: data }));
          }
        } catch (e) {
          // Network error — skip
        }
      }
    })();
  }, [mapId, mapMeta, cells]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard navigation (moves the player)
  useEffect(() => {
    const handler = (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
      switch (e.key) {
        case "ArrowUp": e.preventDefault(); setPlayer((p) => ({ ...p, y: p.y - 0.5 })); break;
        case "ArrowDown": e.preventDefault(); setPlayer((p) => ({ ...p, y: p.y + 0.5 })); break;
        case "ArrowLeft": e.preventDefault(); setPlayer((p) => ({ ...p, x: p.x - 0.5 })); break;
        case "ArrowRight": e.preventDefault(); setPlayer((p) => ({ ...p, x: p.x + 0.5 })); break;
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

  // Calculate world offset to center the player
  const playerPixelX = player.x * TILE_PX + TILE_PX / 2;
  const playerPixelY = player.y * TILE_PX + TILE_PX / 2;
  const offsetX = windowSize.w / 2 - playerPixelX;
  const offsetY = windowSize.h / 2 - playerPixelY;

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
      <div style={viewerStyles.worldWrap}>
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
                  left: px,
                  top: py,
                  width: 32,
                  height: 32,
                  transform: "translate(-50%, -50%)",
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
        </div>
        
        {/* Player Indicator (fixed at center of screen) */}
        <div style={viewerStyles.playerIndicator} />
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
  playerIndicator: {
    position: "absolute", left: "50%", top: "50%",
    width: 32, height: 32,
    transform: "translate(-50%, -50%)",
    borderRadius: "50%",
    border: "3px solid #fff",
    background: "#c98a3e",
    boxShadow: "0 0 10px rgba(0,0,0,0.8)",
    zIndex: 20
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
