const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
});

app.use(express.static(path.join(__dirname, 'public')));

// Sessions: code -> { hostId, viewers: Set<socketId>, expiry }
const sessions = new Map();

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function cleanSessions() {
  const now = Date.now();
  for (const [code, session] of sessions) {
    if (session.expiry < now) sessions.delete(code);
  }
}
setInterval(cleanSessions, 60_000);

io.on('connection', (socket) => {
  console.log('connect', socket.id);

  // ── HOST: request a new session code ──
  socket.on('host:create', () => {
    // Remove any existing host session for this socket
    for (const [code, s] of sessions) {
      if (s.hostId === socket.id) sessions.delete(code);
    }
    const code = generateCode();
    sessions.set(code, {
      hostId: socket.id,
      viewers: new Set(),
      expiry: Date.now() + 5 * 60 * 1000,
    });
    socket.join('host:' + code);
    socket.data.role = 'host';
    socket.data.code = code;
    socket.emit('host:code', { code, expiresIn: 5 * 60 });
    console.log('host created code', code);
  });

  // ── HOST: refresh code (called every 5 min) ──
  socket.on('host:refresh', () => {
    const oldCode = socket.data.code;
    if (oldCode) {
      // Notify viewers of old session to disconnect
      io.to('viewers:' + oldCode).emit('session:expired');
      sessions.delete(oldCode);
      socket.leave('host:' + oldCode);
    }
    const code = generateCode();
    sessions.set(code, {
      hostId: socket.id,
      viewers: new Set(),
      expiry: Date.now() + 5 * 60 * 1000,
    });
    socket.join('host:' + code);
    socket.data.code = code;
    socket.emit('host:code', { code, expiresIn: 5 * 60 });
    console.log('host refreshed code', code);
  });

  // ── VIEWER: join a session ──
  socket.on('viewer:join', ({ code }) => {
    const session = sessions.get(code);
    if (!session) {
      socket.emit('viewer:error', { message: 'Code not found or expired.' });
      return;
    }
    if (session.expiry < Date.now()) {
      sessions.delete(code);
      socket.emit('viewer:error', { message: 'Session has expired.' });
      return;
    }
    session.viewers.add(socket.id);
    socket.join('viewers:' + code);
    socket.data.role = 'viewer';
    socket.data.code = code;
    socket.data.hostId = session.hostId;

    // Tell host a viewer joined so it initiates WebRTC offer
    io.to(session.hostId).emit('viewer:joined', { viewerId: socket.id });
    socket.emit('viewer:ok', { hostId: session.hostId });
    console.log('viewer joined code', code, socket.id);
  });

  // ── WebRTC Signaling: relay between host and viewer ──
  socket.on('rtc:offer', ({ to, offer }) => {
    io.to(to).emit('rtc:offer', { from: socket.id, offer });
  });

  socket.on('rtc:answer', ({ to, answer }) => {
    io.to(to).emit('rtc:answer', { from: socket.id, answer });
  });

  socket.on('rtc:ice', ({ to, candidate }) => {
    io.to(to).emit('rtc:ice', { from: socket.id, candidate });
  });

  // ── Viewer sends a command to host (open URL) ──
  socket.on('cmd:open-url', ({ url }) => {
    const code = socket.data.code;
    const session = sessions.get(code);
    if (!session) return;
    io.to(session.hostId).emit('cmd:open-url', { url, viewerId: socket.id });
  });

  // ── Viewer sends a command to host (close tab) ──
  socket.on('cmd:close-tab', ({ tabId }) => {
    const code = socket.data.code;
    const session = sessions.get(code);
    if (!session) return;
    io.to(session.hostId).emit('cmd:close-tab', { tabId });
  });

  // ── Host confirms a tab was opened (sends tabId + url back to viewers) ──
  socket.on('host:tab-opened', ({ tabId, url }) => {
    const code = socket.data.code;
    if (!code) return;
    io.to('viewers:' + code).emit('host:tab-opened', { tabId, url });
  });

  // ── Host confirms a tab was closed ──
  socket.on('host:tab-closed', ({ tabId }) => {
    const code = socket.data.code;
    if (!code) return;
    io.to('viewers:' + code).emit('host:tab-closed', { tabId });
  });

  // ── Cleanup on disconnect ──
  socket.on('disconnect', () => {
    const { role, code, hostId } = socket.data || {};
    if (!code) return;
    if (role === 'host') {
      io.to('viewers:' + code).emit('host:disconnected');
      sessions.delete(code);
      console.log('host disconnected, session', code, 'ended');
    } else if (role === 'viewer') {
      const session = sessions.get(code);
      if (session) {
        session.viewers.delete(socket.id);
        io.to(session.hostId).emit('viewer:left', { viewerId: socket.id });
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`ScreenLink running on port ${PORT}`));
