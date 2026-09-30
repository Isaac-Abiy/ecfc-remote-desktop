# ECFC Remote Desktop — Signaling Server

A Node.js WebSocket server that pairs a Windows **host agent** with a remote
**client** (browser). It relays JSON messages between them (screen frames
host→client, input events client→host) and tracks online/offline status.

## Run it

```bash
cd server
npm install
npm start
```

The server listens on port `8080` by default.

## Environment variables

| Variable         | Default          | What it does                                        |
|------------------|------------------|-----------------------------------------------------|
| `PORT`           | `8080`           | TCP port the server listens on                      |
| `PAIRING_SECRET` | `ecfc-pair-123`  | Secret the host agent must send when registering. **Change this in production!** |

Example:

```bash
PORT=9000 PAIRING_SECRET='my-very-secret' npm start
```

## Auth (MVP)

- **Clients** must first send `{ "type": "auth", "username": "isaac", "password": "password123" }`
  and receive `{ "type": "auth_ok" }` before doing anything else.
- **Hosts** authenticate with the pairing secret:
  `{ "type": "register", "computerId": "XXXXXX", "name": "Office PC", "secret": "<PAIRING_SECRET>" }`.

This is intentionally simple for the MVP. Before real use, replace the
hardcoded `USERS` object with a database and hashed passwords.

## Message protocol (JSON over WebSocket)

**Host → Server**
- `{ "type": "register", "computerId": "ABC123", "name": "Office PC", "secret": "..." }`
- `{ "type": "frame", "data": "<base64 jpeg>" }` — screen frame, relayed to client
- `{ "type": "bye" }` — host signing off on purpose

**Server → Host**
- `{ "type": "registered", "computerId": "ABC123" }`
- `{ "type": "client_connected" }` / `{ "type": "client_disconnected" }`
- `{ "type": "idle_timeout" }` — session killed after 30 min with no input

**Client → Server**
- `{ "type": "auth", "username": "...", "password": "..." }`
- `{ "type": "status", "computerId": "ABC123" }` — ask if a host is online
- `{ "type": "connect", "computerId": "ABC123" }` — pair with the host
- `{ "type": "input", "action": "move"|"click"|"key"|"scroll", ... }` — relayed to host
- `{ "type": "disconnect" }` — end the session

**Server → Client**
- `{ "type": "auth_ok" }` or `{ "type": "auth_error", "message": "..." }`
- `{ "type": "status", "computerId": "ABC123", "online": true|false }`
- `{ "type": "connected", "computerId": "ABC123", "name": "Office PC" }`
- `{ "type": "busy" }` — someone else is already connected to that host
- `{ "type": "host_offline" }` — the host disconnected mid-session
- `{ "type": "disconnected" }` — ack of your disconnect request
- `{ "type": "idle_timeout" }` — session killed after 30 min with no input

## Behavior notes

- **One client per host.** A second client that tries to connect gets `{ "type": "busy" }`.
- **Host disconnect** → the paired client gets `{ "type": "host_offline" }`.
- **Client disconnect** → the host gets `{ "type": "client_disconnected" }`.
- **Idle sessions** die after 30 minutes with no `input` events; both sides get
  `{ "type": "idle_timeout" }`.
- **Access log:** every connect/disconnect/auth event is printed to the console
  with an ISO timestamp — that is the MVP audit trail.
- `GET /health` returns `{ "ok": true, "hostsOnline": N }` for uptime checks.

## Quick manual test (two terminals)

Terminal 1 — start the server:

```bash
npm install && npm start
```

Terminal 2 — fake a host with `wscat` (or any WebSocket client):

```bash
npx wscat -c ws://localhost:8080
# then paste:
{"type":"register","computerId":"ABC123","name":"Office PC","secret":"ecfc-pair-123"}
```

Terminal 3 — fake a client:

```bash
npx wscat -c ws://localhost:8080
{"type":"auth","username":"isaac","password":"password123"}
{"type":"status","computerId":"ABC123"}
{"type":"connect","computerId":"ABC123"}
{"type":"input","action":"move","x":100,"y":200}
```

You should see `auth_ok`, `status` with `online: true`, `connected`, and the
server log the pairing. The host terminal will show `client_connected`, and any
`{"type":"frame","data":"..."}` you paste in the host terminal appears in the
client terminal.
