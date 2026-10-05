// ============================================================================
// ECFC Remote Desktop — Signaling Server
// ----------------------------------------------------------------------------
// A Node.js WebSocket server that pairs a Windows host agent with remote
// clients (browsers). It never interprets the screen/input payloads — it just
// relays JSON messages between the one host and its attached clients.
// Multiple clients may attach to (and control) the same computer at once;
// each client gets its own session and its own idle timer.
//
// Accounts live in Supabase (rd_users): email + bcrypt password hash, with
// optional TOTP two-factor auth (Google Authenticator style). Registered PCs
// live in rd_computers with a per-computer pairing secret. Every remote
// session is written to rd_sessions (the access log).
//
// Run:  npm install && npm start
// Env:  PORT (default 8080)
//       SUPABASE_URL, SUPABASE_SERVICE_KEY  (required for auth/pairing)
//       MYDESK_API_KEY                     (sends the password-reset email via
//                                           the MyDesk MCP Gmail API; without it,
//                                           reset codes are created but can't be emailed)
//       MYDESK_MCP_URL                     (optional override, defaults to the
//                                           MyDesk site's /api/mcp endpoint)
// ============================================================================

'use strict';

const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const bcrypt = require('bcryptjs');
const { authenticator } = require('otplib');
const { createClient } = require('@supabase/supabase-js');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT, 10) || 8080;
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

// A session dies after this long with no input event from the client.
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// Forgot-password: reset codes are 6 digits, good for 15 minutes, single-use.
// Email goes out through Isaac's MyDesk MCP Gmail API (key kept server-side).
const RESET_CODE_TTL_MS = 15 * 60 * 1000;
const RESET_MAX_PER_HOUR = 10; // codes per account per hour (rate limit)
const RESET_MAX_ATTEMPTS = 5;  // wrong-code guesses before a code dies
const MYDESK_API_KEY = process.env.MYDESK_API_KEY || '';
const MYDESK_MCP_URL = process.env.MYDESK_MCP_URL ||
  'https://mydesk-calendar-mail.vercel.app/api/mcp';

// Allow one step of clock skew on TOTP codes (30s before/after).
authenticator.options = { window: 1 };

// ---------------------------------------------------------------------------
// Supabase (service-role key: bypasses RLS; never expose it to clients)
// ---------------------------------------------------------------------------
let supabase = null;
const dbReady = Boolean(SUPABASE_URL && SUPABASE_SERVICE_KEY);
if (dbReady) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
} else {
  console.error('[FATAL] SUPABASE_URL and SUPABASE_SERVICE_KEY are not both set.');
  console.error('        Auth, pairing and the access log are DISABLED until they are.');
}

// ---------------------------------------------------------------------------
// Tiny access log: timestamped console lines (plus rd_sessions in Supabase).
// ---------------------------------------------------------------------------
function log(...args) {
  const ts = new Date().toISOString();
  console.log(`[${ts}]`, ...args);
}

// ---------------------------------------------------------------------------
// In-memory state
//
// hosts:   Map computerId -> hostEntry
//            { ws, computerId, name, viewOnly, db: {id, owner_id} | null,
//              clients: Map<cid, clientState>, fileRequester: clientState | null }
//
// A clientState: { cid, ws, authed, userId, email, computerId, sessionId,
//                  idleTimer, lastInputAt }
// ---------------------------------------------------------------------------
const hosts = new Map();

// Unique id per client socket (used as the key in hostEntry.clients).
let nextClientSeq = 1;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function parseJson(text) {
  try {
    const msg = JSON.parse(text);
    return msg && typeof msg === 'object' ? msg : null;
  } catch {
    return null;
  }
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function normComputerId(v) {
  return String(v || '').trim().toUpperCase();
}

// ---------------------------------------------------------------------------
// Forgot-password helpers
// ---------------------------------------------------------------------------
function sha256Hex(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}

// A 6-digit code, crypto-random (never Math.random for security codes).
function randResetCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

// Persistent login ("remember me") tokens: issued after a full sign-in
// (password, plus 2FA when enabled), stored as SHA-256 hashes so a DB leak
// never exposes a usable token. Long-lived so a refresh never logs anyone
// out; revoked automatically on any password change/reset.
const AUTH_TOKEN_TTL_MS = 365 * 24 * 3600 * 1000; // 1 year
function randAuthToken() {
  return crypto.randomBytes(32).toString('hex');
}
async function issueAuthToken(userId) {
  const token = randAuthToken();
  const { error } = await supabase.from('rd_auth_tokens').insert({
    user_id: userId,
    token_hash: sha256Hex(token),
    expires_at: new Date(Date.now() + AUTH_TOKEN_TTL_MS).toISOString(),
  });
  if (error) throw error;
  return token;
}
async function revokeAuthTokens(userId) {
  const { error } = await supabase.from('rd_auth_tokens').delete().eq('user_id', userId);
  if (error) log('db: revoke auth tokens failed:', error.message);
}

// Send the reset code through the MyDesk MCP Gmail API (JSON-RPC tools/call).
// Throws on any failure; callers log it and still answer the client the same
// way so a mail hiccup never reveals account/config state.
async function sendResetEmail(to, code) {
  if (!MYDESK_API_KEY) throw new Error('MYDESK_API_KEY is not set');
  const minutes = Math.round(RESET_CODE_TTL_MS / 60000);
  const res = await fetch(MYDESK_MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + MYDESK_API_KEY,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: {
        name: 'gmail_send',
        arguments: {
          to,
          subject: 'ECFC Remote Desktop - password reset code',
          body:
            'Hi!\n\n' +
            'Someone asked to reset the password for your ECFC Remote Desktop account.\n\n' +
            'Your reset code is: ' + code + '\n\n' +
            'Enter it in the app within ' + minutes + ' minutes to choose a new password.\n\n' +
            "If this wasn't you, just ignore this email - your password stays the same.\n\n" +
            '- ECFC Remote Desktop',
        },
      },
    }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  if (data && data.error) throw new Error(data.error.message || 'JSON-RPC error');
  if (data && data.result && data.result.isError) {
    const t = data.result.content && data.result.content[0] && data.result.content[0].text;
    throw new Error(t || 'mail tool error');
  }
}

// ---------------------------------------------------------------------------
// Session bookkeeping (Supabase rd_sessions)
// ---------------------------------------------------------------------------
async function openSession(userId, computerId) {
  if (!dbReady) return null;
  try {
    const { data, error } = await supabase
      .from('rd_sessions')
      .insert({ user_id: userId, computer_id: computerId })
      .select('id')
      .single();
    if (error) throw error;
    return data.id;
  } catch (e) {
    log('db: openSession failed:', e.message);
    return null;
  }
}

async function closeSession(sessionId) {
  if (!dbReady || !sessionId) return;
  try {
    const { error } = await supabase
      .from('rd_sessions')
      .update({ ended_at: new Date().toISOString() })
      .eq('id', sessionId);
    if (error) throw error;
  } catch (e) {
    log('db: closeSession failed:', e.message);
  }
}

// ---------------------------------------------------------------------------
// Pairing: attach / detach a client to a host
// ---------------------------------------------------------------------------
async function attachClient(hostEntry, clientState, dbComputer) {
  const { computerId } = hostEntry;

  // First client to reach an unclaimed computer becomes its owner.
  if (dbComputer && !dbComputer.owner_id) {
    try {
      const { error } = await supabase
        .from('rd_computers')
        .update({ owner_id: clientState.userId })
        .eq('id', dbComputer.id);
      if (error) throw error;
      dbComputer.owner_id = clientState.userId;
      hostEntry.db = dbComputer;
      log(`pairing: computer '${computerId}' claimed by '${clientState.email}'`);
    } catch (e) {
      log('db: claim computer failed:', e.message);
    }
  }

  // Already attached (e.g. double 'connect')? Just confirm, don't duplicate.
  if (hostEntry.clients.has(clientState.cid)) {
    send(clientState.ws, { type: 'connected', computerId, name: hostEntry.name, viewOnly: !!hostEntry.viewOnly });
    return;
  }

  clientState.computerId = computerId;
  hostEntry.clients.set(clientState.cid, clientState);
  const nClients = hostEntry.clients.size;
  log(`client-connected: '${clientState.email}' → '${computerId}' (${hostEntry.name}) [${nClients} attached]`);

  // Access log: one row per client session.
  clientState.sessionId = await openSession(clientState.userId, computerId);

  send(clientState.ws, { type: 'connected', computerId, name: hostEntry.name, viewOnly: !!hostEntry.viewOnly });
  // The host only tracks "any client?" — notify it on the first attach.
  if (nClients === 1) send(hostEntry.ws, { type: 'client_connected' });
  resetIdleTimer(hostEntry, clientState);
}

// Cleanly detach one client from a host entry: end its DB session row,
// stop its idle timer, and notify the host only when the last client leaves.
async function detachClient(hostEntry, clientState, reason) {
  const client = hostEntry.clients.get(clientState.cid);
  if (!client) return;
  if (client.idleTimer) clearTimeout(client.idleTimer);
  await closeSession(client.sessionId);
  client.sessionId = null;
  hostEntry.clients.delete(client.cid);
  if (hostEntry.fileRequester === client) hostEntry.fileRequester = null;
  const nLeft = hostEntry.clients.size;
  log(`client-disconnected: '${client.email}' left '${hostEntry.computerId}' (${reason}) [${nLeft} left]`);
  // Only the last detach tells the host to stop streaming.
  if (nLeft === 0) send(hostEntry.ws, { type: 'client_disconnected' });
}

// Clear + restart one client's idle timer. Fires when that client sends
// no input events for IDLE_TIMEOUT_MS.
function resetIdleTimer(hostEntry, clientState) {
  const client = hostEntry.clients.get(clientState.cid);
  if (!client) return;
  if (client.idleTimer) clearTimeout(client.idleTimer);
  client.idleTimer = setTimeout(async () => {
    log(`idle-timeout: disconnecting '${client.email}' from '${client.computerId}' (30m no input)`);
    send(client.ws, { type: 'idle_timeout' });
    // detachClient notifies the host only when the last client leaves.
    await detachClient(hostEntry, client, 'idle timeout').catch((e) => {
      log('idle-timeout detach error:', e.message);
    });
  }, IDLE_TIMEOUT_MS);
  // Don't keep the process alive for this timer alone.
  if (client.idleTimer.unref) client.idleTimer.unref();
}

// ---------------------------------------------------------------------------
// Host message handling
// ---------------------------------------------------------------------------
async function handleHostMessage(hostEntry, msg) {
  const ws = hostEntry.ws;

  // Hosts register first: { type:'register', computerId, name, pairingSecret }
  if (msg.type === 'register') {
    const computerId = normComputerId(msg.computerId);
    const name = String(msg.name || 'Unnamed PC').slice(0, 80);
    const pairingSecret = String(msg.pairingSecret || msg.secret || '');
    if (!computerId) {
      send(ws, { type: 'error', message: 'register: computerId is required' });
      return;
    }
    if (!dbReady) {
      send(ws, { type: 'error', message: 'register: server database not configured' });
      return;
    }
    if (!pairingSecret) {
      send(ws, { type: 'error', message: 'register: pairingSecret is required' });
      return;
    }

    // Look the computer up; verify its secret, or create the row on first sight.
    let dbComputer = null;
    try {
      const { data, error } = await supabase
        .from('rd_computers')
        .select('id, owner_id, pairing_secret')
        .eq('computer_id', computerId)
        .maybeSingle();
      if (error) throw error;
      if (data) {
        if (data.pairing_secret !== pairingSecret) {
          log(`host-register REJECTED: wrong pairing secret for '${computerId}'`);
          send(ws, { type: 'error', message: 'register: bad pairing secret' });
          return;
        }
        dbComputer = data;
      } else {
        const { data: created, error: insErr } = await supabase
          .from('rd_computers')
          .insert({ computer_id: computerId, name, owner_id: null, pairing_secret: pairingSecret })
          .select('id, owner_id, pairing_secret')
          .single();
        if (insErr) throw insErr;
        dbComputer = created;
        log(`host-register: new computer row created for '${computerId}'`);
      }
    } catch (e) {
      log('db: register lookup failed:', e.message);
      send(ws, { type: 'error', message: 'register: database error, try again' });
      return;
    }

    // Replace any previous registration for this computerId (old one is gone).
    const prev = hosts.get(computerId);
    if (prev && prev !== hostEntry && prev.ws.readyState === prev.ws.OPEN) {
      log(`host-register: replacing stale registration for '${computerId}'`);
      try { prev.ws.close(4000, 'replaced by new registration'); } catch { /* ignore */ }
      for (const [, c] of [...prev.clients]) await detachClient(prev, c, 'host re-registered');
    }
    hostEntry.computerId = computerId;
    hostEntry.name = name;
    hostEntry.db = dbComputer;
    hostEntry.viewOnly = msg.viewOnly === true; // browser "Share this PC" hosts
    hosts.set(computerId, hostEntry);
    log(`host-registered: '${name}' as '${computerId}'${hostEntry.viewOnly ? ' [view-only browser host]' : ''}`);
    send(ws, { type: 'registered', computerId });
    return;
  }

  // Unregistered hosts can't do anything else.
  if (!hostEntry.computerId) {
    send(ws, { type: 'error', message: 'send register first' });
    return;
  }

  switch (msg.type) {
    // Screen frame → broadcast to every attached client.
    case 'frame':
      if (typeof msg.data === 'string') {
        for (const [, c] of hostEntry.clients) {
          send(c.ws, { type: 'frame', data: msg.data });
        }
      }
      break;

    // File transfer replies → route to the requesting client when known,
    // otherwise broadcast to everyone attached.
    case 'file_ack':
    case 'file_error':
    case 'file_done':
    case 'file_list':
    case 'dl_start':
    case 'dl_chunk':
    case 'dl_end':
    case 'file_deleted':
    case 'file_renamed': {
      // Chunk payloads must be strings, like frames.
      if (msg.type === 'dl_chunk' && typeof msg.data !== 'string') break;
      const req = hostEntry.fileRequester;
      const targets = (req && hostEntry.clients.has(req.cid))
        ? [req]
        : [...hostEntry.clients.values()];
      for (const c of targets) send(c.ws, msg);
      // The operation is over once the final reply goes out.
      if (msg.type === 'file_done' || msg.type === 'dl_end' || msg.type === 'file_error') {
        hostEntry.fileRequester = null;
      }
      break;
    }

    // Host says it's going away on purpose.
    case 'bye':
      log(`host-bye: '${hostEntry.computerId}' signing off`);
      await cleanupHost(hostEntry);
      break;

    default:
      // Unknown host message types are ignored (forward-compat).
      break;
  }
}

// Remove a host registration; tell all its clients the host went offline.
async function cleanupHost(hostEntry) {
  if (hostEntry.computerId && hosts.get(hostEntry.computerId) === hostEntry) {
    hosts.delete(hostEntry.computerId);
  }
  const clients = [...hostEntry.clients.values()];
  hostEntry.clients.clear();
  hostEntry.fileRequester = null;
  for (const client of clients) {
    if (client.idleTimer) clearTimeout(client.idleTimer);
    await closeSession(client.sessionId);
    send(client.ws, { type: 'host_offline' });
    try { client.ws.close(4001, 'host offline'); } catch { /* ignore */ }
  }
  if (clients.length) {
    log(`host-offline: '${hostEntry.computerId || 'unknown'}' disconnected; ${clients.length} client(s) notified`);
  } else if (hostEntry.computerId) {
    log(`host-offline: '${hostEntry.computerId}' disconnected (no client attached)`);
  }
  hostEntry.computerId = null;
  hostEntry.db = null;
  hostEntry.viewOnly = false;
}

// ---------------------------------------------------------------------------
// Client message handling
// ---------------------------------------------------------------------------
async function handleClientMessage(clientState, msg) {
  const ws = clientState.ws;

  // Ping works even before auth (lets the client measure latency any time).
  if (msg.type === 'ping') {
    send(ws, { type: 'pong', t: msg.t });
    return;
  }

  // Step 1 — sign up: { type:'signup', email, password }
  if (msg.type === 'signup') {
    if (!dbReady) {
      send(ws, { type: 'auth_error', message: 'Server database not configured' });
      return;
    }
    const email = String(msg.email || '').trim().toLowerCase();
    const password = String(msg.password || '');
    if (!validEmail(email)) {
      send(ws, { type: 'auth_error', message: 'Enter a valid email address' });
      return;
    }
    if (password.length < 8) {
      send(ws, { type: 'auth_error', message: 'Password must be at least 8 characters' });
      return;
    }
    try {
      const passHash = await bcrypt.hash(password, 10);
      const { data, error } = await supabase
        .from('rd_users')
        .insert({ email, pass_hash: passHash })
        .select('id')
        .single();
      if (error) {
        if (error.code === '23505') { // unique violation on email
          send(ws, { type: 'auth_error', message: 'That email is already registered — try signing in' });
        } else {
          throw error;
        }
        return;
      }
      clientState.authed = true;
      clientState.userId = data.id;
      clientState.email = email;
      log(`client-signup OK: '${email}'`);
      send(ws, { type: 'auth_ok', userId: data.id });
    } catch (e) {
      log('db: signup failed:', e.message);
      send(ws, { type: 'auth_error', message: 'Signup failed — try again' });
    }
    return;
  }

  // Step 1 — sign in: { type:'auth', email, password }
  // (also accepts 'username' for the old MVP client)
  // Resume a remembered session: { type:'auth_token', token }.
  // The token is only ever issued after a full password (+2FA) sign-in.
  if (msg.type === 'auth_token') {
    if (!dbReady) {
      send(ws, { type: 'auth_error', message: 'Server database not configured' });
      return;
    }
    const token = String(msg.token || '').trim();
    try {
      let user = null;
      if (/^[0-9a-f]{64}$/i.test(token)) {
        const { data: row, error } = await supabase
          .from('rd_auth_tokens')
          .select('user_id, expires_at')
          .eq('token_hash', sha256Hex(token.toLowerCase()))
          .maybeSingle();
        if (error) throw error;
        if (row && new Date(row.expires_at) > new Date()) {
          const { data: u, error: uErr } = await supabase
            .from('rd_users')
            .select('id, email')
            .eq('id', row.user_id)
            .maybeSingle();
          if (uErr) throw uErr;
          user = u;
        }
      }
      if (!user) {
        send(ws, { type: 'auth_error', message: 'Session expired — please sign in again' });
        return;
      }
      // Sliding expiry: each successful resume extends the session.
      await supabase
        .from('rd_auth_tokens')
        .update({ expires_at: new Date(Date.now() + AUTH_TOKEN_TTL_MS).toISOString() })
        .eq('token_hash', sha256Hex(token.toLowerCase()));
      clientState.authed = true;
      clientState.userId = user.id;
      clientState.email = user.email;
      log(`client-auth OK (token): '${user.email}'`);
      send(ws, { type: 'auth_ok', userId: user.id, email: user.email });
    } catch (e) {
      log('db: auth_token failed:', e.message);
      send(ws, { type: 'auth_error', message: 'Sign-in failed — try again' });
    }
    return;
  }

  if (msg.type === 'auth') {
    if (!dbReady) {
      send(ws, { type: 'auth_error', message: 'Server database not configured' });
      return;
    }
    const email = String(msg.email || msg.username || '').trim().toLowerCase();
    const password = String(msg.password || '');
    try {
      const { data: user, error } = await supabase
        .from('rd_users')
        .select('id, email, pass_hash, totp_enabled')
        .eq('email', email)
        .maybeSingle();
      if (error) throw error;
      const ok = user && await bcrypt.compare(password, user.pass_hash);
      if (!ok) {
        log(`client-auth FAILED for '${email || '(blank)'}`);
        send(ws, { type: 'auth_error', message: 'Invalid email or password' });
        return;
      }
      if (user.totp_enabled) {
        // Password was right — now they must finish the second factor.
        clientState.pending2fa = user.id;
        log(`client-auth: '${email}' passed password, awaiting 2FA`);
        send(ws, { type: 'need_2fa', userId: user.id });
        return;
      }
      clientState.authed = true;
      clientState.userId = user.id;
      clientState.email = user.email;
      log(`client-auth OK: '${user.email}'`);
      const token = await issueAuthToken(user.id);
      send(ws, { type: 'auth_ok', userId: user.id, email: user.email, token });
    } catch (e) {
      log('db: auth failed:', e.message);
      send(ws, { type: 'auth_error', message: 'Sign-in failed — try again' });
    }
    return;
  }

  // Step 2 of sign-in when 2FA is on: { type:'verify_2fa', userId, token }
  if (msg.type === 'verify_2fa') {
    if (!dbReady) {
      send(ws, { type: 'auth_error', message: 'Server database not configured' });
      return;
    }
    const userId = String(msg.userId || '');
    const token = String(msg.token || '').replace(/\s/g, '');
    if (clientState.pending2fa && clientState.pending2fa !== userId) {
      send(ws, { type: 'auth_error', message: 'Start sign-in again' });
      return;
    }
    try {
      const { data: user, error } = await supabase
        .from('rd_users')
        .select('id, email, totp_secret, totp_enabled')
        .eq('id', userId)
        .maybeSingle();
      if (error) throw error;
      const valid = user && user.totp_enabled && user.totp_secret &&
        authenticator.verify({ token, secret: user.totp_secret });
      if (!valid) {
        log(`client-2fa FAILED for user '${userId}'`);
        send(ws, { type: 'auth_error', message: 'Invalid code — try again' });
        return;
      }
      clientState.pending2fa = null;
      clientState.authed = true;
      clientState.userId = user.id;
      clientState.email = user.email;
      log(`client-2fa OK: '${user.email}'`);
      const token = await issueAuthToken(user.id);
      send(ws, { type: 'auth_ok', userId: user.id, email: user.email, token });
    } catch (e) {
      log('db: verify_2fa failed:', e.message);
      send(ws, { type: 'auth_error', message: 'Verification failed — try again' });
    }
    return;
  }

  // --- Forgot password (pre-auth) ---

  // Step 1: { type:'request_reset', email }
  // Always answers { type:'reset_sent' } — never reveals whether the email
  // is registered, so nobody can probe the account list.
  if (msg.type === 'request_reset') {
    if (!dbReady) {
      send(ws, { type: 'auth_error', message: 'Server database not configured' });
      return;
    }
    const email = String(msg.email || '').trim().toLowerCase();
    const done = () => send(ws, { type: 'reset_sent' });
    if (!validEmail(email)) { done(); return; }
    try {
      const { data: user, error } = await supabase
        .from('rd_users')
        .select('id')
        .eq('email', email)
        .maybeSingle();
      if (error) throw error;
      if (user) {
        // Rate limit: only a few codes per account per hour.
        const hourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
        const { count, error: cntErr } = await supabase
          .from('rd_password_resets')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', user.id)
          .gte('created_at', hourAgo);
        if (cntErr) throw cntErr;
        if ((count || 0) < RESET_MAX_PER_HOUR) {
          // Kill any older unused codes — only the newest one works.
          await supabase
            .from('rd_password_resets')
            .update({ used: true })
            .eq('user_id', user.id)
            .eq('used', false);
          const code = randResetCode();
          const { error: insErr } = await supabase
            .from('rd_password_resets')
            .insert({
              user_id: user.id,
              code_hash: sha256Hex(code), // the plain code is NEVER stored
              expires_at: new Date(Date.now() + RESET_CODE_TTL_MS).toISOString(),
            });
          if (insErr) throw insErr;
          log(`client-reset: code issued for '${email}'`);
          try {
            await sendResetEmail(email, code);
          } catch (e) {
            log('client-reset: email failed:', e.message);
          }
        } else {
          log(`client-reset: rate-limited '${email}'`);
        }
      }
      done();
    } catch (e) {
      log('db: request_reset failed:', e.message);
      done(); // still answer the same way — don't leak DB state
    }
    return;
  }

  // Step 2: { type:'reset_password', email, code, password }
  if (msg.type === 'reset_password') {
    if (!dbReady) {
      send(ws, { type: 'auth_error', message: 'Server database not configured' });
      return;
    }
    const email = String(msg.email || '').trim().toLowerCase();
    const code = String(msg.code || '').replace(/\D/g, '');
    const password = String(msg.password || '');
    const bad = () => send(ws, { type: 'auth_error', message: 'Invalid or expired code — request a new one' });
    if (password.length < 8) {
      send(ws, { type: 'auth_error', message: 'Password must be at least 8 characters' });
      return;
    }
    try {
      const { data: user, error } = await supabase
        .from('rd_users')
        .select('id')
        .eq('email', email)
        .maybeSingle();
      if (error) throw error;
      let ok = false;
      if (user && code.length === 6) {
        const { data: row, error: rowErr } = await supabase
          .from('rd_password_resets')
          .select('id, code_hash, expires_at, used, attempts')
          .eq('user_id', user.id)
          .eq('used', false)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (rowErr) throw rowErr;
        const fresh = row && new Date(row.expires_at) > new Date() &&
          (row.attempts || 0) < RESET_MAX_ATTEMPTS;
        if (fresh) {
          // Constant-time compare so guesses can't be timed.
          const a = Buffer.from(row.code_hash, 'hex');
          const b = Buffer.from(sha256Hex(code), 'hex');
          if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
            const passHash = await bcrypt.hash(password, 10);
            const { error: updErr } = await supabase
              .from('rd_users')
              .update({ pass_hash: passHash })
              .eq('id', user.id);
            if (updErr) throw updErr;
            await supabase
              .from('rd_password_resets')
              .update({ used: true })
              .eq('id', row.id);
            ok = true;
            await revokeAuthTokens(user.id); // password reset kills old sessions
          } else {
            // Wrong guess: count it so brute-forcing dies after a few tries.
            await supabase
              .from('rd_password_resets')
              .update({ attempts: (row.attempts || 0) + 1 })
              .eq('id', row.id);
          }
        }
      }
      if (!ok) { bad(); return; }
      log(`client-reset: password changed for '${email}'`);
      send(ws, { type: 'password_reset' });
    } catch (e) {
      log('db: reset_password failed:', e.message);
      send(ws, { type: 'auth_error', message: 'Reset failed — try again' });
    }
    return;
  }

  // Everything below needs a signed-in client.
  if (!clientState.authed) {
    send(ws, { type: 'auth_error', message: 'Sign in first' });
    return;
  }

  switch (msg.type) {
    // Ask for online/offline status of a computer (no pairing yet).
    case 'status': {
      const computerId = normComputerId(msg.computerId);
      const hostEntry = hosts.get(computerId);
      const online = !!hostEntry && hostEntry.ws.readyState === hostEntry.ws.OPEN;
      send(ws, { type: 'status', computerId, online, viewOnly: online && !!hostEntry.viewOnly });
      break;
    }

    // Pair with a host: { type:'connect', computerId }
    // Multiple clients may attach to the same computer at once.
    case 'connect': {
      const computerId = normComputerId(msg.computerId);
      const hostEntry = hosts.get(computerId);
      if (!hostEntry || hostEntry.ws.readyState !== hostEntry.ws.OPEN) {
        send(ws, { type: 'status', computerId, online: false });
        return;
      }
      await attachClient(hostEntry, clientState, hostEntry.db);
      break;
    }

    // Input events → relay to host, and count as activity for idle timeout.
    case 'input': {
      const hostEntry = clientState.computerId ? hosts.get(clientState.computerId) : null;
      if (!hostEntry || !hostEntry.clients.has(clientState.cid)) {
        send(ws, { type: 'error', message: 'not connected to a host' });
        return;
      }
      clientState.lastInputAt = Date.now();
      resetIdleTimer(hostEntry, clientState); // any input resets the 30-minute clock
      // Forward the whole input payload (action: move|click|key|scroll, ...).
      send(hostEntry.ws, msg);
      break;
    }

    // File transfer → relay to host (same pairing guard as input).
    case 'file_start':
    case 'file_chunk':
    case 'file_end':
    case 'file_get_list':
    case 'file_dl':
    case 'file_delete':
    case 'file_rename': {
      const hostEntry = clientState.computerId ? hosts.get(clientState.computerId) : null;
      if (!hostEntry || !hostEntry.clients.has(clientState.cid)) {
        send(ws, { type: 'error', message: 'not connected to a host' });
        return;
      }
      // Chunk payloads must be strings, like frames.
      if (msg.type === 'file_chunk' && typeof msg.data !== 'string') {
        send(ws, { type: 'error', message: 'bad chunk payload' });
        return;
      }
      // Remember who asked so the host's reply routes back to them.
      // (Two clients doing file ops at once: last requester wins.)
      if (msg.type === 'file_start' || msg.type === 'file_get_list' || msg.type === 'file_dl') {
        hostEntry.fileRequester = clientState;
      }
      clientState.lastInputAt = Date.now();
      resetIdleTimer(hostEntry, clientState); // transfers count as session activity
      send(hostEntry.ws, msg);
      break;
    }

    // Client ends the session on purpose.
    case 'disconnect': {
      const hostEntry = clientState.computerId ? hosts.get(clientState.computerId) : null;
      if (hostEntry && hostEntry.clients.has(clientState.cid)) {
        await detachClient(hostEntry, clientState, 'client requested disconnect');
      }
      clientState.computerId = null;
      send(ws, { type: 'disconnected' });
      break;
    }

    // --- 2FA management (all require an authed session) ---

    // Start 2FA setup: returns a secret + otpauth:// URL to scan.
    case 'setup_2fa': {
      if (!dbReady) {
        send(ws, { type: 'auth_error', message: 'Server database not configured' });
        return;
      }
      try {
        const secret = authenticator.generateSecret();
        const { error } = await supabase
          .from('rd_users')
          .update({ totp_secret: secret })
          .eq('id', clientState.userId);
        if (error) throw error;
        const qrUrl = authenticator.keyuri(clientState.email, 'ECFC Remote Desktop', secret);
        log(`client-2fa: setup started for '${clientState.email}'`);
        send(ws, { type: '2fa_secret', secret, qr_url: qrUrl });
      } catch (e) {
        log('db: setup_2fa failed:', e.message);
        send(ws, { type: 'auth_error', message: 'Could not start 2FA setup — try again' });
      }
      break;
    }

    // Finish 2FA setup: prove you can generate codes, then it turns on.
    case 'enable_2fa': {
      if (!dbReady) {
        send(ws, { type: 'auth_error', message: 'Server database not configured' });
        return;
      }
      const token = String(msg.token || '').replace(/\s/g, '');
      try {
        const { data: user, error } = await supabase
          .from('rd_users')
          .select('totp_secret')
          .eq('id', clientState.userId)
          .single();
        if (error) throw error;
        const valid = user.totp_secret &&
          authenticator.verify({ token, secret: user.totp_secret });
        if (!valid) {
          send(ws, { type: 'auth_error', message: 'Invalid code — check your authenticator app and try again' });
          return;
        }
        const { error: updErr } = await supabase
          .from('rd_users')
          .update({ totp_enabled: true })
          .eq('id', clientState.userId);
        if (updErr) throw updErr;
        log(`client-2fa: enabled for '${clientState.email}'`);
        send(ws, { type: '2fa_enabled' });
      } catch (e) {
        log('db: enable_2fa failed:', e.message);
        send(ws, { type: 'auth_error', message: 'Could not enable 2FA — try again' });
      }
      break;
    }

    // Turn 2FA off: requires the account password as confirmation.
    case 'disable_2fa': {
      if (!dbReady) {
        send(ws, { type: 'auth_error', message: 'Server database not configured' });
        return;
      }
      const password = String(msg.password || '');
      try {
        const { data: user, error } = await supabase
          .from('rd_users')
          .select('pass_hash')
          .eq('id', clientState.userId)
          .single();
        if (error) throw error;
        const ok = await bcrypt.compare(password, user.pass_hash);
        if (!ok) {
          send(ws, { type: 'auth_error', message: 'Wrong password — 2FA stays on' });
          return;
        }
        const { error: updErr } = await supabase
          .from('rd_users')
          .update({ totp_enabled: false, totp_secret: null })
          .eq('id', clientState.userId);
        if (updErr) throw updErr;
        log(`client-2fa: disabled for '${clientState.email}'`);
        send(ws, { type: '2fa_disabled' });
      } catch (e) {
        log('db: disable_2fa failed:', e.message);
        send(ws, { type: 'auth_error', message: 'Could not disable 2FA — try again' });
      }
      break;
    }

    // Change password while signed in:
    // { type:'change_password', currentPassword, newPassword }
    case 'change_password': {
      if (!dbReady) {
        send(ws, { type: 'auth_error', message: 'Server database not configured' });
        return;
      }
      const currentPassword = String(msg.currentPassword || '');
      const newPassword = String(msg.newPassword || '');
      if (newPassword.length < 8) {
        send(ws, { type: 'auth_error', message: 'New password must be at least 8 characters' });
        return;
      }
      try {
        const { data: user, error } = await supabase
          .from('rd_users')
          .select('pass_hash')
          .eq('id', clientState.userId)
          .single();
        if (error) throw error;
        const ok = await bcrypt.compare(currentPassword, user.pass_hash);
        if (!ok) {
          send(ws, { type: 'auth_error', message: 'Wrong current password — password not changed' });
          return;
        }
        const passHash = await bcrypt.hash(newPassword, 10);
        const { error: updErr } = await supabase
          .from('rd_users')
          .update({ pass_hash: passHash })
          .eq('id', clientState.userId);
        if (updErr) throw updErr;
        log(`client-auth: password changed for '${clientState.email}'`);
        await revokeAuthTokens(clientState.userId); // old remembered sessions die
        send(ws, { type: 'password_changed' });
      } catch (e) {
        log('db: change_password failed:', e.message);
        send(ws, { type: 'auth_error', message: 'Could not change password — try again' });
      }
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
    res.end(JSON.stringify({ ok: true, hostsOnline: online, db: dbReady }));
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
    hostEntry: { ws, computerId: null, name: null, db: null, viewOnly: false,
                 clients: new Map(), fileRequester: null },
    clientState: {
      cid: 'c' + (nextClientSeq++),
      ws, authed: false, userId: null, email: null, pending2fa: null,
      computerId: null, sessionId: null, idleTimer: null, lastInputAt: null,
    },
  };

  ws.on('message', async (raw) => {
    const msg = parseJson(raw.toString());
    if (!msg || typeof msg.type !== 'string') {
      send(ws, { type: 'error', message: 'invalid JSON message' });
      return;
    }

    // First message declares the role. 'signup'/'verify_2fa' are also client
    // messages (verify_2fa is step 2 of sign-in, before full auth).
    if (!peer.kind) {
      if (msg.type === 'register') {
        peer.kind = 'host';
        await handleHostMessage(peer.hostEntry, msg).catch((e) => {
          log('host handler error:', e.message);
          send(ws, { type: 'error', message: 'server error, try again' });
        });
      } else if (msg.type === 'auth' || msg.type === 'auth_token' || msg.type === 'signup' || msg.type === 'verify_2fa' || msg.type === 'request_reset' || msg.type === 'reset_password' || msg.type === 'ping') {
        peer.kind = 'client';
        await handleClientMessage(peer.clientState, msg).catch((e) => {
          log('client handler error:', e.message);
          send(ws, { type: 'error', message: 'server error, try again' });
        });
      } else {
        send(ws, { type: 'error', message: "first message must be 'register' (host), 'auth', 'signup', 'request_reset' or 'ping' (client)" });
      }
      return;
    }

    try {
      if (peer.kind === 'host') await handleHostMessage(peer.hostEntry, msg);
      else await handleClientMessage(peer.clientState, msg);
    } catch (e) {
      log('message handler error:', e.message);
      send(ws, { type: 'error', message: 'server error, try again' });
    }
  });

  ws.on('close', async () => {
    if (peer.kind === 'host') {
      await cleanupHost(peer.hostEntry);
    } else if (peer.kind === 'client') {
      const st = peer.clientState;
      const hostEntry = st.computerId ? hosts.get(st.computerId) : null;
      if (hostEntry && hostEntry.clients.has(st.cid)) {
        await detachClient(hostEntry, st, 'socket closed');
      } else if (st.email) {
        log(`client-disconnected: '${st.email}' (socket closed, no active session)`);
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
  log(`Database: ${dbReady ? 'Supabase connected' : 'NOT CONFIGURED — set SUPABASE_URL + SUPABASE_SERVICE_KEY'}`);
});

// Graceful shutdown: tell everyone we're going away.
function shutdown() {
  log('shutting down...');
  for (const [, hostEntry] of hosts) {
    try { hostEntry.ws.close(4002, 'server shutting down'); } catch { /* ignore */ }
    for (const [, c] of hostEntry.clients) {
      try { c.ws.close(4002, 'server shutting down'); } catch { /* ignore */ }
    }
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
