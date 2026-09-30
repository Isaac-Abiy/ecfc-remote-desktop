#!/usr/bin/env python3
"""
ECFC Remote Desktop - Windows host agent (MVP).

Runs on the office Windows PC. It:
  1. Connects to the signaling server over WebSocket.
  2. Registers itself with a computer ID + pairing secret.
  3. Streams the primary monitor as JPEG frames (~10 FPS, adaptive).
  4. Executes remote mouse/keyboard input sent by connected clients.

Requirements: Python 3.9+ on Windows + the packages in requirements.txt.

NOTE: `mss` (screen capture) and `pynput` (input control) only work on a
real Windows machine with a display attached. This script can be
syntax-checked on Linux/Mac but NOT functionally tested there.
"""

import asyncio
import base64
import io
import json
import os
import secrets
import string
import sys
import time

import mss
import websockets
from PIL import Image
from pynput.keyboard import Controller as KeyboardController, Key, KeyCode
from pynput.mouse import Button, Controller as MouseController

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

FRAME_INTERVAL = 0.1       # target ~10 FPS between frames
MAX_FRAME_WIDTH = 1280    # scale captures down to at most this width
JPEG_QUALITY = 60         # JPEG quality 1-100 (lower = less bandwidth)
IDLE_POLL = 0.5           # seconds between "any client yet?" checks when idle
RECONNECT_MAX_BACKOFF = 60  # cap for reconnect backoff, in seconds

CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           "config.json")


# ---------------------------------------------------------------------------
# Config handling
# ---------------------------------------------------------------------------

def _random_id(length=6):
    """Random computer ID like 'A3F9K2'."""
    alphabet = string.ascii_uppercase + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(length))


def _random_secret(length=32):
    """Random pairing secret."""
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(length))


def _normalize_server_url(url):
    url = (url or "").strip()
    if not url:
        return "ws://localhost:8080"
    if "://" not in url:
        url = "ws://" + url
    return url.rstrip("/")


def save_config(cfg):
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)


def load_or_create_config():
    """Load config.json, or interactively create it on first run."""
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        # Fill in anything missing (forward compatibility).
        changed = False
        if not cfg.get("computerId"):
            cfg["computerId"] = _random_id()
            changed = True
        if not cfg.get("secret"):
            cfg["secret"] = _random_secret()
            changed = True
        if not cfg.get("name"):
            cfg["name"] = "Office PC"
            changed = True
        if not cfg.get("serverUrl"):
            cfg["serverUrl"] = "ws://localhost:8080"
            changed = True
        if changed:
            save_config(cfg)
        return cfg

    print("=" * 60)
    print("ECFC Remote Desktop - first-time setup")
    print("=" * 60)
    name = input("Computer name [Office PC]: ").strip() or "Office PC"
    raw_url = input("Signaling server URL [ws://localhost:8080]: ").strip()
    cfg = {
        "computerId": _random_id(),
        "name": name,
        "serverUrl": _normalize_server_url(raw_url),
        "secret": _random_secret(),
    }
    save_config(cfg)
    print()
    print("Saved to %s" % CONFIG_PATH)
    print("  Computer ID : %s   <-- enter this in the client app"
          % cfg["computerId"])
    print("  Pairing secret (keep private): %s" % cfg["secret"])
    print()
    return cfg


# ---------------------------------------------------------------------------
# Input handling (pynput)
# ---------------------------------------------------------------------------

SPECIAL_KEYS = {
    "enter": Key.enter, "return": Key.enter,
    "backspace": Key.backspace, "back": Key.backspace,
    "tab": Key.tab,
    "escape": Key.esc, "esc": Key.esc,
    "shift": Key.shift, "shift_l": Key.shift_l, "shift_r": Key.shift_r,
    "ctrl": Key.ctrl, "control": Key.ctrl,
    "ctrl_l": Key.ctrl_l, "ctrl_r": Key.ctrl_r,
    "alt": Key.alt, "alt_l": Key.alt_l, "alt_r": Key.alt_r,
    "altgr": Key.alt_gr,
    "win": Key.cmd, "windows": Key.cmd, "cmd": Key.cmd,
    "meta": Key.cmd, "super": Key.cmd,
    "cmd_l": Key.cmd_l, "cmd_r": Key.cmd_r,
    "up": Key.up, "down": Key.down, "left": Key.left, "right": Key.right,
    "space": Key.space, "spacebar": Key.space,
    "delete": Key.delete, "del": Key.delete,
    "home": Key.home, "end": Key.end,
    "pageup": Key.page_up, "page_up": Key.page_up,
    "pagedown": Key.page_down, "page_down": Key.page_down,
    "insert": Key.insert, "ins": Key.insert,
    "capslock": Key.caps_lock, "caps_lock": Key.caps_lock,
    "numlock": Key.num_lock, "scrolllock": Key.scroll_lock,
    "printscreen": Key.print_screen, "prtsc": Key.print_screen,
    "pause": Key.pause, "break": Key.pause,
    "menu": Key.menu,
}
# F1-F12
for _i in range(1, 13):
    SPECIAL_KEYS["f%d" % _i] = getattr(Key, "f%d" % _i)

MOUSE_BUTTONS = {
    "left": Button.left,
    "right": Button.right,
    "middle": Button.middle,
}


def resolve_key(name):
    """Turn a key name from the client into a pynput key, or None."""
    if name is None:
        return None
    n = str(name).strip().lower()
    if n in SPECIAL_KEYS:
        return SPECIAL_KEYS[n]
    if len(n) == 1:
        return KeyCode.from_char(n)
    return None


def handle_input(msg, mouse, keyboard, screen_w, screen_h):
    """Execute one {type:'input', action, ...} message from the server."""
    action = msg.get("action")
    try:
        if action == "move":
            # x, y are 0.0-1.0 relative coordinates.
            x = max(0.0, min(1.0, float(msg.get("x", 0))))
            y = max(0.0, min(1.0, float(msg.get("y", 0))))
            mouse.position = (int(x * screen_w), int(y * screen_h))

        elif action == "click":
            x = max(0.0, min(1.0, float(msg.get("x", 0))))
            y = max(0.0, min(1.0, float(msg.get("y", 0))))
            mouse.position = (int(x * screen_w), int(y * screen_h))
            button = MOUSE_BUTTONS.get(str(msg.get("button", "left")).lower(),
                                       Button.left)
            mouse.click(button, 1)

        elif action == "key":
            key = resolve_key(msg.get("key"))
            if key is None:
                print("[!] Unknown key name: %r" % (msg.get("key"),))
                return
            if "down" in msg:
                if msg["down"]:
                    keyboard.press(key)
                else:
                    keyboard.release(key)
            else:
                # No explicit down/up: tap the key (press + release) so
                # simple clients can't leave keys stuck down.
                keyboard.press(key)
                keyboard.release(key)

        elif action == "scroll":
            dx = int(msg.get("dx", 0))
            dy = int(msg.get("dy", 0))
            mouse.scroll(dx, dy)

        elif action == "type":
            text = msg.get("text", "")
            if text:
                keyboard.type(str(text))

        else:
            print("[!] Unknown input action: %r" % (action,))
    except Exception as e:
        # Never let one bad input message kill the agent.
        print("[!] Input error (action=%r): %s" % (action, e))


# ---------------------------------------------------------------------------
# Screen capture + frame sending
# ---------------------------------------------------------------------------

async def frame_sender(ws, state):
    """Capture the primary monitor and stream JPEG frames while a client
    is connected. Adaptive: if capture+encode+send takes longer than the
    target interval, the sleep is skipped (FPS drops instead of lagging)."""
    slow_warned_at = 0.0
    with mss.mss() as sct:
        monitor = sct.monitors[1]  # monitors[0] is the virtual full desktop
        width, height = monitor["width"], monitor["height"]
        scale = min(1.0, MAX_FRAME_WIDTH / float(width))
        target = (int(width * scale), int(height * scale))

        while True:
            if not state["client_connected"]:
                await asyncio.sleep(IDLE_POLL)
                continue

            start = time.monotonic()
            try:
                shot = sct.grab(monitor)
                # mss gives BGRA bytes; "BGRX" raw mode converts to RGB.
                img = Image.frombytes("RGB", shot.size, shot.bgra,
                                      "raw", "BGRX")
                if scale < 1.0:
                    img = img.resize(target, Image.LANCZOS)
                buf = io.BytesIO()
                img.save(buf, format="JPEG", quality=JPEG_QUALITY)
                payload = base64.b64encode(buf.getvalue()).decode("ascii")
                await ws.send(json.dumps({"type": "frame", "data": payload}))
            except websockets.exceptions.ConnectionClosed:
                print("[-] Lost connection while sending frames")
                return
            except Exception as e:
                print("[!] Frame capture/send error: %s" % e)
                await asyncio.sleep(1.0)
                continue

            elapsed = time.monotonic() - start
            if elapsed > FRAME_INTERVAL * 2:
                now = time.monotonic()
                if now - slow_warned_at > 30:
                    print("[!] Slow frame pipeline (%.2fs) - lowering FPS"
                          % elapsed)
                    slow_warned_at = now
            await asyncio.sleep(max(0.0, FRAME_INTERVAL - elapsed))


# ---------------------------------------------------------------------------
# Server message handling
# ---------------------------------------------------------------------------

async def receive_loop(ws, state, mouse, keyboard, screen_w, screen_h):
    """Process server messages: client presence notifications + input."""
    async for raw in ws:
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            print("[!] Ignoring non-JSON message from server")
            continue
        mtype = msg.get("type")

        if mtype == "registered":
            print("[+] Server acknowledged registration (ID %s)"
                  % msg.get("computerId"))
        elif mtype == "client_connected":
            state["client_connected"] = True
            print("[+] Client connected (%s) - streaming screen"
                  % msg.get("clientId", "unknown"))
        elif mtype == "client_disconnected":
            state["client_connected"] = False
            print("[-] Client disconnected - waiting for next client")
        elif mtype == "idle_timeout":
            state["client_connected"] = False
            print("[!] Idle timeout - waiting for next client")
        elif mtype == "input":
            handle_input(msg, mouse, keyboard, screen_w, screen_h)
        elif mtype == "error":
            print("[!] Server error: %s" % msg.get("message", raw[:120]))
        else:
            print("[!] Unknown message type: %r" % (mtype,))


# ---------------------------------------------------------------------------
# Main connect / reconnect loop
# ---------------------------------------------------------------------------

async def agent_main(cfg):
    """Connect -> register -> stream + handle input, reconnecting on drops."""
    if sys.platform != "win32":
        print("[!] Warning: not on Windows - mss/pynput need a real "
              "Windows PC with a display.")

    backoff = 1
    while True:
        try:
            print("[*] Connecting to %s ..." % cfg["serverUrl"])
            async with websockets.connect(
                    cfg["serverUrl"], ping_interval=20, ping_timeout=20) as ws:
                print("[+] Connected to signaling server")
                await ws.send(json.dumps({
                    "type": "register",
                    "computerId": cfg["computerId"],
                    "name": cfg["name"],
                    "secret": cfg["secret"],
                }))
                print("[+] Registered as '%s' (ID %s) - waiting for clients"
                      % (cfg["name"], cfg["computerId"]))
                backoff = 1  # reset backoff after a successful connection

                with mss.mss() as sct:
                    mon = sct.monitors[1]
                    screen_w, screen_h = mon["width"], mon["height"]
                print("[*] Primary monitor: %dx%d" % (screen_w, screen_h))

                mouse = MouseController()
                keyboard = KeyboardController()
                state = {"client_connected": False}

                sender = asyncio.create_task(frame_sender(ws, state))
                try:
                    await receive_loop(ws, state, mouse, keyboard,
                                       screen_w, screen_h)
                finally:
                    sender.cancel()
                    try:
                        await sender
                    except asyncio.CancelledError:
                        pass
                print("[-] Server closed the connection")
        except (OSError, asyncio.TimeoutError,
                websockets.exceptions.WebSocketException) as e:
            print("[!] Connection problem: %s" % e)
        except Exception as e:
            # Keep the agent alive no matter what.
            print("[!] Unexpected error: %r" % (e,))
        print("[*] Reconnecting in %ds ... (Ctrl+C to quit)" % backoff)
        try:
            await asyncio.sleep(backoff)
        except asyncio.CancelledError:
            break
        backoff = min(backoff * 2, RECONNECT_MAX_BACKOFF)


def main():
    print("ECFC Remote Desktop - host agent (MVP)")
    cfg = load_or_create_config()
    try:
        asyncio.run(agent_main(cfg))
    except KeyboardInterrupt:
        print("\n[*] Shutting down - goodbye!")


if __name__ == "__main__":
    main()
