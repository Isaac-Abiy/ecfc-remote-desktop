// ============================================================================
// ECFC Remote Desktop — Signaling Server (MVP)
// ----------------------------------------------------------------------------
// A Node.js WebSocket server that pairs a Windows host agent with a remote
// client (browser). It never interprets the screen/input payloads — it just
// relays JSON messages between the one host and its one active client.
//
// Run:  npm install && npm start
// Env:  PORT (default 8080), PAIRING_SECRET (default 'ecfc-pair-123')
// ============================================================================

'use strict';

const http = require('http');
const { WebSocketServer } = require('ws');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT, 10) || 8080;
const PAIRING_SECRET = process.env.PAIRING_SECRET || 'ecfc-pair-123';

// MVP auth: hardcoded users. (Replace with a real DB + password hashing later.)
const USERS = { isaac: 'password123' };

// A session dies after this long with no input event from the client.
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// ---------------------------------------------------------------------------
// Tiny access log: timestamped console lines. This is the MVP audit trail.
// ---------------------------------------------------------------------------
function log(...args) {
  const ts = new Date().toISOString();
  console.log(`[${ts}]`, ...args);
}

// ---------------------------------------------------------------------------
// In-memory state
//
// hosts:   Map computerId -> { ws, name, client: clientState|null }
//            One host registration per computerId; re-register replaces it.
//
// A clientState: { ws, computerId, username, idleTimer, lastInputAt }
// A host entry holds a back-pointer to its connected client (max one).
// ---------------------------------------------------------------------------
const hosts = new Map();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// Clear + restart the idle timer for a session. Fires when the client sends
// no input events for IDLE_TIMEOUT_MS.
function resetIdleTimer(hostEntry) {
  const client = hostEntry && hostEntry.client;
  if (!client) return;
  if (client.idleTimer) clearTimeout(client.idleTimer);
  client.idleTimer = setTimeout(() => {
    const { computerId, username } = client;
    log(`idle-timeout: disconnecting client '${username}' from '${computerId}' (30m no input)`);
    send(client.ws, { type: 'idle_timeout' });
    send(hostEntry.ws, { type: 'idle_timeout' });
    detachClient(hostEntry, 'idle timeout');
  }, IDLE_TIMEOUT_MS);
  // Don't keep the process alive for this timer alone.
  if (client.idleTimer.unref) client.idleTimer.unref();
}

// Cleanly detach the current client from a host entry and notify the host.
function detachClient(hostEntry, reason) {
  const client = hostEntry.client;
  if (!client) return;
  if (client.idleTimer) clearTimeout(client.idleTimer);
  hostEntry.client = null;
  log(`client-disconnected: '${client.username}' left '${hostEntry.computerId}' (${reason})`);
  send(hostEntry.ws, { type: 'client_disconnected' });
}

// Parse one incoming text frame; returns null on bad JSON.
function parseJson(text) {
  try {
    const msg = JSON.parse(text);
    return msg && typeof msg === 'object' ? msg : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Host message handling
// ---------------------------------------------------------------------------
function handleHostMessage(hostEntry, msg) {
  const ws = hostEntry.ws;

  // Hosts register first: { type:'register', computerId, name, secret }
  if (msg.type === 'register') {
    const computerId = String(msg.computerId || '').trim().toUpperCase();
    const name = String(msg.name || 'Unnamed PC').slice(0, 80);
    if (!computerId) {
      send(ws, { type: 'error', message: 'register: computerId is required' });
      return;
    }
    if (msg.secret !== PAIRING_SECRET) {
      log(`host-register REJECTED: wrong pairing secret for '${computerId}'`);
      send(ws, { type: 'error', message: 'register: bad pairing secret' });
      return;
    }
    // Replace any previous registration for this computerId (old one is gone).
    const prev = hosts.get(computerId);
    if (prev && prev !== hostEntry && prev.ws.readyState === prev.ws.OPEN) {
      log(`host-register: replacing stale registration for '${computerId}'`);
      try { prev.ws.close(4000, 'replaced by new registration'); } catch { /* ignore */ }
      if (prev.client) detachClient(prev, 'host re-registered');
    }
    hostEntry.computerId = computerId;
    hostEntry.name = name;
    hosts.set(computerId, hostEntry);
    log(`host-registered: '${name}' as '${computerId}'`);
    send(ws, { type: 'registered', computerId });
    return;
  }

  // Unregistered hosts can't do anything else.
  if (!hostEntry.computerId) {
    send(ws, { type: 'error', message: 'send register first' });
    return;
  }

  switch (msg.type) {
    // Screen frame → forward to the paired client.
    case 'frame':
      if (hostEntry.client && typeof msg.data === 'string') {
        send(hostEntry.client.ws, { type: 'frame', data: msg.data });
      }
      break;

    // Host says it's going away on purpose.
    case 'bye':
      log(`host-bye: '${hostEntry.computerId}' signing off`);
      cleanupHost(hostEntry);
      break;

    default:
      // Unknown host message types are ignored (forward-compat).
      break;
  }
}

// Remove a host registration; tell its client the host went offline.
function cleanupHost(hostEntry) {
  if (hostEntry.computerId && hosts.get(hostEntry.computerId) === hostEntry) {
    hosts.delete(hostEntry.computerId);
  }
  if (hostEntry.client) {
    const client = hostEntry.client;
    if (client.idleTimer) clearTimeout(client.idleTimer);
    send(client.ws, { type: 'host_offline' });
    try { client.ws.close(4001, 'host offline'); } catch { /* ignore */ }
    hostEntry.client = null;
    log(`host-offline: '${hostEntry.computerId || 'unknown'}' disconnected; client '${client.username}' notified`);
  } else if (hostEntry.computerId) {
    log(`host-offline: '${hostEntry.computerId}' disconnected (no client attached)`);
  }
  hostEntry.computerId = null;
}

// ---------------------------------------------------------------------------
// Client message handling
// ---------------------------------------------------------------------------
function handleClientMessage(clientState, msg) {
  const ws = clientState.ws;

  // Step 1 — auth is required before anything else.
  if (msg.type === 'auth') {
    const username = String(msg.username || '');
    const password = String(msg.password || '');
    if (USERS[username] && USERS[username] === password) {
      clientState.username = username;
      clientState.authed = true;
      log(`client-auth OK: '${username}'`);
      send(ws, { type: 'auth_ok' });
    } else {
      log(`client-auth FAILED for username '${username || '(blank)'}'`);
      send(ws, { type: 'auth_error', message: 'Invalid username or password' });
    }
    return;
  }

  if (!clientState.authed) {
    send(ws, { type: 'auth_error', message: 'Authenticate first' });
    return;
  }

  switch (msg.type) {
    // Ask for online/offline status of a computer (no pairing yet).
    case 'status': {
      const computerId = String(msg.computerId || '').trim().toUpperCase();
      const hostEntry = hosts.get(computerId);
      const online = !!hostEntry && hostEntry.ws.readyState === hostEntry.ws.OPEN;
      send(ws, { type: 'status', computerId, online });
      break;
    }

    // Pair with a host: { type:'connect', computerId }
    case 'connect': {
      const computerId = String(msg.computerId || '').trim().toUpperCase();
      const hostEntry = hosts.get(computerId);
      if (!hostEntry || hostEntry.ws.readyState !== hostEntry.ws.OPEN) {
        send(ws, { type: 'status', computerId, online: false });
        return;
      }
      if (hostEntry.client) {
        log(`client-connect REJECTED (busy): '${clientState.username}' → '${computerId}'`);
        send(ws, { type: 'busy' });
        return;
      }
      // Pair them.
      clientState.computerId = computerId;
      hostEntry.client = clientState;
      log(`client-connected: '${clientState.username}' → '${computerId}' (${hostEntry.name})`);
      send(ws, { type: 'connected', computerId, name: hostEntry.name });
      send(hostEntry.ws, { type: 'client_connected' });
      resetIdleTimer(hostEntry);
      break;
    }

    // Input events → relay to host, and count as activity for idle timeout.
    case 'input': {
      const hostEntry = clientState.computerId ? hosts.get(clientState.computerId) : null;
      if (!hostEntry || hostEntry.client !== clientState) {
        send(ws, { type: 'error', message: 'not connected to a host' });
        return;
      }
      clientState.lastInputAt = Date.now();
      resetIdleTimer(hostEntry); // any input resets the 30-minute clock
      // Forward the whole input payload (action: move|click|key|scroll, ...).
      send(hostEntry.ws, msg);
      break;
    }

    // Client ends the session on purpose.
    case 'disconnect': {
      const hostEntry = clientState.computerId ? hosts.get(clientState.computerId) : null;
      if (hostEntry && hostEntry.client === clientState) {
        detachClient(hostEntry, 'client requested disconnect');
      }
      clientState.computerId = null;
      send(ws, { type: 'disconnected' });
      break;
    }

    default:
      // Unknown client message types are ignored (forward-compat).
      break;
  }
}

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  // Tiny health endpoint so uptime checks / load balancers get a 200.
  if (req.url === '/health') {
    const online = [...hosts.values()].filter(
      (h) => h.ws.readyState === h.ws.OPEN
    ).length;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, hostsOnline: online }));
    return;
  }
  res.writeHead(404);
  res.end('ECFC Remote Desktop signaling server');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  // We don't know yet if this socket is a host or a client — the first
  // meaningful message decides. Track both possibilities, use one.
  const peer = {
    kind: null, // 'host' | 'client'
    hostEntry: { ws, computerId: null, name: null, client: null },
    clientState: { ws, username: null, authed: false, computerId: null, idleTimer: null, lastInputAt: null },
  };

  ws.on('message', (raw) => {
    const msg = parseJson(raw.toString());
    if (!msg || typeof msg.type !== 'string') {
      send(ws, { type: 'error', message: 'invalid JSON message' });
      return;
    }

    // First message declares the role.
    if (!peer.kind) {
      if (msg.type === 'register') {
        peer.kind = 'host';
        handleHostMessage(peer.hostEntry, msg);
      } else if (msg.type === 'auth') {
        peer.kind = 'client';
        handleClientMessage(peer.clientState, msg);
      } else {
        send(ws, { type: 'error', message: "first message must be 'register' (host) or 'auth' (client)" });
      }
      return;
    }

    if (peer.kind === 'host') handleHostMessage(peer.hostEntry, msg);
    else handleClientMessage(peer.clientState, msg);
  });

  ws.on('close', () => {
    if (peer.kind === 'host') {
      cleanupHost(peer.hostEntry);
    } else if (peer.kind === 'client') {
      const st = peer.clientState;
      const hostEntry = st.computerId ? hosts.get(st.computerId) : null;
      if (hostEntry && hostEntry.client === st) {
        detachClient(hostEntry, 'socket closed');
      } else if (st.username) {
        log(`client-disconnected: '${st.username}' (socket closed, no active session)`);
      }
      if (st.idleTimer) clearTimeout(st.idleTimer);
    }
    // else: socket closed before declaring a role — nothing to clean up.
  });

  ws.on('error', () => {
    // 'close' will follow; nothing extra to do here.
  });
});

server.listen(PORT, () => {
  log(`ECFC Remote Desktop signaling server listening on port ${PORT}`);
  log(`Pairing secret ${PAIRING_SECRET === 'ecfc-pair-123' ? '(default — set PAIRING_SECRET in production!)' : 'loaded from env'}`);
});

// Graceful shutdown: tell everyone we're going away.
function shutdown() {
  log('shutting down...');
  for (const [, hostEntry] of hosts) {
    try { hostEntry.ws.close(4002, 'server shutting down'); } catch { /* ignore */ }
    if (hostEntry.client) {
      try { hostEntry.client.ws.close(4002, 'server shutting down'); } catch { /* ignore */ }
    }
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
