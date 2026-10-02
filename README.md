# Listen Together

Listen to YouTube songs in sync with friends. Create a room, share the link, and paste YouTube links. Everyone hears the same moment of the song, and you can chat with emojis while it plays.

## Features

- **Rooms**: one click creates a room with a shareable link like `/r/k7m2qp`.
- **YouTube search**: search from inside the room, then press ▶ to play a song now or + to add it to the queue. Pasting a YouTube link into the same box also works, including `youtu.be/`, `shorts/` and `music.youtube.com` links.
- **Fits every device**: desktop shows three columns (search | player + queue | chat). Tablets show the player with tabbed Search/Chat beside it. Phones keep the player at the top with Search / Queue / Chat tabs below, and turning a phone sideways gives a side-by-side view. Touch screens get larger buttons, and the page does not zoom in when you type on iPhone.
- **Synced playback**: play, pause, seek and skip apply to everyone. Each player corrects itself when it drifts more than about 1.5s.
- **Queue**: songs play in order, and any song can be removed.
- **Chat**: emoji picker, text shortcuts like `:)` → 🙂 and `<3` → ❤️, and emoji-only messages shown larger.
- **Reactions**: tap ❤️ 🔥 😂 🎉 … and the emoji floats over the player on everyone's screen.
- Volume and mute are per person.

## Run it

```powershell
cd listen-together
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn server:app --host 0.0.0.0 --port 8000
```

Open http://localhost:8000.

To let friends join:
- **Same Wi-Fi**: share `http://<your-LAN-IP>:8000/r/<code>`. Find your IP with `ipconfig`. You may need to allow Python through Windows Firewall.
- **Over the internet**: expose the server with a tunnel, for example `cloudflared tunnel --url http://localhost:8000` or `ngrok http 8000`, then share that URL. You can also deploy to a host that supports WebSockets (Render, Railway, Fly.io).

## Deploy to Render (free)

1. Create a GitHub repo. Upload `server.py`, `requirements.txt`, `render.yaml`, `README.md` and the `static/` folder. Do not upload `.venv`.
2. On [render.com](https://render.com), go to **New → Blueprint** and choose the repo. Render reads `render.yaml` and deploys.
3. Share `https://<your-service>.onrender.com`.

On the free plan, the service goes to sleep after about 15 minutes with no visitors. The first visit after that takes 30–60s to wake it up, and any open rooms are cleared. Every push to GitHub redeploys automatically.

### Search: optional API key

Search works without any setup by reading YouTube's public results page. This method can break if YouTube changes its page, and YouTube sometimes blocks requests from cloud servers. For reliable search, add a free **YouTube Data API v3** key:

1. Go to [Google Cloud Console](https://console.cloud.google.com/), create a project, enable **YouTube Data API v3** and create an **API key**.
2. Set it as the `YOUTUBE_API_KEY` environment variable. Render asks for it when you create the Blueprint, and you can add it later under **Environment**.

The free quota allows about 100 searches a day. Results are cached for 15 minutes, and if the quota runs out, search switches back to the no-key method automatically.

## How it works

- `server.py` (FastAPI + WebSockets) holds each room's state: the current track, the queue, whether it is playing, and the playback position stored as `position at time T`. Every action is sent to the server, which broadcasts the new state to everyone.
- `static/room.js` makes the YouTube IFrame player follow that state. YouTube's own controls are hidden so that every play, pause and seek is a deliberate, synced action.
- Rooms are kept in memory and disappear when the last person leaves. Restarting the server clears them.

## Limitations

- Some videos have embedding turned off by their owner. These are skipped automatically, with a notice.
- Browsers can block autoplay until you interact with the page. If that happens, a "Click to join the music" button appears.
