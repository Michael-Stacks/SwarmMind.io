const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

// Load the native C++ engine
const engine = require('./build/Release/swarmmind_engine.node');

const PORT = process.env.PORT || 3001;
const TICK_RATE = 20; // 20 TPS
const TICK_INTERVAL = 1000 / TICK_RATE;

// ── Express + Socket.io setup ──────────────────────────────

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' },
    transports: ['websocket'],
    perMessageDeflate: false
});

app.use(express.static(path.join(__dirname, 'public')));

// ── Initialize game engine ─────────────────────────────────

engine.createEngine();
const mapSize = engine.getMapSize();

console.log(`[SwarmMind.io] Engine initialized. Map: ${mapSize.width}x${mapSize.height}`);

// ── Player tracking ────────────────────────────────────────

const players = new Map(); // socketId -> { playerId }

// ── Socket.io connection handling ──────────────────────────

io.on('connection', (socket) => {
    const playerId = engine.addPlayer();
    players.set(socket.id, { playerId });

    console.log(`[+] Player ${playerId} connected (${socket.id}). Total: ${players.size}`);

    // Send init data to the client
    socket.emit('init', {
        playerId,
        mapWidth: mapSize.width,
        mapHeight: mapSize.height,
        tickRate: TICK_RATE
    });

    // Handle cursor movement from client
    socket.on('cursor', (data) => {
        if (data && typeof data.x === 'number' && typeof data.y === 'number') {
            const x = Math.max(0, Math.min(mapSize.width, data.x));
            const y = Math.max(0, Math.min(mapSize.height, data.y));
            engine.setPlayerCursor(playerId, x, y);
        }
    });

    // Handle boost toggle from client
    socket.on('boost', (active) => {
        engine.setPlayerBoost(playerId, active === true);
    });

    // Handle disconnection
    socket.on('disconnect', () => {
        engine.removePlayer(playerId);
        players.delete(socket.id);
        console.log(`[-] Player ${playerId} disconnected. Total: ${players.size}`);
    });
});

// ── Game loop ──────────────────────────────────────────────

let tickCount = 0;

function gameLoop() {
    // Call the C++ tick — returns an ArrayBuffer with the full state
    const stateBuffer = engine.tick();

    if (stateBuffer && stateBuffer.byteLength > 0) {
        // Broadcast binary state to all connected clients
        const buf = Buffer.from(stateBuffer);
        io.volatile.emit('state', buf);
    }

    tickCount++;
    if (tickCount % (TICK_RATE * 10) === 0) {
        console.log(`[~] Tick ${tickCount} | Players: ${players.size} | State: ${stateBuffer ? stateBuffer.byteLength : 0} bytes`);
    }
}

setInterval(gameLoop, TICK_INTERVAL);

// ── Start server ───────────────────────────────────────────

server.listen(PORT, () => {
    console.log(`[SwarmMind.io] Server running on http://localhost:${PORT}`);
    console.log(`[SwarmMind.io] Tick rate: ${TICK_RATE} TPS`);
});
