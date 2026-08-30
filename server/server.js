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

// To ensure schema is updated if it exists, we drop chunks if we are changing its structure (for dev only)
// Commented out to avoid data loss, but schema is updated below.
db.exec(`
  CREATE TABLE IF NOT EXISTS maps (
    id TEXT PRIMARY KEY,
    seed INTEGER,
    chunkTiles INTEGER,
    anchors TEXT,
    createdAt TEXT
  );

  CREATE TABLE IF NOT EXISTS chunks (
    latlong TEXT PRIMARY KEY,
    map_id TEXT,
    world INTEGER DEFAULT 1,
    layer INTEGER DEFAULT 1,
    data BLOB,
    FOREIGN KEY (map_id) REFERENCES maps(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_chunks_latlong ON chunks(latlong);

  CREATE TABLE IF NOT EXISTS users (
    name TEXT PRIMARY KEY,
    password TEXT,
    map_id TEXT,
    player_px INTEGER,
    player_py INTEGER,
    created_at TEXT
  );
`);

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


/**
 * MAPS API
 */
app.post('/api/maps', (req, res) => {
  try {
    const { seed, chunkTiles, anchors } = req.body;
    const mapId = crypto.randomUUID();

    const meta = {
      mapId,
      seed: seed ?? null,
      chunkTiles: chunkTiles ?? null,
      anchors: anchors ?? [],
      createdAt: new Date().toISOString()
    };

    db.prepare(`
      INSERT INTO maps (id, seed, chunkTiles, anchors, createdAt)
      VALUES (?, ?, ?, ?, ?)
    `).run(mapId, meta.seed, meta.chunkTiles, JSON.stringify(meta.anchors), meta.createdAt);

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
      anchors: JSON.parse(m.anchors || '[]'),
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
      anchors: JSON.parse(m.anchors || '[]'),
      createdAt: m.createdAt
    });
  } catch (err) {
    console.error('Error fetching map metadata:', err);
    res.status(500).json({ error: 'Failed to fetch map metadata' });
  }
});

app.put('/api/maps/:id/chunks/:key', async (req, res) => {
  try {
    const { id, key } = req.params;
    const chunkData = req.body;

    const jsonBuffer = Buffer.from(JSON.stringify(chunkData));
    const compressed = await gzipAsync(jsonBuffer);

    db.prepare(`
      INSERT INTO chunks (latlong, map_id, data)
      VALUES (?, ?, ?)
      ON CONFLICT(latlong) DO UPDATE SET data = excluded.data, map_id = excluded.map_id
    `).run(key, id, compressed);

    res.json({ saved: true, key, compressedSize: compressed.length });
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
      INSERT INTO chunks (latlong, map_id, data)
      VALUES (?, ?, ?)
      ON CONFLICT(latlong) DO UPDATE SET data = excluded.data, map_id = excluded.map_id
    `);
    
    // Compress all first, then insert synchronously
    const preparedChunks = await Promise.all(
      keys.map(async (key) => {
        const jsonBuffer = Buffer.from(JSON.stringify(chunks[key]));
        const compressed = await gzipAsync(jsonBuffer);
        return { key, compressed };
      })
    );

    db.transaction((data) => {
      for (const item of data) {
        stmt.run(item.key, id, item.compressed);
      }
    })(preparedChunks);

    res.json({ saved: true, count: keys.length, keys });
  } catch (err) {
    console.error('Error saving batch chunks:', err);
    res.status(500).json({ error: 'Failed to save batch chunks' });
  }
});

app.get('/api/maps/:id/chunks/:key', async (req, res) => {
  try {
    const { id, key } = req.params;
    const row = db.prepare('SELECT data FROM chunks WHERE latlong = ?').get(key);
    
    if (!row) return res.status(404).json({ error: 'Chunk not found' });

    const decompressed = await gunzipAsync(row.data);
    const chunkData = JSON.parse(decompressed.toString('utf-8'));
    res.json(chunkData);
  } catch (err) {
    console.error('Error fetching chunk:', err);
    res.status(500).json({ error: 'Failed to fetch chunk' });
  }
});

app.get('/api/maps/:id/chunks', async (req, res) => {
  try {
    const rows = db.prepare('SELECT latlong, data FROM chunks').all();

    const chunks = {};
    await Promise.all(rows.map(async (row) => {
      const decompressed = await gunzipAsync(row.data);
      chunks[row.latlong] = JSON.parse(decompressed.toString('utf-8'));
    }));

    res.json({ chunks });
  } catch (err) {
    console.error('Error fetching chunks:', err);
    res.status(500).json({ error: 'Failed to fetch chunks' });
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
