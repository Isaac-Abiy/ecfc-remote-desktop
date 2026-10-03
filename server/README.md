# ECFC Remote Desktop — Signaling Server

WebSocket relay that pairs the Windows host agent with remote clients.
Accounts, computer pairing, and the session access log live in Supabase.

## 1. Create a Supabase project (a grown-up does this once)

1. Go to [supabase.com](https://supabase.com) → **New project**. Pick any name
   (e.g. `ecfc-remote-desktop`), a strong database password, and the region
   closest to you.
2. Wait for the project to finish provisioning (~2 minutes).
3. Open **SQL Editor** → **New query**, paste the entire contents of
   [`schema.sql`](schema.sql) in this folder, and press **Run**. This creates:
   - `rd_users` — accounts (email + bcrypt hash, optional TOTP 2FA)
   - `rd_computers` — registered PCs + per-computer pairing secrets
   - `rd_sessions` — access log: every remote session with start/end times
   - Row Level Security is **enabled** on all three tables with no public
     policies (the server's service-role key bypasses RLS).
4. Go to **Project Settings → API** and copy:
   - **Project URL** → this is `SUPABASE_URL`
   - **service_role key** (under "API Keys") → this is `SUPABASE_SERVICE_KEY`
     ⚠️ The service_role key bypasses all security rules — it lives ONLY as a
     server environment variable, never in client code.

You can view signups, computers, and the full connection history any time in
the Supabase dashboard under **Table Editor**.

## 2. Run the server

```bash
npm install
npm start
```

### Environment variables

| Variable              | Required | Default | What it is                                              |
|-----------------------|----------|---------|----------------------------------------------------------|
| `PORT`                | no       | `8080`  | Port the server listens on                               |
| `SUPABASE_URL`        | **yes**  | —       | Your Supabase project URL                                |
| `SUPABASE_SERVICE_KEY`| **yes**  | —       | Supabase **service_role** key (secret! server-side only) |
| `MYDESK_API_KEY`      | no       | —       | MyDesk MCP API key — lets the server email password-reset codes through your Gmail. Without it, "Forgot password" codes are created but never emailed. (secret! server-side only) |
| `MYDESK_MCP_URL`      | no       | MyDesk site `/api/mcp` | Override for the MyDesk MCP endpoint |

Without `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` the server still starts, but
sign-up, sign-in, pairing and the access log are disabled (clients get a clear
"Server database not configured" error).

`GET /health` → `{ ok: true, hostsOnline: N, db: true/false }`

## 3. Message protocol (JSON over WebSocket)

The first message on a socket declares its role: `register` = host,
`auth` / `signup` / `verify_2fa` = client.

### Accounts

| Client → Server | Server → Client | Notes |
|---|---|---|
| `{ type:'signup', email, password }` | `{ type:'auth_ok', userId }` / `{ type:'auth_error', message }` | Email validated, password ≥ 8 chars, bcrypt-hashed. Duplicate email → friendly error. Signs you in immediately. |
| `{ type:'auth', email, password }` | `{ type:'auth_ok', userId }` / `{ type:'need_2fa', userId }` / `{ type:'auth_error', message }` | `need_2fa` means the password was right — finish with `verify_2fa`. |
| `{ type:'verify_2fa', userId, token }` | `{ type:'auth_ok', userId }` / `{ type:'auth_error', message }` | Step 2 of sign-in when 2FA is on. |
| `{ type:'setup_2fa' }` *(authed)* | `{ type:'2fa_secret', secret, qr_url }` | Generates a TOTP secret; `qr_url` is an `otpauth://` URL — scan it with Google Authenticator / Authy. Not active until you confirm with `enable_2fa`. |
| `{ type:'enable_2fa', token }` *(authed)* | `{ type:'2fa_enabled' }` / `{ type:'auth_error', message }` | Verifies a code from your authenticator app, then turns 2FA on. |
| `{ type:'disable_2fa', password }` *(authed)* | `{ type:'2fa_disabled' }` / `{ type:'auth_error', message }` | Requires your account password as confirmation. |

### Hosts

- `{ type:'register', computerId, name, pairingSecret }` → `{ type:'registered', computerId }`
  (also accepts `secret` for the old host agent). The pairing secret is checked
  against `rd_computers`; a first-time computerId creates the row with
  `owner_id = NULL`. Wrong secret → rejected.
- `{ type:'frame', data }` → relayed to the paired client as-is.
- `{ type:'bye' }` → clean sign-off.
- Server → host: `{ type:'client_connected' }`, `{ type:'client_disconnected' }`,
  `{ type:'idle_timeout' }`.

### Clients (authed)

- `{ type:'status', computerId }` → `{ type:'status', computerId, online }`
- `{ type:'connect', computerId }` → `{ type:'connected', computerId, name }`,
  or `{ type:'status', computerId, online:false }`, or `{ type:'busy' }` if
  someone else is connected. The first client to connect to an unclaimed
  computer becomes its **owner** (`rd_computers.owner_id`). A row is written to
  `rd_sessions` (the access log).
- `{ type:'input', ... }` → relayed to the host; also resets the 30-minute
  idle timer.
- `{ type:'disconnect' }` → `{ type:'disconnected' }`; the session row gets
  its `ended_at` timestamp.
- `{ type:'ping', t }` → `{ type:'pong', t }` (works before auth too).
- Server → client: `{ type:'host_offline' }` (host dropped),
  `{ type:'idle_timeout' }` (30 min with no input).

## 4. Manual test walkthrough (`wscat`)

```bash
npm install -g wscat
# Terminal 1 — pretend to be a client:
wscat -c ws://localhost:8080
> {"type":"signup","email":"you@example.com","password":"supersecret1"}
< {"type":"auth_ok","userId":"..."}
> {"type":"setup_2fa"}
< {"type":"2fa_secret","secret":"...","qr_url":"otpauth://..."}
# scan qr_url with your authenticator app, then:
> {"type":"enable_2fa","token":"123456"}
< {"type":"2fa_enabled"}
```

Then sign out (close), reconnect, and sign in to see the `need_2fa` step:

```bash
wscat -c ws://localhost:8080
> {"type":"auth","email":"you@example.com","password":"supersecret1"}
< {"type":"need_2fa","userId":"..."}
> {"type":"verify_2fa","userId":"...","token":"654321"}
< {"type":"auth_ok","userId":"..."}
```

## 5. Deploying (Render)

Same as the MVP, plus the two Supabase env vars:

1. Render → **New +** → **Web Service** → connect the
   `Isaac-Abiy/ecfc-remote-desktop` repo.
2. **Root Directory:** `server`, **Build:** `npm install`, **Start:** `npm start`.
3. Environment variables: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`
   (paste from Supabase Project Settings → API).
4. Deploy. `wss://` URL = your Render URL with `wss://` instead of `https://`.
