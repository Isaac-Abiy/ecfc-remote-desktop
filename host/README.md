# ECFC Remote Desktop - Host Agent (MVP)

This is the **host agent** that runs on the office Windows PC. It connects to
the ECFC Remote Desktop signaling server over WebSocket, registers itself,
streams the screen as JPEG frames, and executes remote mouse/keyboard input
from connected clients.

> **Windows only.** `mss` (screen capture) and `pynput` (input control) need a
> real Windows PC with a display. You can syntax-check this script on
> Linux/Mac, but you cannot functionally test it there.

## 1. Install

On the office PC:

1. Install **Python 3.9+** from https://www.python.org/downloads/
   - On the installer screen, check **"Add python.exe to PATH"**.
2. Open a terminal (Command Prompt or PowerShell) in this folder and run:

```bat
pip install -r requirements.txt
```

## 2. Run

```bat
python host.py
```

**First run** is interactive - it asks for:

- **Computer name** (e.g. `Office PC`) - shown in the client app.
- **Signaling server URL** (e.g. `ws://your-server:8080`, or `wss://...` for TLS).

It then generates a random 6-character **computer ID** (like `A3F9K2`) and a
**pairing secret**, and saves everything to `config.json` next to the script.
Enter the computer ID in the client app to connect.

You should see:

```
[*] Connecting to ws://your-server:8080 ...
[+] Connected to signaling server
[+] Registered as 'Office PC' (ID A3F9K2) - waiting for clients
[*] Primary monitor: 1920x1080
```

When a phone/laptop connects you will see `[+] Client connected ...`, and the
screen starts streaming (~10 FPS, JPEG quality 60, scaled to max 1280 px wide).
If the network is slow, the frame rate drops automatically instead of lagging.

Press **Ctrl+C** to stop. If the connection drops, the agent reconnects by
itself (1s, 2s, 4s ... up to 60s backoff).

## 3. config.json format

```json
{
  "computerId": "A3F9K2",
  "name": "Office PC",
  "serverUrl": "ws://your-server:8080",
  "secret": "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6"
}
```

| Field        | Meaning                                                        |
|--------------|----------------------------------------------------------------|
| `computerId` | 6-character ID shown to clients. Generated on first run.       |
| `name`       | Friendly name shown in the client's computer list.             |
| `serverUrl`  | WebSocket URL of the signaling server (`ws://` or `wss://`).   |
| `secret`     | Pairing secret - proves this host is yours. Keep it private.   |

Delete `config.json` and re-run to start setup over.

## 4. Auto-start with Windows (Task Scheduler)

So the agent starts automatically when the PC boots:

1. Press **Win+R**, type `taskschd.msc`, press Enter.
2. **Action > Create Task...**
3. **General** tab:
   - Name: `ECFC Remote Desktop Host`
   - Check **"Run whether user is logged on or not"**
   - Check **"Run with highest privileges"**
   - Configure for: your Windows version.
4. **Triggers** tab > **New...** > Begin the task: **At startup** > OK.
5. **Actions** tab > **New...**:
   - Action: **Start a program**
   - Program/script: `C:\Python312\pythonw.exe` (use `pythonw.exe` = no console window; adjust the Python path/version to yours)
   - Add arguments: `"C:\ECFCRemoteDesktop\host\host.py"` (full path to where you put this script)
   - Start in: `"C:\ECFCRemoteDesktop\host"` (so it finds `config.json`)
6. **Settings** tab: check **"If the task fails, restart every 1 minute"**.
7. Click **OK** (enter your Windows password if asked).

Or from an **admin** Command Prompt (adjust paths):

```bat
schtasks /create /tn "ECFC Remote Desktop Host" /tr "\"C:\Python312\pythonw.exe\" \"C:\ECFCRemoteDesktop\host\host.py\"" /sc onstartup /rl highest /f
```

> Tip: run once with `python.exe` (console visible) to confirm registration
> works, then switch to `pythonw.exe` for silent background running.

## 5. Protocol reference

Messages the host **sends** to the server:

| Message | Fields |
|---------|--------|
| `register` | `{type:'register', computerId, name, secret}` |
| `frame` | `{type:'frame', data:'<base64 JPEG>'}` - only while a client is connected |

Messages the host **handles** from the server:

| Message | Meaning |
|---------|---------|
| `registered` | Server acknowledged registration. |
| `client_connected` | A client connected - start streaming. Logged. |
| `client_disconnected` | Client left - stop streaming, keep waiting. |
| `idle_timeout` | Server ended an idle session - keep waiting. |
| `input` | Remote input - see below. |
| `error` | Server-side error - logged. |

Input message format (`{type:'input', action, ...}`):

| Action | Fields | Effect |
|--------|--------|--------|
| `move` | `x`, `y` (0.0-1.0 relative) | Move mouse (scaled to real screen size) |
| `click` | `x`, `y`, `button` (`left`/`right`/`middle`) | Move + click |
| `key` | `key` (name), `down` (true/false, optional) | Press/release key; no `down` = tap. Special names: `Enter`, `Backspace`, `Tab`, `Escape`, `Shift`, `Ctrl`, `Alt`, `Win`, arrows (`up`/`down`/`left`/`right`), `F1`-`F12`, `Delete`, `Home`, `End`, `PageUp`, `PageDown`, `Space`, etc. Single characters work too. |
| `scroll` | `dx`, `dy` | Scroll wheel |
| `type` | `text` | Type a string |

## 6. Security notes

- The connection should use **`wss://`** (TLS) in production, not plain `ws://`.
- The `secret` in `config.json` authenticates this host to the server - don't share it.
- Pairing/approval, 2FA, and access logs live on the **server + client** side; this
  host trusts commands relayed by the signaling server it is configured to use.
- No inbound firewall ports are needed on the office PC - the host makes an
  **outbound** WebSocket connection, so it works behind NAT.

## 7. Troubleshooting

| Symptom | Fix |
|---------|-----|
| `pip install` fails on `pynput` | Make sure you use Python 3.9+ on Windows; `pynput` needs Windows APIs. |
| `Connection problem` loop | Check `serverUrl` in `config.json`; make sure the signaling server is running and reachable. |
| Black frames | The PC may be locked or the display off - unlock it / keep the display on. |
| Input does nothing | Run the task with highest privileges; some apps (e.g. admin windows) ignore synthetic input from non-elevated processes. |
| `pythonw.exe` shows nothing | Normal - no console. Run with `python.exe` once to see the log output. |
