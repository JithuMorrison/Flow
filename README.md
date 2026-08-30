# Flow - Procedural Open-World Multiplayer

Flow is an ambitious 2D procedural open-world multiplayer game built with React, Node.js, and SQLite. The project focuses on high-performance architecture, scalable data structures, and a seamless player experience.

## 🚀 Game Features & Technical Implementation

### 1. High-Performance Authentication & Bloom Filters
- **Instant Availability Checking:** The backend uses an **in-memory Bloom Filter** populated at server startup to check if a username is taken. This allows real-time, sub-millisecond keystroke validation on the registration page without hammering the database with heavy SQL queries.
- **Secure Credentials:** Passwords are encrypted using `bcryptjs` and stored safely in SQLite.
- **Dynamic UI:** A seamless single-page entry flow that automatically adapts between a login prompt or registration flow depending on real-time username availability.

### 2. Atlas Engine (Procedural Generation)
- **Infinite Generation:** The world is procedurally generated using Perlin noise mathematics.
- **Chunk-based Architecture:** Instead of loading an infinitely massive world into memory, the map is broken down into manageable chunks (e.g., 50x50 tiles).
- **Global Indexing:** Each chunk is uniquely identified in the database by its `latlong` (`cx,cy`) coordinate, establishing the entire game world as a single, shared, borderless plane. 

### 3. Smart Database & Storage (SQLite)
- **Gzip Compression:** Chunk data is aggressively compressed using Node's native `zlib` before being saved to SQLite. This drastically reduces database size and disk footprint.
- **Scalable Schema:** The chunk table uses a combined primary key index on `latlong`, `world`, and `layer`, allowing for future expansions like alternate dimensions, underground layers, or distinct world instances.

### 4. Multiplayer Map Viewer
- **Real-Time WebSockets:** Leverages `socket.io` to stream and broadcast player movements. You can open multiple windows and watch other players navigate the world live.
- **Sub-Tile Precision:** Player movement is tracked at floating-point precision (half-cell movement keypresses), not just rigid grid blocks. 
- **Hierarchical Coordinates:** The UI elegantly displays positions in a `Chunk.Tile` format (e.g., `0.45`, `-1.20`) so players can easily distinguish their macro-region (the chunk ID) from their exact micro-position (the tile offset).
- **Viewport Lazy Loading:** The client dynamically calculates viewport bounding boxes and only fetches/renders the chunks immediately visible to the player.

---

## 💻 How to Run

You can start both the frontend React app and the backend Node.js server with a single command!

### 1. Install Dependencies
```bash
npm install
```

### 2. Start the Game
```bash
npm run dev:all
```

*(This uses `concurrently` to run both the Vite frontend and Express backend at the same time).*

- The frontend will be available at: **http://localhost:5173**
- The backend server runs on: **http://localhost:3001**
