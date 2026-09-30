# ECFC Remote Desktop — Web Client (MVP)

A single-page web app that connects to the ECFC Remote Desktop relay server and
controls a Windows office PC from any phone or laptop browser. Dark-mode UI,
mobile responsive, no build step — just static files.

## Files

| File         | Purpose                                                        |
|--------------|----------------------------------------------------------------|
| `index.html` | App shell: splash, signup, sign in, 2FA verify, home (computer list), settings, and session screens |
| `app.js`     | All logic: signup/signin/2FA, computer list, session, mouse/touch/keyboard |
| `styles.css` | Dark modern theme, responsive layout                           |
| `config.js`  | `SERVER_URL` — the WebSocket address of your relay server       |

## Quick start

Serve the folder with any static host, then open it in a browser:

```bash
cd ~/workspace/ecfc-remote-desktop/client
npx serve .
# or: python3 -m http.server 3000
```

Then open `http://localhost:3000` (or the address `serve` prints).

## Pointing the client at your server

Two ways (the login-screen field wins if filled):

1. **Edit `config.js`** — set `const SERVER_URL = 'ws://your-server:8080';`
2. **Login screen “Server” field** — type the address once; it is saved in the
   browser (`localStorage`) and reused on later visits.

Use `ws://` for plain connections or `wss://` when your server has TLS.

## Using the app

1. **Sign up** — first visit? Tap "Sign up" and create an account with your
   email + password (min 8 characters). The client sends
   `{ type: 'signup', email, password }`; the server replies `{ type: 'auth_ok' }`
   or `{ type: 'auth_error', message }`.
2. **Sign in** — the client sends `{ type: 'auth', email, password }`. If your
   account has 2FA enabled, the server replies `{ type: 'need_2fa', userId }`
   and you'll be asked for the 6-digit code from your authenticator app
   (`{ type: 'verify_2fa', userId, token }` → `{ type: 'auth_ok' }`).
3. **Home** — add a computer with the 6-character ID shown in the host app
   (e.g. `ABC123`). Saved computers persist in `localStorage`. The client asks
   the server for each computer's status (`{ type: 'status', computerId }` →
   `{ type: 'status', computerId, online }`); the Connect button enables when
   the PC is online.
4. **Settings (⚙️)** — manage two-factor authentication:
   - **Enable 2FA:** tap "Enable 2FA" → the server sends
     `{ type: '2fa_secret', secret, qr_url }`. Scan the QR code (or type the
     secret) into Google Authenticator / any TOTP app, enter the 6-digit code,
     and the client sends `{ type: 'enable_2fa', token }` → server replies
     `{ type: '2fa_enabled' }`.
   - **Disable 2FA:** confirm with your password →
     `{ type: 'disable_2fa', password }` → `{ type: '2fa_disabled' }`.
   - 2FA is optional — sign-in works with just email + password until you turn
     it on.
5. **Session** — full-screen remote desktop:
   - **Mouse (laptop):** move to move the cursor, hold left button to drag,
     scroll wheel to scroll, right-click for the right button.
   - **Touch (phone):** single tap = left click, drag = move, two-finger
     vertical move = scroll, long-press (500 ms) = right-click.
   - **Keyboard:** the ⌨️ button toggles capture. On desktop it is on by
     default; on phones it summons the soft keyboard plus a special-keys bar
     (sticky Ctrl/Alt/Shift/Win, Esc, Tab, Del).
   - **Toolbar:** ✕ disconnect, FPS + ping readout, ⛶ fit-to-screen toggle.
   - The server can end the session with `{ type: 'host_offline' }`
     (“computer went offline”), `{ type: 'busy' }` (“someone else is
     connected”), or `{ type: 'idle_timeout' }` (“disconnected for inactivity”).

## Protocol reference (what the server must implement)

Client → server (JSON over WebSocket):

```jsonc
{ "type": "signup", "email": "you@example.com", "password": "secret123" }
{ "type": "auth", "email": "you@example.com", "password": "secret123" }
{ "type": "verify_2fa", "userId": "abc-123", "token": "123456" }
{ "type": "setup_2fa" }
{ "type": "enable_2fa", "token": "123456" }
{ "type": "disable_2fa", "password": "secret123" }
{ "type": "status", "computerId": "ABC123" }
{ "type": "connect", "computerId": "ABC123" }
{ "type": "disconnect" }
{ "type": "input", "action": "move", "x": 0.42, "y": 0.61 }          // 0.0–1.0 relative coords
{ "type": "input", "action": "button", "button": "left", "down": true, "x": 0.42, "y": 0.61 }
{ "type": "input", "action": "click", "button": "left", "x": 0.42, "y": 0.61 }  // tap / right-click shorthand
{ "type": "input", "action": "scroll", "dx": 0, "dy": 3, "x": 0.5, "y": 0.5 }
{ "type": "input", "action": "key", "key": "a", "down": true, "repeat": false,
  "ctrlKey": false, "altKey": false, "shiftKey": false, "metaKey": false }
{ "type": "ping", "t": 1727560000000 }
```

Server → client:

```jsonc
{ "type": "auth_ok", "tfa_enabled": false }          // tfa_enabled optional; client defaults to false
{ "type": "auth_error", "message": "Bad email or password." }
{ "type": "need_2fa", "userId": "abc-123" }          // sign-in needs a second-factor code
{ "type": "2fa_secret", "secret": "JBSWY3DPEHPK3PXP", "qr_url": "otpauth://totp/..." }
                                                     // qr_url may be an otpauth:// URL or a ready-made QR image URL
{ "type": "2fa_enabled" }
{ "type": "2fa_disabled" }
{ "type": "status", "computerId": "ABC123", "online": true }
{ "type": "connected", "computerId": "ABC123" }
{ "type": "frame", "data": "<base64 JPEG or PNG>" }
{ "type": "pong", "t": 1727560000000 }
{ "type": "host_offline" }
{ "type": "busy" }
{ "type": "idle_timeout" }
```

**Server builder note:** please implement `{ type: 'ping' }` → `{ type: 'pong', t }`,
echoing the client's timestamp so the client can measure round-trip time. If the
server does not implement it, the client degrades gracefully and shows "— ms"
for ping instead of breaking.

## Notes & limitations

- Frames are rendered from base64 data URLs — simple and reliable for the MVP.
  A production client would switch to binary frames or WebRTC video.
- Mouse coordinates are relative (0.0–1.0), so any host resolution works.
- On mobile browsers, soft-keyboard key events are best-effort (some Android
  keyboards report `Unidentified` for certain keys); the special-keys bar covers
  the important ones.
- Keys like Ctrl+W / Cmd+W cannot be captured — the browser reserves them.
- No credentials are stored: only the email and server address are
  remembered; the password is never saved.
- The 2FA QR code is rendered with the free api.qrserver.com image service —
  no extra JS library needed. If the server already provides a QR image URL
  in `qr_url`, it is used directly.
- The signup screen validates email format, a minimum 8-character password,
  and matching confirmation client-side; the server must still validate and
  hash passwords itself (bcrypt/argon2) — never store plaintext.
