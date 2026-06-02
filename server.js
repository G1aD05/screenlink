const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,      // 60s before declaring connection dead
  pingInterval: 25000,     // ping every 25s
  upgradeTimeout: 30000,
});

app.use(express.static(path.join(__dirname, 'public')));

// Sessions: code -> { hostId, viewers: Set<socketId>, expiry, passwordHash, public, label }
const sessions = new Map();

// Public broadcasts: code -> { label, viewerCount }
// (subset of sessions where public === true)

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

function buildPublicList() {
  const list = [];
  for (const [code, session] of sessions) {
    if (session.public && session.expiry > Date.now()) {
      list.push({
        code,
        label: session.label || 'Anonymous',
        viewers: session.viewers.size,
      });
    }
  }
  return list;
}

function broadcastPublicList() {
  io.emit('public:list', buildPublicList());
}

io.on('connection', (socket) => {
  console.log('connect', socket.id);

  // ── HOST: request a new session code ──
  socket.on('host:create', ({ passwordHash } = {}) => {
    // Remove any existing host session for this socket
    for (const [code, s] of sessions) {
      if (s.hostId === socket.id) sessions.delete(code);
    }
    const code = generateCode();
    sessions.set(code, {
      hostId: socket.id,
      viewers: new Set(),
      expiry: Date.now() + 5 * 60 * 1000,
      passwordHash: passwordHash || null, // null = no password
    });
    socket.join('host:' + code);
    socket.data.role = 'host';
    socket.data.code = code;
    const hasPassword = !!passwordHash;
    socket.emit('host:code', { code, expiresIn: 5 * 60, hasPassword });
    console.log('host created code', code, hasPassword ? '(password protected)' : '(no password)');
  });

  // ── HOST: refresh code (called every 5 min) ──
  socket.on('host:refresh', () => {
    const oldCode = socket.data.code;
    if (oldCode) {
      const session = sessions.get(oldCode);
      // If viewers are connected, just extend expiry — don't change the code
      if (session && session.viewers.size > 0) {
        session.expiry = Date.now() + 5 * 60 * 1000;
        socket.emit('host:code', { code: oldCode, expiresIn: 5 * 60 });
        console.log('active viewers — extended code', oldCode);
        return;
      }
      // No viewers — safe to issue a new code
      sessions.delete(oldCode);
      socket.leave('host:' + oldCode);
    }
    const code = generateCode();
    const oldSession = sessions.get(oldCode);
    const existingPasswordHash = oldSession ? oldSession.passwordHash : null;
    sessions.set(code, {
      hostId: socket.id,
      viewers: new Set(),
      expiry: Date.now() + 5 * 60 * 1000,
      passwordHash: existingPasswordHash,
    });
    socket.join('host:' + code);
    socket.data.code = code;
    socket.emit('host:code', { code, expiresIn: 5 * 60, hasPassword: !!existingPasswordHash });
    console.log('host refreshed code', code);
  });

  // ── VIEWER: join a session ──
  socket.on('viewer:join', ({ code, passwordHash }) => {
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
    // Check password if session is protected
    if (session.passwordHash) {
      if (!passwordHash || passwordHash !== session.passwordHash) {
        socket.emit('viewer:error', { message: 'Incorrect password.', wrongPassword: true });
        console.log('viewer wrong password for code', code);
        return;
      }
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

  // ── Viewer sends sound to host (chunked) ──
  socket.on('cmd:sound-start', ({ mimeType, volume, totalChunks }) => {
    const code = socket.data.code;
    const session = sessions.get(code);
    if (!session) return;
    io.to(session.hostId).emit('cmd:sound-start', { mimeType, volume: volume || 1, totalChunks });
  });

  socket.on('cmd:sound-chunk', ({ chunk, index }) => {
    const code = socket.data.code;
    const session = sessions.get(code);
    if (!session) return;
    io.to(session.hostId).emit('cmd:sound-chunk', { chunk, index });
  });

  socket.on('cmd:sound-end', () => {
    const code = socket.data.code;
    const session = sessions.get(code);
    if (!session) return;
    io.to(session.hostId).emit('cmd:sound-end');
  });

  socket.on('cmd:stop-sound', () => {
    const code = socket.data.code;
    const session = sessions.get(code);
    if (!session) return;
    io.to(session.hostId).emit('cmd:stop-sound');
  });

  // ── Viewer sends mouse/keyboard command to host ──
  socket.on('cmd:input', (cmd) => {
    const code = socket.data.code;
    const session = sessions.get(code);
    if (!session) return;
    io.to(session.hostId).emit('cmd:input', cmd);
  });

  // ── Host reports extension status to viewers ──
  socket.on('host:ext-status', (status) => {
    const code = socket.data.code;
    if (!code) return;
    io.to('viewers:' + code).emit('host:ext-status', status);
  });

  // ── Host sends info response back to viewers ──
  socket.on('host:info-response', (info) => {
    const code = socket.data.code;
    if (!code) return;
    io.to('viewers:' + code).emit('host:info-response', info);
  });

  // ── Viewer confirms stream received ──
  socket.on('viewer:stream-ack', () => {
    const code = socket.data.code;
    const session = sessions.get(code);
    if (!session) return;
    io.to(session.hostId).emit('viewer:stream-ack');
  });

  // ── Host broadcasts sound progress to viewers ──
  socket.on('host:sound-progress', ({ current, duration }) => {
    const code = socket.data.code;
    if (!code) return;
    io.to('viewers:' + code).emit('host:sound-progress', { current, duration });
  });

  socket.on('host:sound-ended', () => {
    const code = socket.data.code;
    if (!code) return;
    io.to('viewers:' + code).emit('host:sound-ended');
  });

  // ── Host confirms a tab was closed ──
  socket.on('host:tab-closed', ({ tabId }) => {
    const code = socket.data.code;
    if (!code) return;
    io.to('viewers:' + code).emit('host:tab-closed', { tabId });
  });

  // ── Host broadcasts info (active tab, time) to viewers ──
  socket.on('host:info', (info) => {
    const code = socket.data.code;
    if (!code) return;
    io.to('viewers:' + code).emit('host:info', info);
  });

  // ── File transfer (chunked) ──
  socket.on('cmd:file-start', ({ name, size, mimeType, totalChunks }) => {
    const code = socket.data.code;
    const session = sessions.get(code);
    if (!session) return;
    if (size > 50 * 1024 * 1024) { // 50MB limit
      socket.emit('file:error', { message: 'File too large (max 50MB).' });
      return;
    }
    io.to(session.hostId).emit('cmd:file-start', { name, size, mimeType, totalChunks });
  });

  socket.on('cmd:file-chunk', ({ chunk, index }) => {
    const code = socket.data.code;
    const session = sessions.get(code);
    if (!session) return;
    io.to(session.hostId).emit('cmd:file-chunk', { chunk, index });
  });

  socket.on('cmd:file-end', () => {
    const code = socket.data.code;
    const session = sessions.get(code);
    if (!session) return;
    io.to(session.hostId).emit('cmd:file-end');
  });

  socket.on('host:file-received', ({ name }) => {
    const code = socket.data.code;
    if (!code) return;
    io.to('viewers:' + code).emit('host:file-received', { name });
  });

  // ── Host toggles public broadcast ──
  socket.on('host:set-public', ({ isPublic, label }) => {
    const code = socket.data.code;
    const session = sessions.get(code);
    if (!session) return;
    session.public = isPublic;
    session.label = label || 'Anonymous';
    broadcastPublicList();
    console.log('host', socket.id, 'set public:', isPublic, 'label:', label);
  });

  // ── Viewer requests public list ──
  socket.on('viewer:get-public', () => {
    socket.emit('public:list', buildPublicList());
  });

  // ── Viewer joins public session (no code needed) ──
  socket.on('viewer:join-public', ({ code }) => {
    const session = sessions.get(code);
    if (!session || !session.public) {
      socket.emit('viewer:error', { message: 'This broadcast is no longer public.' });
      return;
    }
    session.viewers.add(socket.id);
    socket.join('viewers:' + code);
    socket.data.role = 'viewer';
    socket.data.code = code;
    socket.data.hostId = session.hostId;
    io.to(session.hostId).emit('viewer:joined', { viewerId: socket.id });
    socket.emit('viewer:ok', { hostId: session.hostId });
    broadcastPublicList();
  });

  // ── Keepalive ping ──
  socket.on('ping', () => {
    socket.emit('pong');
  });

  // ── Cleanup on disconnect ──
  socket.on('disconnect', () => {
    const { role, code, hostId } = socket.data || {};
    if (!code) return;
    if (role === 'host') {
      io.to('viewers:' + code).emit('host:disconnected');
      sessions.delete(code);
      broadcastPublicList();
      console.log('host disconnected, session', code, 'ended');
    } else if (role === 'viewer') {
      const session = sessions.get(code);
      if (session) {
        session.viewers.delete(socket.id);
        io.to(session.hostId).emit('viewer:left', { viewerId: socket.id });
        broadcastPublicList();
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`ScreenLink running on port ${PORT}`));
