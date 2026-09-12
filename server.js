const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000,
  upgradeTimeout: 30000,
});

app.use(express.static(path.join(__dirname, 'public')));

// Normalize a host-supplied allow-list into a lowercase Set, or null for "anyone can see/join".
// These are just self-declared display names (see viewer:join / viewer:join-public /
// viewer:get-public) — there's no login, so this isn't identity verification, just an
// allow-list match against whatever name a viewer typed in.
function normalizeAllowList(list) {
  if (!Array.isArray(list)) return null;
  const cleaned = list.map(s => String(s || '').trim().toLowerCase()).filter(Boolean);
  return cleaned.length ? new Set(cleaned) : null;
}

// Record (and return) a viewer's self-declared display name on their socket, so it's
// remembered across events (e.g. a public-list refresh) even when a later call doesn't
// resend it.
function setViewerName(socket, name) {
  if (typeof name === 'string' && name.trim()) {
    socket.data.viewerName = name.trim().slice(0, 40);
  }
  return socket.data.viewerName || '';
}

// ============================================================
// SESSIONS
// ============================================================
//
// Map key = 6-digit viewer code
//
// Session:
// {
//   sessionId,
//   hostId,
//   viewers,
//   passwordHash,
//   public,
//   label,
//   allowedViewers,
//   disconnectTimer
// }
//

const sessions = new Map();


// ============================================================
// CODE GENERATION
// ============================================================

function generateCode() {
  let code;

  do {
    code = String(
      Math.floor(
        100000 + Math.random() * 900000
      )
    );
  } while (sessions.has(code));

  return code;
}


// ============================================================
// FIND SESSION BY PERSISTENT SESSION ID
// ============================================================

function findSessionById(sessionId) {
  if (!sessionId) {
    return null;
  }

  for (const session of sessions.values()) {
    if (session.sessionId === sessionId) {
      return session;
    }
  }

  return null;
}


// ============================================================
// PUBLIC SESSION LIST
// ============================================================
//
// Personalized per-viewer: a broadcast that's public AND restricted to
// specific names is entirely left out of the list for anyone whose
// self-declared name isn't on it — it's not just unjoinable, it's
// invisible, so "share to specific people" actually reads as private
// to everyone else browsing the public list.

function buildPublicList(viewerName) {
  const nameLower = String(viewerName || '').trim().toLowerCase();
  const list = [];

  for (const [code, session] of sessions) {
    if (!session.public) {
      continue;
    }

    if (
      session.allowedViewers &&
      !session.allowedViewers.has(nameLower)
    ) {
      continue;
    }

    list.push({
      code,
      label: session.label || 'Anonymous',
      viewers: session.viewers.size,
    });
  }

  return list;
}


function broadcastPublicList() {
  for (const socket of io.sockets.sockets.values()) {
    socket.emit(
      'public:list',
      buildPublicList(socket.data.viewerName)
    );
  }
}


// ============================================================
// SEND TO HOST
// ============================================================

function sendToHost(session, event, data) {
  if (!session || !session.hostId) {
    return false;
  }

  const host = io.sockets.sockets.get(
    session.hostId
  );

  if (!host) {
    session.hostId = null;
    return false;
  }

  host.emit(event, data);

  return true;
}


// ============================================================
// SOCKET CONNECTION
// ============================================================

io.on('connection', (socket) => {
  console.log(
    'connect',
    socket.id
  );


  // ==========================================================
  // HOST: CREATE
  // ==========================================================

  socket.on(
    'host:create',
    ({ passwordHash } = {}) => {

      // Remove sessions currently owned
      // by this socket.
      for (
        const [code, session]
        of sessions
      ) {
        if (
          session.hostId === socket.id
        ) {
          sessions.delete(code);
        }
      }


      const sessionId =
        crypto.randomUUID();

      const code =
        generateCode();


      sessions.set(
        code,
        {
          sessionId,

          hostId:
            socket.id,

          viewers:
            new Set(),

          passwordHash:
            passwordHash || null,

          public:
            false,

          label:
            'Anonymous',

          allowedViewers:
            null,

          disconnectTimer:
            null
        }
      );


      socket.join(
        'host:' + code
      );


      socket.data.role =
        'host';

      socket.data.code =
        code;

      socket.data.sessionId =
        sessionId;


      socket.emit(
        'host:code',
        {
          code,

          sessionId,

          hasPassword:
            !!passwordHash
        }
      );


      console.log(
        'host created',
        'code:',
        code,
        'session:',
        sessionId
      );
    }
  );


  // ==========================================================
  // HOST: SET ACCESS RESTRICTIONS
  // ==========================================================

  socket.on(
    'host:set-restrictions',
    ({ allowedViewers } = {}) => {

      const code =
        socket.data.code;

      const session =
        sessions.get(code);

      if (!session || session.hostId !== socket.id) {
        return;
      }

      session.allowedViewers =
        normalizeAllowList(allowedViewers);

      console.log(
        'host',
        socket.id,
        'set access restriction on',
        code,
        session.allowedViewers ? [...session.allowedViewers].join(', ') : '(open)'
      );

      broadcastPublicList();
    }
  );


  // ==========================================================
  // HOST: RECONNECT
  // ==========================================================

  socket.on(
    'host:join',
    ({ sessionId }) => {

      console.log(
        'host attempting reconnect:',
        sessionId
      );


      const session =
        findSessionById(
          sessionId
        );


      if (!session) {
        console.log(
          'session not found:',
          sessionId
        );

        socket.emit(
          'session:expired'
        );

        return;
      }


      // Cancel the 10-second
      // disconnect deletion timer.
      if (
        session.disconnectTimer
      ) {
        clearTimeout(
          session.disconnectTimer
        );

        session.disconnectTimer =
          null;

        console.log(
          'cancelled session deletion timer:',
          session.code
        );
      }


      // If another socket was previously
      // the host, replace it.
      session.hostId =
        socket.id;


      socket.data.role =
        'host';

      socket.data.code =
        [...sessions.entries()]
          .find(
            ([, value]) =>
              value === session
          )?.[0];

      socket.data.sessionId =
        sessionId;


      const code =
        socket.data.code;


      socket.join(
        'host:' + code
      );


      socket.emit(
        'host:code',
        {
          code,

          sessionId,

          hasPassword:
            !!session.passwordHash
        }
      );


      // Tell the newly connected host
      // about all existing viewers.
      for (
        const viewerId
        of session.viewers
      ) {
        socket.emit(
          'viewer:joined',
          {
            viewerId
          }
        );
      }


      console.log(
        'host reconnected',
        'code:',
        code,
        'session:',
        sessionId
      );
    }
  );


  // ==========================================================
  // VIEWER: JOIN
  // ==========================================================

  socket.on(
    'viewer:join',
    ({
      code,
      passwordHash,
      name
    }) => {

      code =
        String(code || '');

      const viewerName =
        setViewerName(socket, name);


      const session =
        sessions.get(code);


      if (!session) {
        socket.emit(
          'viewer:error',
          {
            message:
              'Code not found.'
          }
        );

        return;
      }


      if (
        session.passwordHash
      ) {

        if (
          !passwordHash ||
          passwordHash !==
            session.passwordHash
        ) {

          socket.emit(
            'viewer:error',
            {
              message:
                'Incorrect password.',

              wrongPassword:
                true
            }
          );


          console.log(
            'viewer wrong password for code',
            code
          );

          return;
        }
      }


      if (
        session.allowedViewers &&
        !session.allowedViewers.has(
          viewerName.toLowerCase()
        )
      ) {

        socket.emit(
          'viewer:error',
          {
            message:
              'You are not authorized to view this broadcast.'
          }
        );

        console.log(
          'viewer',
          viewerName || '(unnamed)',
          'denied (not on allow list) for code',
          code
        );

        return;
      }


      session.viewers.add(
        socket.id
      );


      socket.join(
        'viewers:' + code
      );


      socket.data.role =
        'viewer';

      socket.data.code =
        code;

      socket.data.hostId =
        session.hostId;


      sendToHost(
        session,
        'viewer:joined',
        {
          viewerId:
            socket.id
        }
      );


      socket.emit(
        'viewer:ok',
        {
          hostId:
            session.hostId
        }
      );


      console.log(
        'viewer joined code',
        code,
        socket.id
      );


      broadcastPublicList();
    }
  );


  // ==========================================================
  // WEBRTC SIGNALING
  // ==========================================================

  socket.on(
    'rtc:offer',
    ({
      to,
      offer
    }) => {

      io.to(to).emit(
        'rtc:offer',
        {
          from:
            socket.id,

          offer
        }
      );
    }
  );


  socket.on(
    'rtc:answer',
    ({
      to,
      answer
    }) => {

      io.to(to).emit(
        'rtc:answer',
        {
          from:
            socket.id,

          answer
        }
      );
    }
  );


  socket.on(
    'rtc:ice',
    ({
      to,
      candidate
    }) => {

      io.to(to).emit(
        'rtc:ice',
        {
          from:
            socket.id,

          candidate
        }
      );
    }
  );


  // ==========================================================
  // OPEN URL
  // ==========================================================

  socket.on(
    'cmd:open-url',
    ({ url }) => {

      const session =
        sessions.get(
          socket.data.code
        );


      if (!session) {
        return;
      }


      sendToHost(
        session,
        'cmd:open-url',
        {
          url,

          viewerId:
            socket.id
        }
      );
    }
  );


  // ==========================================================
  // CLOSE TAB
  // ==========================================================

  socket.on(
    'cmd:close-tab',
    ({ tabId }) => {

      const session =
        sessions.get(
          socket.data.code
        );


      if (!session) {
        return;
      }


      sendToHost(
        session,
        'cmd:close-tab',
        {
          tabId
        }
      );
    }
  );


  // ==========================================================
  // HOST TAB OPENED
  // ==========================================================

  socket.on(
    'host:tab-opened',
    ({
      tabId,
      url
    }) => {

      const code =
        socket.data.code;


      if (!code) {
        return;
      }


      io.to(
        'viewers:' + code
      ).emit(
        'host:tab-opened',
        {
          tabId,
          url
        }
      );
    }
  );


  // ==========================================================
  // SOUND
  // ==========================================================

  socket.on(
    'cmd:sound-start',
    ({
      mimeType,
      volume,
      totalChunks
    }) => {

      const session =
        sessions.get(
          socket.data.code
        );


      if (!session) {
        return;
      }


      sendToHost(
        session,
        'cmd:sound-start',
        {
          mimeType,

          volume:
            volume || 1,

          totalChunks
        }
      );
    }
  );


  socket.on(
    'cmd:sound-chunk',
    ({
      chunk,
      index
    }) => {

      const session =
        sessions.get(
          socket.data.code
        );


      if (!session) {
        return;
      }


      sendToHost(
        session,
        'cmd:sound-chunk',
        {
          chunk,
          index
        }
      );
    }
  );


  socket.on(
    'cmd:sound-end',
    () => {

      const session =
        sessions.get(
          socket.data.code
        );


      if (!session) {
        return;
      }


      sendToHost(
        session,
        'cmd:sound-end'
      );
    }
  );


  socket.on(
    'cmd:stop-sound',
    () => {

      const session =
        sessions.get(
          socket.data.code
        );


      if (!session) {
        return;
      }


      sendToHost(
        session,
        'cmd:stop-sound'
      );
    }
  );


  // ==========================================================
  // INPUT
  // ==========================================================

  socket.on(
    'cmd:input',
    (cmd) => {

      const session =
        sessions.get(
          socket.data.code
        );


      if (!session) {
        return;
      }


      sendToHost(
        session,
        'cmd:input',
        cmd
      );
    }
  );


  // ==========================================================
  // EXTENSION STATUS
  // ==========================================================

  socket.on(
    'host:ext-status',
    (status) => {

      const code =
        socket.data.code;


      if (!code) {
        return;
      }


      io.to(
        'viewers:' + code
      ).emit(
        'host:ext-status',
        status
      );
    }
  );


  // ==========================================================
  // HOST INFO RESPONSE
  // ==========================================================

  socket.on(
    'host:info-response',
    (info) => {

      const code =
        socket.data.code;


      if (!code) {
        return;
      }


      io.to(
        'viewers:' + code
      ).emit(
        'host:info-response',
        info
      );
    }
  );


  // ==========================================================
  // STREAM ACK
  // ==========================================================

  socket.on(
    'viewer:stream-ack',
    () => {

      const session =
        sessions.get(
          socket.data.code
        );


      if (!session) {
        return;
      }


      sendToHost(
        session,
        'viewer:stream-ack'
      );
    }
  );


  // ==========================================================
  // SOUND PROGRESS
  // ==========================================================

  socket.on(
    'host:sound-progress',
    ({
      current,
      duration
    }) => {

      const code =
        socket.data.code;


      if (!code) {
        return;
      }


      io.to(
        'viewers:' + code
      ).emit(
        'host:sound-progress',
        {
          current,
          duration
        }
      );
    }
  );


  socket.on(
    'host:sound-ended',
    () => {

      const code =
        socket.data.code;


      if (!code) {
        return;
      }


      io.to(
        'viewers:' + code
      ).emit(
        'host:sound-ended'
      );
    }
  );


  // ==========================================================
  // TAB CLOSED
  // ==========================================================

  socket.on(
    'host:tab-closed',
    ({ tabId }) => {

      const code =
        socket.data.code;


      if (!code) {
        return;
      }


      io.to(
        'viewers:' + code
      ).emit(
        'host:tab-closed',
        {
          tabId
        }
      );
    }
  );


  // ==========================================================
  // HOST INFO
  // ==========================================================

  socket.on(
    'host:info',
    (info) => {

      const code =
        socket.data.code;


      if (!code) {
        return;
      }


      io.to(
        'viewers:' + code
      ).emit(
        'host:info',
        info
      );
    }
  );


  // ==========================================================
  // FILE TRANSFER
  // ==========================================================

  socket.on(
    'cmd:file-start',
    ({
      name,
      size,
      mimeType,
      totalChunks
    }) => {

      const session =
        sessions.get(
          socket.data.code
        );


      if (!session) {
        return;
      }


      if (
        size >
        50 * 1024 * 1024
      ) {

        socket.emit(
          'file:error',
          {
            message:
              'File too large (max 50MB).'
          }
        );

        return;
      }


      sendToHost(
        session,
        'cmd:file-start',
        {
          name,
          size,
          mimeType,
          totalChunks
        }
      );
    }
  );


  socket.on(
    'cmd:file-chunk',
    ({
      chunk,
      index
    }) => {

      const session =
        sessions.get(
          socket.data.code
        );


      if (!session) {
        return;
      }


      sendToHost(
        session,
        'cmd:file-chunk',
        {
          chunk,
          index
        }
      );
    }
  );


  socket.on(
    'cmd:file-end',
    () => {

      const session =
        sessions.get(
          socket.data.code
        );


      if (!session) {
        return;
      }


      sendToHost(
        session,
        'cmd:file-end'
      );
    }
  );


  socket.on(
    'host:file-received',
    ({ name }) => {

      const code =
        socket.data.code;


      if (!code) {
        return;
      }


      io.to(
        'viewers:' + code
      ).emit(
        'host:file-received',
        {
          name
        }
      );
    }
  );


  // ==========================================================
  // PUBLIC SESSION
  // ==========================================================

  socket.on(
    'host:set-public',
    ({
      isPublic,
      label
    }) => {

      const code =
        socket.data.code;


      const session =
        sessions.get(code);


      if (!session) {
        return;
      }


      session.public =
        !!isPublic;

      session.label =
        label || 'Anonymous';


      broadcastPublicList();


      console.log(
        'host',
        socket.id,
        'set public:',
        session.public,
        'label:',
        session.label
      );
    }
  );


  socket.on(
    'viewer:get-public',
    ({ name } = {}) => {

      const viewerName =
        setViewerName(socket, name);

      socket.emit(
        'public:list',
        buildPublicList(viewerName)
      );
    }
  );


  socket.on(
    'viewer:join-public',
    ({ code, name }) => {

      code =
        String(code || '');

      const viewerName =
        setViewerName(socket, name);


      const session =
        sessions.get(code);


      if (
        !session ||
        !session.public
      ) {

        socket.emit(
          'viewer:error',
          {
            message:
              'This broadcast is no longer public.'
          }
        );

        return;
      }


      if (
        session.allowedViewers &&
        !session.allowedViewers.has(
          viewerName.toLowerCase()
        )
      ) {

        socket.emit(
          'viewer:error',
          {
            message:
              'You are not authorized to view this broadcast.'
          }
        );

        console.log(
          'viewer',
          viewerName || '(unnamed)',
          'denied (not on allow list) for public code',
          code
        );

        return;
      }


      session.viewers.add(
        socket.id
      );


      socket.join(
        'viewers:' + code
      );


      socket.data.role =
        'viewer';

      socket.data.code =
        code;

      socket.data.hostId =
        session.hostId;


      sendToHost(
        session,
        'viewer:joined',
        {
          viewerId:
            socket.id
        }
      );


      socket.emit(
        'viewer:ok',
        {
          hostId:
            session.hostId
        }
      );


      broadcastPublicList();
    }
  );


  // ==========================================================
  // PING
  // ==========================================================

  socket.on(
    'ping',
    () => {
      socket.emit(
        'pong'
      );
    }
  );


  // ==========================================================
  // DISCONNECT
  // ==========================================================

  socket.on(
    'disconnect',
    () => {

      const {
        role,
        code
      } = socket.data || {};


      if (!code) {
        return;
      }


      // ========================================================
      // HOST DISCONNECT
      // ========================================================

      if (
        role === 'host'
      ) {

        const session =
          sessions.get(code);


        if (!session) {
          return;
        }


        // Only the current host is allowed
        // to start the deletion timer.
        if (
          session.hostId !==
          socket.id
        ) {
          return;
        }


        // Mark host as disconnected.
        session.hostId =
          null;


        io.to(
          'viewers:' + code
        ).emit(
          'host:disconnected'
        );


        broadcastPublicList();


        console.log(
          'host disconnected, session',
          code,
          'will be deleted in 10 seconds'
        );


        // Delete session after 10 seconds
        // if the host hasn't returned.
        session.disconnectTimer =
          setTimeout(
            () => {

              const currentSession =
                sessions.get(code);


              if (!currentSession) {
                return;
              }


              // Host reconnected.
              if (
                currentSession.hostId
              ) {

                currentSession.disconnectTimer =
                  null;

                console.log(
                  'host returned before session deletion:',
                  code
                );

                return;
              }


              sessions.delete(
                code
              );


              io.to(
                'viewers:' + code
              ).emit(
                'session:expired'
              );


              broadcastPublicList();


              console.log(
                'session deleted after 10 second host disconnect:',
                code
              );

            },
            10000
          );


        return;
      }


      // ========================================================
      // VIEWER DISCONNECT
      // ========================================================

      if (
        role === 'viewer'
      ) {

        const session =
          sessions.get(code);


        if (!session) {
          return;
        }


        session.viewers.delete(
          socket.id
        );


        sendToHost(
          session,
          'viewer:left',
          {
            viewerId:
              socket.id
          }
        );


        broadcastPublicList();


        console.log(
          'viewer disconnected from session',
          code,
          socket.id
        );
      }
    }
  );
});


// ============================================================
// SERVER
// ============================================================

const PORT =
  process.env.PORT || 3000;

server.listen(
  PORT,
  () => {
    console.log(
      `ScreenLink running on port ${PORT}`
    );
  }
);
