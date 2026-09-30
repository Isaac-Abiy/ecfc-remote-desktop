# ECFC Remote Desktop — Setup Guide

Access your Windows office computer from your phone or laptop, from anywhere.

## What You Need

1. **Office PC** (Windows) — the computer you want to control
2. **Your phone or laptop** — the device you'll connect from
3. **The relay server** — connects the two through firewalls (deploy once)

## Step 1: Deploy the Relay Server

The server is a small Node.js app. Easiest option: **Render** (free tier works).

1. Go to [render.com](https://render.com) and sign up (a grown-up should do this)
2. Click **New +** → **Web Service**
3. Connect your GitHub → select `Isaac-Abiy/ecfc-remote-desktop`
4. Settings:
   - **Root Directory:** `server`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
5. Add environment variables:
   - `PAIRING_SECRET` → pick a random secret (e.g. `ecfc-xy7k2m9p`)
   - `PORT` → `10000` (Render sets this automatically, but good to know)
6. Click **Create Web Service** — wait for it to go live
7. Copy your server URL — it'll look like `https://ecfc-remote-desktop.onrender.com`
8. Your WebSocket URL is the same but with `wss://` instead of `https://`:
   `wss://ecfc-remote-desktop.onrender.com`

**Keep Render awake:** Free Render services sleep after 15 min of inactivity. Add a free cron job (e.g. [cron-job.org](https://cron-job.org)) to ping `https://your-server.onrender.com/health` every 10 minutes.

## Step 2: Set Up the Office PC (Host Agent)

On your **Windows office PC**:

1. Install Python 3.9+ from [python.org](https://python.org) (check "Add Python to PATH")
2. Download the `host/` folder from the GitHub repo
3. Open Command Prompt in the `host/` folder, run:
   ```
   pip install -r requirements.txt
   python host.py
   ```
4. First run: it'll ask for a computer name and your server URL (the `wss://` one from Step 1)
5. It'll print your **6-character Computer ID** (e.g. `A3F9K2`) — **write this down!**
6. **Auto-start with Windows:**
   - Open Task Scheduler → Create Basic Task
   - Name: `ECFC Remote Desktop Host`
   - Trigger: **When I log on**
   - Action: **Start a program** → `pythonw.exe` → Arguments: `C:\path\to\host.py`
   - Check "Run with highest privileges"

## Step 3: Connect From Your Phone or Laptop

1. Open **https://ecfc-remote-desktop.vercel.app** in your browser
2. Create your account (or sign in)
3. Click **Add Computer** → enter your 6-character Computer ID
4. When it shows **online** (green dot), hit **Connect**
5. You're in! Move your mouse, click, type — it all controls the office PC.
   **Several people can connect to the same PC at the same time.**

### Phone Gestures
- **Tap** = left click
- **Drag** = move mouse
- **Two-finger drag** = scroll
- **Long-press** (hold 0.5 sec) = right click
- **⌨️ button** = show keyboard with Ctrl/Alt/Shift/Win keys; the second **⌨️ Type** button sends a whole sentence at once

### Files
- **📤 Upload** sends a file from your device to `Desktop\ECFC-Uploads` on the office PC (max 100 MB, with a progress bar)
- **📁 Files** lists that folder: download any file to your device, rename, or delete it

### Screen quality
The host streams at ~30 FPS and automatically lowers JPEG quality (never resolution) if the connection gets slow, then recovers when it's fast again.

## Changing the Login Password

Edit `server/server.js` — find the `USERS` object near the top:
```js
const USERS = { 'isaac': 'your-new-password-here' };
```
Then redeploy on Render (it auto-deploys when you push to GitHub).

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "Computer offline" | Make sure `host.py` is running on the office PC |
| Can't connect to server | Check the `wss://` URL is correct; check Render isn't sleeping |
| Laggy screen | Normal on slow connections — the host auto-adjusts quality |
| Keyboard not working | Click on the remote screen first to focus it |

## What's Next (Future Features)

- [x] File transfer between devices — **done** (upload/download/rename/delete via ECFC-Uploads)
- [x] Two-factor authentication — **done**
- [x] Multiple people controlling one PC at the same time — **done**
- [x] 30 FPS screen streaming — **done** (adaptive quality)
- [ ] Native phone apps (no browser needed)
- [ ] Wake-on-LAN (turn on the PC remotely)
- [ ] Session recording
- [ ] Audio streaming

## Project Structure

```
ecfc-remote-desktop/
├── server/          # Node.js WebSocket relay (deploy to Render)
│   ├── server.js
│   ├── package.json
│   └── README.md
├── host/            # Python agent (runs on Windows office PC)
│   ├── host.py
│   ├── requirements.txt
│   └── README.md
└── client/          # Web app (deployed to Vercel)
    ├── index.html
    ├── app.js
    ├── styles.css
    └── config.js
```
