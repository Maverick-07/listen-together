"""Listen Together - watch/listen to YouTube in sync with friends, with live chat.

Run:  uvicorn server:app --host 0.0.0.0 --port 8000
"""
import asyncio
import html
import json
import os
import re
import secrets
import time
import urllib.parse
import urllib.request
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

STATIC = Path(__file__).parent / "static"
MAX_CHAT_HISTORY = 100
MAX_MESSAGE_LEN = 500
MAX_NAME_LEN = 24

# Optional: official YouTube Data API v3 key. Without it, search falls back to
# reading YouTube's public results page.
YOUTUBE_API_KEY = os.environ.get("YOUTUBE_API_KEY", "").strip()
SEARCH_CACHE_TTL = 15 * 60
SEARCH_CACHE_MAX = 300
BROWSER_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/128.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
    "Cookie": "CONSENT=YES+cb; SOCS=CAI",
}

VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")

app = FastAPI()
app.mount("/static", StaticFiles(directory=STATIC), name="static")


def extract_video_id(text: str) -> str | None:
    """Accept any common YouTube URL form, or a bare 11-char video id."""
    text = text.strip()
    if VIDEO_ID_RE.match(text):
        return text
    if not re.match(r"^https?://", text):
        text = "https://" + text
    try:
        url = urllib.parse.urlparse(text)
    except ValueError:
        return None
    host = (url.hostname or "").lower().removeprefix("www.").removeprefix("m.")
    candidate = None
    if host == "youtu.be":
        candidate = url.path.lstrip("/").split("/")[0]
    elif host in ("youtube.com", "music.youtube.com", "youtube-nocookie.com"):
        if url.path == "/watch":
            candidate = urllib.parse.parse_qs(url.query).get("v", [None])[0]
        else:
            parts = url.path.strip("/").split("/")
            if len(parts) >= 2 and parts[0] in ("embed", "shorts", "live", "v"):
                candidate = parts[1]
    if candidate and VIDEO_ID_RE.match(candidate):
        return candidate
    return None


def _fetch_title(video_id: str) -> str | None:
    url = "https://www.youtube.com/oembed?format=json&url=" + urllib.parse.quote(
        f"https://www.youtube.com/watch?v={video_id}"
    )
    try:
        with urllib.request.urlopen(url, timeout=5) as resp:
            return json.load(resp).get("title")
    except Exception:
        return None


async def fetch_title(video_id: str) -> str:
    return await asyncio.to_thread(_fetch_title, video_id) or f"YouTube video {video_id}"


# ---------------------------------------------------------------- search

def _get(url: str, headers: dict | None = None) -> bytes:
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=8) as resp:
        return resp.read()


def _iso_duration(value: str) -> str:
    m = re.fullmatch(r"P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", value or "")
    if not m:
        return ""
    d, h, mi, s = (int(x or 0) for x in m.groups())
    h += d * 24
    return f"{h}:{mi:02d}:{s:02d}" if h else f"{mi}:{s:02d}"


def _search_api(query: str) -> list[dict]:
    base = "https://www.googleapis.com/youtube/v3/"
    found = json.loads(_get(base + "search?" + urllib.parse.urlencode({
        "part": "snippet", "type": "video", "videoEmbeddable": "true",
        "maxResults": 20, "q": query, "key": YOUTUBE_API_KEY,
    })))
    items = [i for i in found.get("items", []) if i.get("id", {}).get("videoId")]
    ids = [i["id"]["videoId"] for i in items]
    durations = {}
    if ids:
        details = json.loads(_get(base + "videos?" + urllib.parse.urlencode({
            "part": "contentDetails", "id": ",".join(ids), "key": YOUTUBE_API_KEY,
        })))
        durations = {v["id"]: _iso_duration(v["contentDetails"].get("duration", ""))
                     for v in details.get("items", [])}
    return [{
        "videoId": i["id"]["videoId"],
        "title": html.unescape(i["snippet"]["title"]),
        "channel": html.unescape(i["snippet"].get("channelTitle", "")),
        "duration": durations.get(i["id"]["videoId"], ""),
    } for i in items]


def _find_renderers(node, key: str):
    if isinstance(node, dict):
        if key in node:
            yield node[key]
        for v in node.values():
            yield from _find_renderers(v, key)
    elif isinstance(node, list):
        for v in node:
            yield from _find_renderers(v, key)


def _search_scrape(query: str) -> list[dict]:
    # sp=EgIQAQ== restricts results to videos (no channels/playlists).
    url = "https://www.youtube.com/results?" + urllib.parse.urlencode(
        {"search_query": query, "sp": "EgIQAQ=="})
    page = _get(url, BROWSER_HEADERS).decode("utf-8", "replace")
    m = re.search(r"var ytInitialData\s*=\s*(\{.*?\});\s*</script>", page, re.S)
    if not m:
        raise RuntimeError("could not read YouTube results page")
    results, seen = [], set()
    for vr in _find_renderers(json.loads(m.group(1)), "videoRenderer"):
        vid = vr.get("videoId")
        duration = vr.get("lengthText", {}).get("simpleText")
        if not vid or vid in seen or not duration:  # skip live streams / upcoming
            continue
        seen.add(vid)
        title = "".join(r.get("text", "") for r in vr.get("title", {}).get("runs", []))
        channel = (vr.get("ownerText", {}).get("runs") or [{}])[0].get("text", "")
        results.append({"videoId": vid, "title": title, "channel": channel, "duration": duration})
        if len(results) >= 20:
            break
    return results


search_cache: OrderedDict[str, tuple[float, list]] = OrderedDict()


async def search_youtube(query: str) -> list[dict]:
    key = query.lower()
    hit = search_cache.get(key)
    if hit and time.time() - hit[0] < SEARCH_CACHE_TTL:
        search_cache.move_to_end(key)
        return hit[1]
    results = None
    if YOUTUBE_API_KEY:
        try:
            results = await asyncio.to_thread(_search_api, query)
        except Exception:
            results = None  # e.g. quota exhausted - fall back to scraping
    if results is None:
        results = await asyncio.to_thread(_search_scrape, query)
    search_cache[key] = (time.time(), results)
    while len(search_cache) > SEARCH_CACHE_MAX:
        search_cache.popitem(last=False)
    return results


@dataclass
class Track:
    video_id: str
    title: str
    added_by: str

    def to_dict(self):
        return {"videoId": self.video_id, "title": self.title, "addedBy": self.added_by}


@dataclass
class Room:
    code: str
    clients: dict = field(default_factory=dict)  # WebSocket -> display name
    current: Track | None = None
    queue: list = field(default_factory=list)
    playing: bool = False
    # Playback position (seconds) as of `updated_at` (server monotonic time).
    position: float = 0.0
    updated_at: float = field(default_factory=time.monotonic)
    chat: list = field(default_factory=list)

    def current_position(self) -> float:
        if self.playing:
            return self.position + (time.monotonic() - self.updated_at)
        return self.position

    def set_playback(self, playing: bool, position: float):
        self.playing = playing
        self.position = max(0.0, position)
        self.updated_at = time.monotonic()

    def state(self) -> dict:
        return {
            "type": "state",
            "current": self.current.to_dict() if self.current else None,
            "queue": [t.to_dict() for t in self.queue],
            "playing": self.playing,
            "position": self.current_position(),
            "users": sorted(self.clients.values(), key=str.lower),
        }

    async def broadcast(self, message: dict):
        data = json.dumps(message)
        dead = []
        for ws in list(self.clients):
            try:
                await ws.send_text(data)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.clients.pop(ws, None)

    async def broadcast_state(self):
        await self.broadcast(self.state())

    async def system(self, text: str):
        await self.add_chat({"kind": "system", "text": text})

    async def add_chat(self, msg: dict):
        msg = {"type": "chat", "id": secrets.token_hex(6), "ts": time.time(), **msg}
        self.chat.append(msg)
        del self.chat[:-MAX_CHAT_HISTORY]
        await self.broadcast(msg)

    def play_next(self):
        if self.queue:
            self.current = self.queue.pop(0)
            self.set_playback(True, 0.0)
        else:
            self.current = None
            self.set_playback(False, 0.0)


rooms: dict[str, Room] = {}


def new_room_code() -> str:
    alphabet = "abcdefghjkmnpqrstuvwxyz23456789"
    while True:
        code = "".join(secrets.choice(alphabet) for _ in range(6))
        if code not in rooms:
            return code


def clean_room_code(code: str) -> str:
    return re.sub(r"[^a-z0-9-]", "", code.lower())[:32]


@app.get("/")
async def index():
    return FileResponse(STATIC / "index.html")


@app.get("/healthz")
async def healthz():
    return {"ok": True, "rooms": len(rooms)}


@app.get("/api/search")
async def api_search(q: str = ""):
    q = q.strip()[:100]
    if not q:
        return {"results": []}
    if "youtu" in q.lower():  # a pasted link: resolve it instead of searching
        video_id = extract_video_id(q)
        if not video_id:
            return JSONResponse({"error": "That doesn't look like a YouTube video link."}, status_code=400)
        return {"results": [{"videoId": video_id, "title": await fetch_title(video_id),
                             "channel": "Pasted link", "duration": ""}]}
    try:
        return {"results": await search_youtube(q)}
    except Exception:
        return JSONResponse({"error": "Search is unavailable right now. You can still paste a link."},
                            status_code=502)


@app.get("/new")
async def new_room():
    return RedirectResponse(f"/r/{new_room_code()}")


@app.get("/r/{code}")
async def room_page(code: str):
    cleaned = clean_room_code(code)
    if not cleaned:
        return RedirectResponse("/new")
    if cleaned != code:
        return RedirectResponse(f"/r/{cleaned}")
    return FileResponse(STATIC / "room.html")


@app.websocket("/ws/{code}")
async def room_socket(ws: WebSocket, code: str):
    code = clean_room_code(code)
    if not code:
        await ws.close()
        return
    await ws.accept()

    # First message must be a join with a display name.
    try:
        hello = json.loads(await ws.receive_text())
    except (WebSocketDisconnect, ValueError):
        return
    name = str(hello.get("name", "")).strip()[:MAX_NAME_LEN] or "Guest"

    room = rooms.setdefault(code, Room(code))
    taken = set(room.clients.values())
    base, n = name, 2
    while name in taken:
        name = f"{base} {n}"
        n += 1
    room.clients[ws] = name

    await ws.send_text(json.dumps({"type": "welcome", "name": name, "room": code}))
    await ws.send_text(json.dumps({"type": "history", "messages": room.chat}))
    await room.system(f"{name} joined")
    await room.broadcast_state()

    try:
        while True:
            try:
                msg = json.loads(await ws.receive_text())
            except ValueError:
                continue
            await handle(room, ws, name, msg)
    except WebSocketDisconnect:
        pass
    finally:
        room.clients.pop(ws, None)
        if room.clients:
            await room.system(f"{name} left")
            await room.broadcast_state()
        else:
            rooms.pop(code, None)


async def handle(room: Room, ws: WebSocket, name: str, msg: dict):
    kind = msg.get("type")

    if kind == "ping":
        await ws.send_text(json.dumps({"type": "pong", "t": msg.get("t")}))

    elif kind == "chat":
        text = str(msg.get("text", "")).strip()[:MAX_MESSAGE_LEN]
        if text:
            await room.add_chat({"kind": "user", "name": name, "text": text})

    elif kind == "react":
        emoji = str(msg.get("emoji", ""))[:8]
        if emoji:
            await room.broadcast({"type": "react", "emoji": emoji, "name": name})

    elif kind == "add":
        video_id = extract_video_id(str(msg.get("url", "")))
        if not video_id:
            await ws.send_text(json.dumps(
                {"type": "error", "text": "That doesn't look like a YouTube link."}))
            return
        track = Track(video_id, await fetch_title(video_id), name)
        if msg.get("playNow") or room.current is None:
            room.current = track
            room.set_playback(True, 0.0)
            await room.system(f"{name} is playing “{track.title}”")
        else:
            room.queue.append(track)
            await room.system(f"{name} queued “{track.title}”")
        await room.broadcast_state()

    elif kind in ("play", "pause", "seek"):
        if room.current is None:
            return
        try:
            position = float(msg.get("position", room.current_position()))
        except (TypeError, ValueError):
            position = room.current_position()
        playing = {"play": True, "pause": False, "seek": room.playing}[kind]
        room.set_playback(playing, position)
        await room.broadcast_state()

    elif kind == "ended":
        # Several clients report the end; only advance once, for the matching track.
        if room.current and msg.get("videoId") == room.current.video_id:
            room.play_next()
            await room.broadcast_state()

    elif kind == "skip":
        if room.current:
            await room.system(f"{name} skipped “{room.current.title}”")
            room.play_next()
            await room.broadcast_state()

    elif kind == "remove":
        try:
            idx = int(msg.get("index"))
        except (TypeError, ValueError):
            return
        if 0 <= idx < len(room.queue):
            room.queue.pop(idx)
            await room.broadcast_state()
