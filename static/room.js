// Listen Together - room client.
// The server owns playback state; this page slaves its YouTube player to it.

const roomCode = location.pathname.split('/').pop();
const $ = (id) => document.getElementById(id);

const YT_PLAYING = 1, YT_PAUSED = 2, YT_BUFFERING = 3, YT_CUED = 5, YT_ENDED = 0;

let ws = null;
let myName = null;
let player = null;
let playerReady = false;

let room = null;        // latest state from server
let stateAt = 0;        // performance.now() when `room` arrived
let rtt = 0;            // ms, rolling estimate
let loadedId = null;    // video id currently loaded into the player
let cuedAt = 0;         // start position used for a cued (paused, not started) video
let endedFor = null;    // video id that finished locally, awaiting server advance
let lastSeekAt = 0;
let notPlayingTicks = 0;
let seeking = false;    // user is dragging the seek bar
let reconnectDelay = 500;

// ---------------------------------------------------------------- utilities

function fmt(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const mm = h ? String(m).padStart(2, '0') : m;
  return (h ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
}

let toastTimer;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3500);
}

function nameColor(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.codePointAt(0)) % 360;
  return `hsl(${h} 80% 72%)`;
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function expectedPos() {
  if (!room || !room.current) return 0;
  if (!room.playing) return room.position;
  return room.position + (performance.now() - stateAt + rtt / 2) / 1000;
}

function storageGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function storageSet(key, val) { try { localStorage.setItem(key, val); } catch {} }

// ---------------------------------------------------------------- websocket

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws/${roomCode}`);

  ws.onopen = () => {
    reconnectDelay = 500;
    ws.send(JSON.stringify({ type: 'join', name: myName }));
    $('conn').firstElementChild.textContent = 'Connected';
    $('conn').classList.add('ok');
  };

  ws.onclose = () => {
    $('conn').firstElementChild.textContent = 'Reconnecting…';
    $('conn').classList.remove('ok');
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 8000);
  };

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    switch (msg.type) {
      case 'welcome':
        myName = msg.name;
        break;
      case 'history':
        $('messages').innerHTML = '';
        msg.messages.forEach(addMessage);
        break;
      case 'chat':
        addMessage(msg);
        if (msg.kind === 'user' && msg.name !== myName) bumpUnread();
        break;
      case 'react':
        floatEmoji(msg.emoji, msg.name);
        break;
      case 'state':
        room = msg;
        stateAt = performance.now();
        renderRoom();
        applyState();
        break;
      case 'pong':
        if (typeof msg.t === 'number') {
          const sample = performance.now() - msg.t;
          rtt = rtt ? rtt * 0.7 + sample * 0.3 : sample;
        }
        break;
      case 'error':
        toast(msg.text);
        break;
    }
  };
}

setInterval(() => send({ type: 'ping', t: performance.now() }), 10000);

// ---------------------------------------------------------------- player

window.onYouTubeIframeAPIReady = function () {
  player = new YT.Player('player', {
    width: '100%',
    height: '100%',
    playerVars: {
      controls: 0, disablekb: 1, modestbranding: 1, rel: 0,
      playsinline: 1, iv_load_policy: 3, fs: 0,
    },
    events: {
      onReady: () => {
        playerReady = true;
        const vol = Number(storageGet('lt-volume') ?? 80);
        $('volume').value = vol;
        player.setVolume(vol);
        applyState();
      },
      onStateChange: (e) => {
        if (e.data === YT_ENDED && loadedId && endedFor !== loadedId) {
          endedFor = loadedId;
          send({ type: 'ended', videoId: loadedId });
        }
        if (e.data === YT_PLAYING) {
          notPlayingTicks = 0;
          $('unmuteBanner').hidden = true;
        }
      },
      onError: (e) => {
        if (!loadedId) return;
        const why = (e.data === 101 || e.data === 150)
          ? "The owner doesn't allow this video to be played on other sites"
          : "This video can't be played";
        toast(`${why} — skipping.`);
        endedFor = loadedId;
        send({ type: 'ended', videoId: loadedId });
      },
    },
  });
};
if (window.YT && window.YT.Player) window.onYouTubeIframeAPIReady();

function applyState() {
  if (!playerReady || !room) return;

  if (!room.current) {
    if (loadedId) player.stopVideo();
    loadedId = null;
    $('unmuteBanner').hidden = true;
    return;
  }

  const id = room.current.videoId;
  const target = expectedPos();

  if (id !== loadedId) {
    loadedId = id;
    endedFor = null;
    notPlayingTicks = 0;
    if (room.playing) {
      player.loadVideoById({ videoId: id, startSeconds: target });
    } else {
      cuedAt = target;
      player.cueVideoById({ videoId: id, startSeconds: target });
    }
    lastSeekAt = performance.now();
    return;
  }

  syncPlayer(true);
}

// Nudge the local player toward the room's playback state.
// `force` = a fresh state arrived (someone pressed play/pause/seek), so correct tighter.
function syncPlayer(force) {
  if (!playerReady || !room || !room.current || loadedId !== room.current.videoId) return;
  if (endedFor === loadedId) return;

  const state = player.getPlayerState();
  const target = expectedPos();
  const now = performance.now();

  if (room.playing) {
    if (state === YT_PLAYING) {
      const drift = Math.abs(player.getCurrentTime() - target);
      if (drift > (force ? 0.5 : 1.5) && (force || now - lastSeekAt > 3000)) {
        player.seekTo(target, true);
        lastSeekAt = now;
      }
    } else if (state !== YT_BUFFERING) {
      if (state === YT_PAUSED || state === YT_CUED || force) {
        player.seekTo(target, true);
        lastSeekAt = now;
      }
      player.playVideo();
    }
  } else {
    if (state === YT_CUED) {
      if (Math.abs(cuedAt - target) > 0.5) {
        cuedAt = target;
        player.cueVideoById({ videoId: loadedId, startSeconds: target });
      }
      return;
    }
    if (state === YT_PLAYING || state === YT_BUFFERING) player.pauseVideo();
    if (Math.abs(player.getCurrentTime() - target) > 0.5) player.seekTo(target, true);
  }
}

// Periodic drift correction + autoplay-blocked detection.
setInterval(() => {
  if (!playerReady || !room) return;
  syncPlayer(false);
  if (room.current && room.playing && endedFor !== loadedId) {
    const st = player.getPlayerState();
    notPlayingTicks = (st === YT_PLAYING) ? 0 : notPlayingTicks + 1;
    // Browser autoplay policy can block playback until the user clicks.
    if (notPlayingTicks >= 3 && st !== YT_BUFFERING) $('unmuteBanner').hidden = false;
  }
}, 1000);

$('unmuteBtn').addEventListener('click', () => {
  $('unmuteBanner').hidden = true;
  notPlayingTicks = 0;
  if (!playerReady) return;
  player.unMute();
  player.seekTo(expectedPos(), true);
  player.playVideo();
});

// ---------------------------------------------------------------- controls

function togglePlay() {
  if (!room || !room.current) return;
  const pos = playerReady && player.getCurrentTime ? player.getCurrentTime() : expectedPos();
  send({ type: room.playing ? 'pause' : 'play', position: pos || expectedPos() });
}
$('playBtn').addEventListener('click', togglePlay);
$('shield').addEventListener('click', togglePlay);

$('skipBtn').addEventListener('click', () => send({ type: 'skip' }));

$('seek').addEventListener('input', () => {
  seeking = true;
  const dur = playerReady ? player.getDuration() : 0;
  $('time').textContent = `${fmt(Number($('seek').value))} / ${fmt(dur)}`;
});
$('seek').addEventListener('change', () => {
  seeking = false;
  send({ type: 'seek', position: Number($('seek').value) });
});

$('volume').addEventListener('input', () => {
  const v = Number($('volume').value);
  storageSet('lt-volume', v);
  if (!playerReady) return;
  player.setVolume(v);
  if (v > 0 && player.isMuted()) player.unMute();
  $('muteBtn').textContent = v === 0 ? '🔇' : '🔊';
});

$('muteBtn').addEventListener('click', () => {
  if (!playerReady) return;
  if (player.isMuted()) { player.unMute(); $('muteBtn').textContent = '🔊'; }
  else { player.mute(); $('muteBtn').textContent = '🔇'; }
});

// Progress UI
setInterval(() => {
  const has = room && room.current;
  $('playBtn').textContent = has && room.playing ? '❚❚' : '▶';
  if (!has) {
    $('time').textContent = '0:00 / 0:00';
    $('seek').value = 0;
    return;
  }
  const dur = playerReady ? player.getDuration() || 0 : 0;
  const pos = Math.min(expectedPos(), dur || Infinity);
  if (!seeking) {
    $('seek').max = Math.max(dur, 1);
    $('seek').value = pos;
    $('time').textContent = `${fmt(pos)} / ${fmt(dur)}`;
  }
}, 250);

// ---------------------------------------------------------------- device + tabs

// Layout itself is pure CSS (media queries); JS only needs to know which panes
// are behind tabs so it can pick a sensible tab and show unread badges.
const mqPhone = matchMedia('(max-width: 759px), (orientation: landscape) and (max-height: 540px) and (max-width: 1199px)');
const mqTablet = matchMedia('(min-width: 760px) and (max-width: 1199px)');
const mqTouch = matchMedia('(pointer: coarse)');

function device() {
  if (mqPhone.matches) return 'phone';
  if (mqTablet.matches) return 'tablet';
  return 'desktop';
}

function isPaneVisible(name) {
  const d = device(), tab = $('room').dataset.tab;
  if (d === 'desktop') return true;
  if (d === 'tablet' && name === 'queue') return true;
  return tab === name;
}

function setTab(tab) {
  if (device() === 'tablet' && tab === 'queue') tab = 'chat';
  $('room').dataset.tab = tab;
  for (const b of $('tabs').querySelectorAll('button[data-tab]')) {
    b.classList.toggle('active', b.dataset.tab === tab);
  }
  if (isPaneVisible('chat')) {
    unread = 0;
    $('chatBadge').hidden = true;
    $('messages').scrollTop = $('messages').scrollHeight;
  }
}

function onDeviceChange() {
  document.documentElement.dataset.device = device();
  document.documentElement.dataset.touch = mqTouch.matches ? 'yes' : 'no';
  setTab($('room').dataset.tab);
  maxViewportH = 0;
  fitViewport();
}

// Compact player (phones): small video beside the controls, so chat/search get the room.
// On by default; the user's choice is remembered.
let miniPref = storageGet('lt-mini') !== 'no';
let keyboardOpen = false;

function updateMini() {
  const mini = keyboardOpen || miniPref;
  $('room').dataset.mini = mini ? 'yes' : 'no';
  $('room').dataset.kb = keyboardOpen ? 'yes' : 'no';
  $('miniBtn').textContent = mini ? '⤢' : '⤡';
  $('miniBtn').title = mini ? 'Expand video' : 'Shrink video';
}

$('miniBtn').addEventListener('click', () => {
  miniPref = !miniPref;
  storageSet('lt-mini', miniPref ? 'yes' : 'no');
  updateMini();
});

// Size the layout to the *visible* viewport so the on-screen keyboard doesn't
// cover the chat box, and detect when the keyboard is open.
let maxViewportH = 0;
function fitViewport() {
  const h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  maxViewportH = Math.max(maxViewportH, h);
  document.documentElement.style.setProperty('--app-h', `${Math.round(h)}px`);
  const wasOpen = keyboardOpen;
  keyboardOpen = device() === 'phone' && mqTouch.matches && h < maxViewportH * 0.75;
  updateMini();
  if (keyboardOpen) {
    window.scrollTo(0, 0);
    if (!wasOpen) $('messages').scrollTop = $('messages').scrollHeight;
  }
}
if (window.visualViewport) window.visualViewport.addEventListener('resize', fitViewport);
window.addEventListener('resize', fitViewport);
const mqPortrait = matchMedia('(orientation: portrait)');
for (const mq of [mqPhone, mqTablet, mqTouch, mqPortrait]) mq.addEventListener('change', onDeviceChange);

$('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (b) setTab(b.dataset.tab);
});

let unread = 0;
function bumpUnread() {
  if (isPaneVisible('chat')) return;
  unread++;
  $('chatBadge').textContent = unread > 99 ? '99+' : unread;
  $('chatBadge').hidden = false;
}

// ---------------------------------------------------------------- search

let searchAbort = null;

async function runSearch() {
  const q = $('searchInput').value.trim();
  if (!q) return;
  if (searchAbort) searchAbort.abort();
  searchAbort = new AbortController();
  $('searchStatus').textContent = 'Searching…';
  $('results').innerHTML = '';
  try {
    const resp = await fetch('/api/search?q=' + encodeURIComponent(q), { signal: searchAbort.signal });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Search failed');
    $('searchStatus').textContent = data.results.length ? '' : 'No results. Try different words.';
    renderResults(data.results);
    // Hide the phone keyboard so results are visible.
    if (mqTouch.matches) $('searchInput').blur();
  } catch (err) {
    if (err.name === 'AbortError') return;
    $('searchStatus').textContent = err.message || 'Search failed. Try again.';
  }
}

function renderResults(results) {
  const list = $('results');
  list.innerHTML = '';
  for (const r of results) {
    const li = document.createElement('li');
    li.className = 'result';

    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    const img = document.createElement('img');
    img.src = `https://i.ytimg.com/vi/${r.videoId}/mqdefault.jpg`;
    img.alt = '';
    img.loading = 'lazy';
    thumb.append(img);
    if (r.duration) {
      const dur = document.createElement('span');
      dur.className = 'dur';
      dur.textContent = r.duration;
      thumb.append(dur);
    }

    const text = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'r-title';
    title.textContent = r.title;
    title.title = r.title;
    const channel = document.createElement('div');
    channel.className = 'r-channel';
    channel.textContent = r.channel || '';
    text.append(title, channel);

    const actions = document.createElement('div');
    actions.className = 'r-actions';
    const play = document.createElement('button');
    play.className = 'primary';
    play.textContent = '▶';
    play.title = 'Play now for everyone';
    play.onclick = () => addVideo(r, true, li);
    const queue = document.createElement('button');
    queue.textContent = '+';
    queue.title = 'Add to queue';
    queue.onclick = () => addVideo(r, false, li);
    actions.append(play, queue);

    li.append(thumb, text, actions);
    list.append(li);
  }
}

function addVideo(r, playNow, li) {
  if (!ws || ws.readyState !== WebSocket.OPEN) { toast('Not connected yet — try again in a moment.'); return; }
  const startsNow = playNow || !(room && room.current);
  send({ type: 'add', url: r.videoId, playNow });
  li.classList.add('added');
  toast(startsNow ? `▶ Playing “${r.title}”` : `+ Added “${r.title}” to the queue`);
}

$('searchForm').addEventListener('submit', (e) => { e.preventDefault(); runSearch(); });
// Pasting a YouTube link searches (resolves) it straight away.
$('searchInput').addEventListener('paste', () => {
  setTimeout(() => { if (/youtu/i.test($('searchInput').value)) runSearch(); }, 0);
});

// ---------------------------------------------------------------- rendering

function renderRoom() {
  const cur = room.current;
  $('emptyPlayer').hidden = !!cur;
  $('npTitle').textContent = cur ? cur.title : 'Nothing playing';
  $('npSub').textContent = cur ? `added by ${cur.addedBy}` : 'Search for a song to get started';
  document.title = cur ? `🎵 ${cur.title} · Listen Together` : 'Room · Listen Together';

  const list = $('queueList');
  list.innerHTML = '';
  room.queue.forEach((t, i) => {
    const li = document.createElement('li');
    const img = document.createElement('img');
    img.src = `https://i.ytimg.com/vi/${t.videoId}/mqdefault.jpg`;
    img.alt = '';
    const text = document.createElement('div');
    text.className = 'q-text';
    const title = document.createElement('div');
    title.className = 'q-title';
    title.textContent = `${i + 1}. ${t.title}`;
    title.title = t.title;
    const by = document.createElement('div');
    by.className = 'q-by';
    by.textContent = `added by ${t.addedBy}`;
    text.append(title, by);
    const rm = document.createElement('button');
    rm.className = 'icon';
    rm.textContent = '✕';
    rm.title = 'Remove from queue';
    rm.onclick = () => send({ type: 'remove', index: i });
    li.append(img, text, rm);
    list.append(li);
  });
  $('queueEmpty').hidden = room.queue.length > 0;
  $('queueBadge').textContent = room.queue.length;
  $('queueBadge').hidden = room.queue.length === 0;

  $('userCount').textContent = room.users.length;
  const users = $('users');
  users.innerHTML = '';
  room.users.forEach((u) => {
    const pill = document.createElement('span');
    pill.className = 'user-pill' + (u === myName ? ' me' : '');
    pill.textContent = u === myName ? `${u} (you)` : u;
    pill.style.color = nameColor(u);
    users.append(pill);
  });
}

const EMOJI_ONLY_STRIP = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\u{1F1E6}-\u{1F1FF}‍️\s]/gu;
const HAS_EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}]/u;
function isEmojiOnly(text) {
  return HAS_EMOJI.test(text) && text.replace(EMOJI_ONLY_STRIP, '') === '' && [...text].length <= 16;
}

function addMessage(m) {
  const box = $('messages');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const div = document.createElement('div');
  if (m.kind === 'system') {
    div.className = 'msg system';
    div.textContent = m.text;
  } else {
    div.className = 'msg' + (isEmojiOnly(m.text) ? ' emoji-only' : '');
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = m.name;
    who.style.color = nameColor(m.name);
    const text = document.createElement('span');
    text.className = 'text';
    text.textContent = m.text;
    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = new Date(m.ts * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (div.classList.contains('emoji-only')) div.append(who, when, document.createElement('br'), text);
    else div.append(who, text, when);
  }
  box.append(div);
  if (nearBottom || m.name === myName) box.scrollTop = box.scrollHeight;
}

// ---------------------------------------------------------------- chat + emoji

const SHORTCUTS = { ':)': '🙂', ':-)': '🙂', ':D': '😄', ';)': '😉', ':(': '🙁', ':P': '😛', ':p': '😛', '<3': '❤️', ':o': '😮', ':O': '😮', 'xD': '😆', ":'(": '😢' };
function applyShortcuts(text) {
  return text.split(/(\s+)/).map((w) => SHORTCUTS[w] || w).join('');
}

$('chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = applyShortcuts($('chatInput').value.trim());
  if (!text) return;
  send({ type: 'chat', text });
  $('chatInput').value = '';
  $('emojiPicker').hidden = true;
});

const EMOJI = {
  '😀': '😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😋 😛 😜 🤪 😝 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 😌 😔 😪 😴 😷 🥵 🥶 🥴 😵 🤯 🤠 🥳 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 🥹 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 💀 🤡 👻 👽 🤖 💩',
  '👍': '👍 👎 👏 🙌 👐 🤲 🤝 🙏 ✌️ 🤞 🤟 🤘 👌 🤌 👈 👉 👆 👇 ☝️ ✋ 🤚 🖐️ 🖖 👋 🤙 💪 🫶 💃 🕺 👯 🧘 🙋 🙆 🙅 🤷 🤦 👀 👂 🧠 🫡 🫠',
  '❤️': '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 ♥️ 💯 💢 💥 💫 💦 💨 🔥 ✨ ⭐ 🌟 ⚡ 🌈 ☀️ 🌙 💤',
  '🎵': '🎵 🎶 🎤 🎧 🎼 🎹 🥁 🎷 🎺 🎸 🪕 🎻 📻 🔊 🔉 🔈 🔇 📢 🎙️ 💿 📀 🎚️ 🎛️ 🪩 🎉 🎊 🎈 🎁 🏆 🥇 🎬 🎮',
  '🍕': '🍕 🍔 🍟 🌭 🍿 🥓 🌮 🌯 🍣 🍜 🍩 🍪 🎂 🍰 🧁 🍫 🍬 🍭 🍦 🍉 🍓 🍒 🍑 🥭 🍍 🥑 ☕ 🍵 🧋 🥤 🍺 🍻 🥂 🍷 🍸 🍹',
  '🐶': '🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🙈 🙉 🙊 🐔 🐧 🐦 🦄 🐝 🦋 🐢 🐍 🐙 🐬 🐳 🦈 🌸 🌹 🌻 🌷 🌵 🍀',
};

let activeTab = Object.keys(EMOJI)[0];
function renderEmojiPicker() {
  const tabs = $('emojiTabs');
  tabs.innerHTML = '';
  for (const key of Object.keys(EMOJI)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = key;
    b.className = key === activeTab ? 'active' : '';
    b.onclick = () => { activeTab = key; renderEmojiPicker(); };
    tabs.append(b);
  }
  const grid = $('emojiGrid');
  grid.innerHTML = '';
  for (const em of EMOJI[activeTab].split(' ')) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = em;
    b.onclick = () => insertEmoji(em);
    grid.append(b);
  }
}

function insertEmoji(em) {
  const input = $('chatInput');
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  input.value = input.value.slice(0, start) + em + input.value.slice(end);
  const caret = start + em.length;
  input.focus();
  input.setSelectionRange(caret, caret);
}

$('emojiBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  const picker = $('emojiPicker');
  picker.hidden = !picker.hidden;
  if (!picker.hidden) renderEmojiPicker();
});
document.addEventListener('click', (e) => {
  if (!$('emojiPicker').contains(e.target) && e.target !== $('emojiBtn')) $('emojiPicker').hidden = true;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $('emojiPicker').hidden = true;
});

// Quick reactions float over the player for everyone.
const REACTIONS = ['❤️', '🔥', '😂', '👏', '🎉', '😍', '🥹', '💃', '🤯', '👀'];
for (const em of REACTIONS) {
  const b = document.createElement('button');
  b.textContent = em;
  b.title = 'React';
  b.onclick = () => send({ type: 'react', emoji: em });
  $('reactionBar').append(b);
}

function floatEmoji(emoji, name) {
  const layer = $('reactions');
  const el = document.createElement('div');
  el.className = 'floating-emoji';
  el.style.left = `${10 + Math.random() * 80}%`;
  el.textContent = emoji;
  const label = document.createElement('span');
  label.textContent = name;
  el.append(label);
  layer.append(el);
  setTimeout(() => el.remove(), 2700);
}

// ---------------------------------------------------------------- join

$('roomCode').textContent = `Room: ${roomCode}`;
$('copyLink').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    toast('Invite link copied — send it to your friends!');
  } catch {
    toast(location.href);
  }
});

onDeviceChange();

$('nameInput').value = storageGet('lt-name') || '';
if (!mqTouch.matches) $('nameInput').focus();
$('nameForm').addEventListener('submit', (e) => {
  e.preventDefault();
  myName = $('nameInput').value.trim().slice(0, 24) || 'Guest';
  storageSet('lt-name', myName);
  $('joinOverlay').hidden = true;
  connect();
});
