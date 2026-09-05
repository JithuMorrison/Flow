import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import zlib from 'zlib';
import { promisify } from 'util';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import http from 'http';
import { Server } from 'socket.io';
import bcrypt from 'bcryptjs';

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3001;
const DATA_DIR = path.join(__dirname, 'data');

const gzipAsync = promisify(zlib.gzip);
const gunzipAsync = promisify(zlib.gunzip);

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Ensure base data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Setup SQLite Database
const db = new Database(path.join(DATA_DIR, 'flow.db'));

// To ensure schema is updated if it exists, we alter chunks if we are changing its structure (for dev only)
db.exec(`
  CREATE TABLE IF NOT EXISTS maps (
    id TEXT PRIMARY KEY,
    seed INTEGER,
    chunkTiles INTEGER,
    frozen INTEGER DEFAULT 0,
    createdAt TEXT
  );

  CREATE TABLE IF NOT EXISTS chunks (
    latlong TEXT PRIMARY KEY,
    map_id TEXT,
    target INTEGER,
    world INTEGER DEFAULT 1,
    layer INTEGER DEFAULT 1,
    data BLOB,
    FOREIGN KEY (map_id) REFERENCES maps(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_chunks_latlong ON chunks(latlong);
  
  CREATE TABLE IF NOT EXISTS refreshes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    anchors TEXT,
    created_at TEXT
  );

  CREATE TABLE IF NOT EXISTS users (
    name TEXT PRIMARY KEY,
    password TEXT,
    map_id TEXT,
    player_px INTEGER,
    player_py INTEGER,
    created_at TEXT
  );
`);

// Safe migrations for existing DBs if needed (ignore errors if columns exist or missing)
try { db.exec("ALTER TABLE chunks ADD COLUMN target INTEGER;"); } catch(e){}

// Setup Socket.io connections
io.on("connection", (socket) => {
  // Client joins with a username
  socket.on("join", (name) => {
    socket.data.name = name;
  });

  // Client updates which chunks they are currently viewing (to receive data only for nearby)
  socket.on("subscribeChunks", (chunkKeys) => {
    if (socket.data.rooms) {
      socket.data.rooms.forEach(r => socket.leave(r));
    }
    socket.data.rooms = chunkKeys.map(k => `chunk_${k}`);
    socket.data.rooms.forEach(r => socket.join(r));
  });

  // Client sends position update
  socket.on("move", (pos) => {
    if (!pos.chunkKey || !socket.data.name) return;
    
    // Broadcast ONLY to clients who are subscribed to this chunk
    socket.to(`chunk_${pos.chunkKey}`).emit("playerMoved", {
      name: socket.data.name,
      x: pos.x,
      y: pos.y
    });
  });

  socket.on("disconnect", () => {
    // Note: in a full implementation, we might want to tell others they left,
    // but without knowing which chunk they were in last, we can't broadcast efficiently.
    // Client polling/timeout handles stale players.
  });
});

// Simple Bloom Filter
class BloomFilter {
  constructor(size = 100000) {
    this.size = size;
    this.bits = new Uint8Array(Math.ceil(size / 8));
  }
  _hash1(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) hash = (Math.imul(31, hash) + str.charCodeAt(i)) | 0;
    return Math.abs(hash) % this.size;
  }
  _hash2(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) hash = (Math.imul(33, hash) ^ str.charCodeAt(i));
    return Math.abs(hash) % this.size;
  }
  _hash3(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash = hash & hash;
    }
    return Math.abs(hash) % this.size;
  }
  add(str) {
    [this._hash1(str), this._hash2(str), this._hash3(str)].forEach(h => {
      this.bits[Math.floor(h / 8)] |= (1 << (h % 8));
    });
  }
  mightContain(str) {
    return [this._hash1(str), this._hash2(str), this._hash3(str)].every(h => {
      return (this.bits[Math.floor(h / 8)] & (1 << (h % 8))) !== 0;
    });
  }
}

const nameBloomFilter = new BloomFilter();

// Load existing users into Bloom Filter on startup
const users = db.prepare('SELECT name FROM users').all();
users.forEach(u => nameBloomFilter.add(u.name.toLowerCase()));

/**
 * USERS API
 */
app.get('/api/users/check', (req, res) => {
  const name = req.query.name?.trim().toLowerCase();
  if (!name) return res.status(400).json({ error: 'Name is required' });

  // 1. Check Bloom Filter (fast path for negative)
  if (!nameBloomFilter.mightContain(name)) {
    return res.json({ available: true, exists: false });
  }

  // 2. Check Database (resolves false positives)
  const user = db.prepare('SELECT name FROM users WHERE lower(name) = ?').get(name);
  if (user) {
    return res.json({ available: false, exists: true });
  } else {
    return res.json({ available: true, exists: false });
  }
});

app.post('/api/users/register', async (req, res) => {
  const { name, password, map_id } = req.body;
  if (!name || !password) return res.status(400).json({ error: 'Name and password required' });

  const nameLower = name.trim().toLowerCase();
  
  if (nameBloomFilter.mightContain(nameLower)) {
    const existing = db.prepare('SELECT name FROM users WHERE lower(name) = ?').get(nameLower);
    if (existing) return res.status(409).json({ error: 'Name already taken' });
  }

  try {
    const hash = await bcrypt.hash(password, 10);
    db.prepare(`
      INSERT INTO users (name, password, map_id, player_px, player_py, created_at)
      VALUES (?, ?, ?, 0, 0, datetime('now'))
    `).run(name.trim(), hash, map_id || null);
    
    nameBloomFilter.add(nameLower);
    res.status(201).json({ name: name.trim(), success: true });
  } catch (err) {
    console.error('Error creating user:', err);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

app.post('/api/users/login', async (req, res) => {
  const { name, password } = req.body;
  if (!name || !password) return res.status(400).json({ error: 'Name and password required' });

  try {
    const user = db.prepare('SELECT * FROM users WHERE lower(name) = ?').get(name.trim().toLowerCase());
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    // For backwards compatibility with users that don't have a password yet
    if (!user.password) {
      return res.status(401).json({ error: 'Legacy user account cannot login.' });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });

    res.json({ success: true, name: user.name });
  } catch (err) {
    console.error('Error logging in:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.put('/api/users/:name/position', (req, res) => {
  const { name } = req.params;
  const { x, y } = req.body; // pixel or tile position
  try {
    db.prepare('UPDATE users SET player_px = ?, player_py = ? WHERE name = ?')
      .run(x, y, name);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update position' });
  }
});

app.get('/api/users/:name', (req, res) => {
  const { name } = req.params;
  const user = db.prepare('SELECT * FROM users WHERE name = ?').get(name);
  if (user) {
    res.json(user);
  } else {
    res.status(404).json({ error: 'User not found' });
  }
});

app.patch('/api/users/:name', (req, res) => {
  try {
    const { name } = req.params;
    const { map_id } = req.body;
    if (map_id) {
      db.prepare('UPDATE users SET map_id = ? WHERE name = ?').run(map_id, name);
    }
    res.json({ saved: true });
  } catch (err) {
    console.error('Error updating user:', err);
    res.status(500).json({ error: 'Failed to update user' });
  }
});


/**
 * MAPS API
 */
app.post('/api/maps', (req, res) => {
  try {
    const { seed, chunkTiles } = req.body;
    const mapId = crypto.randomUUID();

    const meta = {
      mapId,
      seed: seed ?? null,
      chunkTiles: chunkTiles ?? null,
      createdAt: new Date().toISOString()
    };

    db.prepare(`
      INSERT INTO maps (id, seed, chunkTiles, createdAt)
      VALUES (?, ?, ?, ?)
    `).run(mapId, meta.seed, meta.chunkTiles, meta.createdAt);

    res.status(201).json({ mapId });
  } catch (err) {
    console.error('Error creating map:', err);
    res.status(500).json({ error: 'Failed to create map' });
  }
});

app.get('/api/maps', (req, res) => {
  try {
    const maps = db.prepare('SELECT * FROM maps').all().map(m => ({
      mapId: m.id,
      seed: m.seed,
      chunkTiles: m.chunkTiles,
      frozen: !!m.frozen,
      createdAt: m.createdAt
    }));
    res.json(maps);
  } catch (err) {
    console.error('Error listing maps:', err);
    res.status(500).json({ error: 'Failed to list maps' });
  }
});

app.get('/api/maps/:id', (req, res) => {
  try {
    const { id } = req.params;
    const m = db.prepare('SELECT * FROM maps WHERE id = ?').get(id);
    if (!m) return res.status(404).json({ error: 'Map not found' });

    res.json({
      mapId: m.id,
      seed: m.seed,
      chunkTiles: m.chunkTiles,
      frozen: !!m.frozen,
      createdAt: m.createdAt
    });
  } catch (err) {
    console.error('Error fetching map metadata:', err);
    res.status(500).json({ error: 'Failed to fetch map metadata' });
  }
});

app.put('/api/maps/:id/frozen', (req, res) => {
  try {
    const { id } = req.params;
    const { frozen } = req.body;
    db.prepare('UPDATE maps SET frozen = ? WHERE id = ?').run(frozen ? 1 : 0, id);
    io.emit('mapMetaChanged', { mapId: id, frozen: !!frozen });
    res.json({ saved: true });
  } catch (err) {
    console.error('Error updating map frozen state:', err);
    res.status(500).json({ error: 'Failed to update map frozen state' });
  }
});

app.put('/api/maps/:id/chunks/:key', async (req, res) => {
  try {
    const { id, key } = req.params;
    const { target, refresh_ids } = req.body;
    
    // Store as plain JSON string instead of gzip to save CPU overhead
    const dataString = JSON.stringify({ refresh_ids: refresh_ids || [] });

    db.prepare(`
      INSERT INTO chunks (latlong, map_id, target, data)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(latlong) DO UPDATE SET target = excluded.target, data = excluded.data, map_id = excluded.map_id
    `).run(key, id, target !== null ? target : null, dataString);

    res.json({ saved: true, key });
  } catch (err) {
    console.error('Error saving chunk:', err);
    res.status(500).json({ error: 'Failed to save chunk' });
  }
});

app.put('/api/maps/:id/chunks-batch', async (req, res) => {
  try {
    const { id } = req.params;
    const { chunks } = req.body;

    if (!chunks || typeof chunks !== 'object') {
      return res.status(400).json({ error: 'Invalid chunks payload' });
    }

    const keys = Object.keys(chunks);
    const stmt = db.prepare(`
      INSERT INTO chunks (latlong, map_id, target, data)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(latlong) DO UPDATE SET target = excluded.target, data = excluded.data, map_id = excluded.map_id
    `);
    
    const items = [];
    for (const key of keys) {
      const chunk = chunks[key];
      const dataString = JSON.stringify({ refresh_ids: chunk.refresh_ids || [] });
      items.push({ key, target: chunk.target !== null ? chunk.target : null, dataString });
    }

    db.transaction((batch) => {
      for (const item of batch) {
        stmt.run(item.key, id, item.target, item.dataString);
      }
    })(items);

    res.json({ saved: true, count: keys.length, keys });
  } catch (err) {
    console.error('Error saving batch chunks:', err);
    res.status(500).json({ error: 'Failed to save batch chunks' });
  }
});

async function parseChunkData(data) {
  if (!data) return { refresh_ids: [] };
  // Legacy support for buffers (gzipped)
  if (Buffer.isBuffer(data)) {
    const decompressed = await gunzipAsync(data);
    return JSON.parse(decompressed.toString('utf-8'));
  }
  return JSON.parse(data);
}

app.get('/api/maps/:id/chunks/:key', async (req, res) => {
  try {
    const { id, key } = req.params;
    const row = db.prepare('SELECT target, data FROM chunks WHERE latlong = ? AND map_id = ?').get(key, id);
    
    if (!row) return res.status(404).json({ error: 'Chunk not found' });

    let chunkData = { target: row.target, refresh_ids: [] };
    if (row.data) {
       const parsed = await parseChunkData(row.data);
       chunkData.refresh_ids = parsed.refresh_ids || [];
    }
    res.json(chunkData);
  } catch (err) {
    console.error('Error fetching chunk:', err);
    res.status(500).json({ error: 'Failed to fetch chunk' });
  }
});

// Endpoint to fetch ONLY requested chunks for scalable loading
app.post('/api/maps/:id/chunks-fetch', async (req, res) => {
  try {
    const { id } = req.params;
    const { keys } = req.body;
    if (!keys || !Array.isArray(keys)) return res.status(400).json({ error: 'Invalid keys array' });

    // Use IN clause
    const placeholders = keys.map(() => '?').join(',');
    const rows = db.prepare(`SELECT latlong, target, data FROM chunks WHERE map_id = ? AND latlong IN (${placeholders})`).all(id, ...keys);

    const chunks = {};
    for (const row of rows) {
      let refresh_ids = [];
      if (row.data) {
        const parsed = await parseChunkData(row.data);
        refresh_ids = parsed.refresh_ids || [];
      }
      chunks[row.latlong] = { target: row.target, refresh_ids };
    }
    res.json({ chunks });
  } catch (err) {
    console.error('Error fetching chunks batch:', err);
    res.status(500).json({ error: 'Failed to fetch chunks batch' });
  }
});

// Legacy all chunks (for Atlas Engine initialization)
app.get('/api/maps/:id/chunks', async (req, res) => {
  try {
    const { id } = req.params;
    // Note: SELECT * could be heavy at 1 trillion chunks. Atlas Engine should also move to lazy load eventually!
    const rows = db.prepare('SELECT latlong, target, data FROM chunks WHERE map_id = ?').all(id);

    const chunks = {};
    for (const row of rows) {
      let refresh_ids = [];
      if (row.data) {
        const parsed = await parseChunkData(row.data);
        refresh_ids = parsed.refresh_ids || [];
      }
      chunks[row.latlong] = { target: row.target, refresh_ids };
    }
    res.json({ chunks });
  } catch (err) {
    console.error('Error fetching chunks:', err);
    res.status(500).json({ error: 'Failed to fetch chunks' });
  }
});

app.post('/api/maps/:id/refresh', async (req, res) => {
  try {
    const { id } = req.params;
    const { anchors } = req.body;
    
    // anchors is now the compressed string array/format
    const info = db.prepare(`
      INSERT INTO refreshes (anchors, created_at)
      VALUES (?, datetime('now'))
    `).run(JSON.stringify(anchors || []));
    
    res.json({ id: info.lastInsertRowid });
  } catch (err) {
    console.error('Error creating refresh event:', err);
    res.status(500).json({ error: 'Failed to create refresh event' });
  }
});

// Endpoint to fetch ONLY specific refresh IDs
app.post('/api/refreshes-fetch', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids)) return res.status(400).json({ error: 'Invalid ids array' });
    if (ids.length === 0) return res.json({ refreshes: [] });

    const placeholders = ids.map(() => '?').join(',');
    const rows = db.prepare(`SELECT id, anchors, created_at FROM refreshes WHERE id IN (${placeholders})`).all(...ids);
    
    const refreshes = rows.map(r => ({
      id: r.id,
      anchors: JSON.parse(r.anchors || '[]'),
      created_at: r.created_at
    }));
    
    res.json({ refreshes });
  } catch (err) {
    console.error('Error fetching refreshes batch:', err);
    res.status(500).json({ error: 'Failed to fetch refreshes batch' });
  }
});

// Legacy fetch all (still used by Atlas Engine on mount)
app.get('/api/maps/:id/refreshes', async (req, res) => {
  try {
    const { id } = req.params;
    // Find all unique refresh IDs used by this map's chunks
    const chunkRows = db.prepare('SELECT data FROM chunks WHERE map_id = ?').all(id);
    
    const uniqueIds = new Set();
    for (const row of chunkRows) {
      if (row.data) {
        const parsed = await parseChunkData(row.data);
        if (parsed.refresh_ids) parsed.refresh_ids.forEach(rid => uniqueIds.add(rid));
      }
    }
    
    const ids = Array.from(uniqueIds);
    if (ids.length === 0) return res.json({ refreshes: [] });
    
    const placeholders = ids.map(() => '?').join(',');
    const rows = db.prepare(`SELECT id, anchors, created_at FROM refreshes WHERE id IN (${placeholders}) ORDER BY id ASC`).all(...ids);
    
    const refreshes = rows.map(r => ({
      id: r.id,
      anchors: JSON.parse(r.anchors || '[]'),
      created_at: r.created_at
    }));
    
    res.json({ refreshes });
  } catch (err) {
    console.error('Error fetching refreshes:', err);
    res.status(500).json({ error: 'Failed to fetch refreshes' });
  }
});

app.delete('/api/maps/:id/chunks/:key', (req, res) => {
  try {
    const { id, key } = req.params;
    const info = db.prepare('DELETE FROM chunks WHERE latlong = ?').run(key);
    
    if (info.changes === 0) return res.status(404).json({ error: 'Chunk not found' });
    res.json({ deleted: true, key });
  } catch (err) {
    console.error('Error deleting chunk:', err);
    res.status(500).json({ error: 'Failed to delete chunk' });
  }
});

server.listen(PORT, () => {
  console.log(`Atlas Engine server running on http://localhost:${PORT} with SQLite database and Socket.IO`);
});
