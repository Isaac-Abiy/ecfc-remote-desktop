#!/usr/bin/env python3
"""
ECFC Remote Desktop - Windows host agent.

Runs on the office Windows PC. It:
  1. Connects to the signaling server over WebSocket.
  2. Registers itself with a computer ID + pairing secret.
  3. Streams the primary monitor as JPEG frames (~30 FPS, adaptive).
  4. Executes remote mouse/keyboard input sent by connected clients.
  5. Sends/receives files (ECFC-Uploads folder on the Desktop).

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

FRAME_INTERVAL = 1 / 30.0   # target ~30 FPS between frames
MAX_FRAME_WIDTH = 1280    # scale captures down to at most this width
JPEG_QUALITY = 65         # JPEG quality 1-100 (lower = less bandwidth)
JPEG_QUALITY_MIN = 40     # adaptive floor: pipeline drops to this when slow
IDLE_POLL = 0.5           # seconds between "any client yet?" checks when idle
RECONNECT_MAX_BACKOFF = 60  # cap for reconnect backoff, in seconds

# --- File transfer ---
UPLOAD_DIRNAME = "ECFC-Uploads"            # folder on the Desktop
MAX_UPLOAD_BYTES = 100 * 1024 * 1024      # 100 MB cap per file
CHUNK_BYTES = 36 * 1024                   # binary bytes -> ~48 KB base64/chunk

def _base_dir():
    # When frozen (PyInstaller .exe), __file__ lives inside a temp folder
    # that Windows deletes on exit — so keep config.json next to the .exe.
    if getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


CONFIG_PATH = os.path.join(_base_dir(), "config.json")

# Production signaling server. The .exe double-click flow uses this with no
# questions asked; the .py flow still lets you override it on first run.
DEFAULT_SERVER_URL = "wss://ecfc-remote-desktop.onrender.com"


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
        return DEFAULT_SERVER_URL
    if "://" not in url:
        url = "ws://" + url
    return url.rstrip("/")


def _has_console():
    """True when we can interactively prompt (not a --noconsole .exe)."""
    try:
        return sys.stdin is not None and sys.stdin.isatty()
    except Exception:
        return False


def _show_first_run_info(computer_id):
    """Pop up the Computer ID when there's no console to print it to."""
    try:
        import tkinter
        from tkinter import messagebox
        root = tkinter.Tk()
        root.withdraw()
        messagebox.showinfo(
            "ECFC Remote Desktop",
            "This PC is now connected!\n\nComputer ID: %s\n\n"
            "Enter this ID in the ECFC Remote Desktop website "
            "to view and control this PC." % computer_id,
        )
        root.destroy()
    except Exception:
        pass


def save_config(cfg):
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)


def load_or_create_config():
    """Load config.json, or create it on first run.

    Fully non-interactive when there's no console (the --noconsole .exe):
    sensible defaults are used, the Computer ID pops up in a window, and
    the config is saved next to the .exe so the ID stays stable.
    """
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
            cfg["serverUrl"] = DEFAULT_SERVER_URL
            changed = True
        if changed:
            save_config(cfg)
        return cfg

    interactive = _has_console()
    if interactive:
        print("=" * 60)
        print("ECFC Remote Desktop - first-time setup")
        print("=" * 60)
        name = input("Computer name [Office PC]: ").strip() or "Office PC"
        raw_url = input("Signaling server URL [%s]: " % DEFAULT_SERVER_URL).strip()
    else:
        name, raw_url = "Office PC", ""
    cfg = {
        "computerId": _random_id(),
        "name": name,
        "serverUrl": _normalize_server_url(raw_url),
        "secret": _random_secret(),
    }
    save_config(cfg)
    if interactive:
        print()
        print("Saved to %s" % CONFIG_PATH)
        print("  Computer ID : %s   <-- enter this in the client app"
              % cfg["computerId"])
        print("  Pairing secret (keep private): %s" % cfg["secret"])
        print()
    else:
        _show_first_run_info(cfg["computerId"])
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
# File transfer (uploads dir <-> client)
# ---------------------------------------------------------------------------

def uploads_dir():
    """The ECFC-Uploads folder on the Desktop; created on first use."""
    d = os.path.join(os.path.expanduser("~"), "Desktop", UPLOAD_DIRNAME)
    os.makedirs(d, exist_ok=True)
    return d


def safe_name(name):
    """Strip path components and control chars; None if unusable.
    Blocks path traversal like '../../secret'."""
    n = os.path.basename(str(name or "")).strip()
    n = "".join(c for c in n if ord(c) >= 32 and ord(c) != 127)
    if not n or n in (".", ".."):
        return None
    return n


def unique_path(directory, name):
    """Pick a non-colliding path: 'file (1).txt', 'file (2).txt', ..."""
    base, ext = os.path.splitext(name)
    candidate = os.path.join(directory, name)
    i = 1
    while os.path.exists(candidate):
        candidate = os.path.join(directory, "%s (%d)%s" % (base, i, ext))
        i += 1
    return candidate


async def send_json(ws, send_lock, obj):
    """Send one JSON message, serialized through a lock so the frame
    streamer and file transfers can't interleave on the same socket."""
    async with send_lock:
        await ws.send(json.dumps(obj))


async def handle_file(msg, ws, send_lock, state):
    """File transfer messages relayed from the paired client.

    Upload:   file_start -> file_chunk* -> file_end ; host replies
              file_ack / file_done / file_error
    Download: file_dl ; host streams dl_start -> dl_chunk* -> dl_end
    List:     file_get_list -> file_list
    Rename:   file_rename -> file_renamed
    Delete:   file_delete -> file_deleted
    """
    mtype = msg.get("type")
    uploads = state.setdefault("uploads", {})

    async def reply(obj):
        await send_json(ws, send_lock, obj)

    if mtype == "file_start":
        name = safe_name(msg.get("name"))
        try:
            size = int(msg.get("size", -1))
        except (TypeError, ValueError):
            size = -1
        if not name:
            await reply({"type": "file_error", "message": "bad file name"})
            return
        if size < 0 or size > MAX_UPLOAD_BYTES:
            await reply({"type": "file_error", "name": name,
                         "message": "file too large (max 100 MB)"})
            return
        uploads[name] = {
            "size": size,
            "chunks": {},
            "expected": max(1, (size + CHUNK_BYTES - 1) // CHUNK_BYTES),
        }
        print("[+] Upload started: %s (%d bytes)" % (name, size))
        await reply({"type": "file_ack", "name": name, "size": size})

    elif mtype == "file_chunk":
        name = safe_name(msg.get("name"))
        up = uploads.get(name) if name else None
        if not up:
            await reply({"type": "file_error", "name": name or "",
                         "message": "no such upload in progress"})
            return
        data = msg.get("data")
        if not isinstance(data, str):
            return
        try:
            raw = base64.b64decode(data.encode("ascii"))
        except Exception:
            await reply({"type": "file_error", "name": name,
                         "message": "bad chunk data"})
            return
        try:
            index = int(msg.get("index", -1))
        except (TypeError, ValueError):
            index = -1
        if index < 0 or index >= up["expected"] or index in up["chunks"]:
            return  # ignore duplicate / out-of-range chunk indexes
        up["chunks"][index] = raw

    elif mtype == "file_end":
        name = safe_name(msg.get("name"))
        up = uploads.pop(name, None) if name else None
        if not up:
            await reply({"type": "file_error", "name": name or "",
                         "message": "no such upload in progress"})
            return
        if len(up["chunks"]) != up["expected"]:
            print("[!] Upload incomplete: %s (%d/%d chunks)"
                  % (name, len(up["chunks"]), up["expected"]))
            await reply({"type": "file_error", "name": name,
                         "message": "upload incomplete, try again"})
            return
        blob = b"".join(up["chunks"][i] for i in range(up["expected"]))
        if len(blob) != up["size"]:
            await reply({"type": "file_error", "name": name,
                         "message": "size mismatch, try again"})
            return
        try:
            path = unique_path(uploads_dir(), name)
            with open(path, "wb") as f:
                f.write(blob)
        except Exception as e:
            print("[!] Upload save failed: %s" % e)
            await reply({"type": "file_error", "name": name,
                         "message": "could not save file"})
            return
        saved = os.path.basename(path)
        print("[+] Upload saved: %s (%d bytes)" % (saved, len(blob)))
        await reply({"type": "file_done", "name": saved, "size": len(blob)})

    elif mtype == "file_get_list":
        try:
            d = uploads_dir()
            files = []
            for entry in sorted(os.listdir(d)):
                p = os.path.join(d, entry)
                if os.path.isfile(p):
                    files.append({"name": entry, "size": os.path.getsize(p)})
        except Exception as e:
            print("[!] List files failed: %s" % e)
            await reply({"type": "file_error",
                         "message": "could not list files"})
            return
        await reply({"type": "file_list", "files": files})

    elif mtype == "file_dl":
        name = safe_name(msg.get("name"))
        if not name:
            await reply({"type": "file_error", "message": "bad file name"})
            return
        path = os.path.join(uploads_dir(), name)
        if not os.path.isfile(path):
            await reply({"type": "file_error", "name": name,
                         "message": "file not found"})
            return
        try:
            size = os.path.getsize(path)
            total_chunks = max(1, (size + CHUNK_BYTES - 1) // CHUNK_BYTES)
            await reply({"type": "dl_start", "name": name, "size": size,
                         "chunks": total_chunks})
            index = 0
            with open(path, "rb") as f:
                while True:
                    raw = f.read(CHUNK_BYTES)
                    if not raw:
                        break
                    data = base64.b64encode(raw).decode("ascii")
                    await reply({"type": "dl_chunk", "name": name,
                                 "index": index, "data": data})
                    index += 1
            await reply({"type": "dl_end", "name": name, "chunks": index})
            print("[+] Download sent: %s (%d bytes)" % (name, size))
        except Exception as e:
            print("[!] Download failed: %s" % e)
            await reply({"type": "file_error", "name": name,
                         "message": "could not read file"})

    elif mtype == "file_delete":
        name = safe_name(msg.get("name"))
        if not name:
            await reply({"type": "file_error", "message": "bad file name"})
            return
        path = os.path.join(uploads_dir(), name)
        try:
            if not os.path.isfile(path):
                await reply({"type": "file_error", "name": name,
                             "message": "file not found"})
                return
            os.remove(path)
        except Exception as e:
            print("[!] Delete failed: %s" % e)
            await reply({"type": "file_error", "name": name,
                         "message": "could not delete file"})
            return
        print("[+] Deleted: %s" % name)
        await reply({"type": "file_deleted", "name": name})

    elif mtype == "file_rename":
        old = safe_name(msg.get("old"))
        new = safe_name(msg.get("new"))
        if not old or not new:
            await reply({"type": "file_error", "message": "bad file name"})
            return
        src = os.path.join(uploads_dir(), old)
        dst = os.path.join(uploads_dir(), new)
        try:
            if not os.path.isfile(src):
                await reply({"type": "file_error", "name": old,
                             "message": "file not found"})
                return
            if os.path.exists(dst):
                await reply({"type": "file_error", "name": new,
                             "message": "a file with that name already exists"})
                return
            os.rename(src, dst)
        except Exception as e:
            print("[!] Rename failed: %s" % e)
            await reply({"type": "file_error", "name": old,
                         "message": "could not rename file"})
            return
        print("[+] Renamed: %s -> %s" % (old, new))
        await reply({"type": "file_renamed", "old": old, "new": new})


# ---------------------------------------------------------------------------
# Screen capture + frame sending
# ---------------------------------------------------------------------------

async def frame_sender(ws, send_lock, state):
    """Capture the primary monitor and stream JPEG frames (~30 FPS) while a
    client is connected. Adaptive: if capture+encode+send takes longer than
    the target interval, the sleep is skipped (FPS drops instead of lagging)
    and JPEG quality steps down; quality recovers when the pipeline is fast
    again. Resolution is never reduced."""
    slow_warned_at = 0.0
    quality = JPEG_QUALITY
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
                img.save(buf, format="JPEG", quality=quality)
                payload = base64.b64encode(buf.getvalue()).decode("ascii")
                await send_json(ws, send_lock, {"type": "frame",
                                                "data": payload})
            except websockets.exceptions.ConnectionClosed:
                print("[-] Lost connection while sending frames")
                return
            except Exception as e:
                print("[!] Frame capture/send error: %s" % e)
                await asyncio.sleep(1.0)
                continue

            elapsed = time.monotonic() - start
            if elapsed > FRAME_INTERVAL * 1.5:
                # Slow pipeline: ease JPEG quality down to protect the frame rate.
                quality = max(JPEG_QUALITY_MIN, quality - 5)
                now = time.monotonic()
                if now - slow_warned_at > 30:
                    print("[!] Slow frame pipeline (%.2fs) - quality %d"
                          % (elapsed, quality))
                    slow_warned_at = now
            elif elapsed < FRAME_INTERVAL * 0.6 and quality < JPEG_QUALITY:
                # Fast again: recover quality one notch at a time.
                quality = min(JPEG_QUALITY, quality + 2)
            await asyncio.sleep(max(0.0, FRAME_INTERVAL - elapsed))


# ---------------------------------------------------------------------------
# Server message handling
# ---------------------------------------------------------------------------

async def receive_loop(ws, state, send_lock, mouse, keyboard,
                       screen_w, screen_h):
    """Process server messages: client presence notifications, input,
    and file transfer."""
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
        elif mtype in ("file_start", "file_chunk", "file_end",
                       "file_get_list", "file_dl", "file_delete",
                       "file_rename"):
            await handle_file(msg, ws, send_lock, state)
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
                state = {"client_connected": False, "uploads": {}}
                send_lock = asyncio.Lock()

                sender = asyncio.create_task(frame_sender(ws, send_lock,
                                                           state))
                try:
                    await receive_loop(ws, state, send_lock, mouse, keyboard,
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
