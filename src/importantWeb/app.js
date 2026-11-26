const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

const state = {
  workers: [],
  workerId: null,
  chats: [],
  contacts: {},
  chatJid: null,
  messages: [],
  hasMore: false,
  loadingOlder: false,
  search: '',
  events: null
};

const TZ = 'Asia/Jakarta';
const fmtTime = new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
const fmtDay = new Intl.DateTimeFormat('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: TZ });
const fmtShort = new Intl.DateTimeFormat('id-ID', { day: '2-digit', month: '2-digit', year: '2-digit', timeZone: TZ });
const dayKey = (ts) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(ts));

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: { 'X-Requested-With': 'iw', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) }
  });
  if (response.status === 401 && !path.endsWith('/login')) {
    showLogin();
    throw new Error('Belum login');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

// ---------- names, avatars ----------
const numberOf = (jid) => String(jid || '').split('@')[0].split(':')[0];
const prettyNumber = (digits) => digits && /^\d{8,15}$/.test(digits) ? `+${digits}` : digits;

function nameFor(jid, fallback = '') {
  if (!jid) return fallback;
  if (jid === 'me') return 'Kamu';
  const chat = state.chats.find((item) => item.jid === jid);
  return state.contacts[jid] || chat?.displayName || fallback || prettyNumber(chat?.phone || numberOf(jid));
}

function chatTitle(chat) {
  return chat.displayName || prettyNumber(chat.phone || numberOf(chat.jid)) || chat.jid;
}

const COLORS = ['#e17076', '#7bc862', '#65aadd', '#a695e7', '#ee7aae', '#6ec9cb', '#faa774', '#ce9a52', '#3d9be9', '#e5a339'];
function colorFor(seed) {
  let hash = 0;
  for (const char of String(seed)) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return COLORS[hash % COLORS.length];
}

function initials(name) {
  const clean = String(name || '').replace(/[^\p{L}\p{N} ]/gu, '').trim();
  if (!clean) return '#';
  const parts = clean.split(/\s+/);
  return (parts[0][0] + (parts[1]?.[0] || '')).toUpperCase();
}

function avatar(url, name, seed, size) {
  const box = el('div', 'avatar');
  if (size) { box.style.width = `${size}px`; box.style.height = `${size}px`; }
  box.style.background = colorFor(seed);
  box.textContent = initials(name);
  if (url) {
    const img = new Image();
    img.alt = '';
    img.loading = 'lazy';
    img.onload = () => { box.textContent = ''; box.append(img); };
    img.src = url;
  }
  return box;
}

// ---------- WhatsApp text formatting (escape first, then add fixed tags only) ----------
function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function formatText(text) {
  let html = escapeHtml(text);
  const blocks = [];
  html = html.replace(/```([\s\S]+?)```/g, (_, code) => { blocks.push(code); return `\u0000${blocks.length - 1}\u0000`; });
  html = html.replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g, (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
  html = html.replace(/(^|[\s(])\*(?!\s)([^*\n]+?)\*(?=$|[\s).,!?:;])/g, '$1<strong>$2</strong>');
  html = html.replace(/(^|[\s(])_(?!\s)([^_\n]+?)_(?=$|[\s).,!?:;])/g, '$1<em>$2</em>');
  html = html.replace(/(^|[\s(])~(?!\s)([^~\n]+?)~(?=$|[\s).,!?:;])/g, '$1<del>$2</del>');
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  html = html.replace(/\u0000(\d+)\u0000/g, (_, index) => `<pre>${blocks[Number(index)]}</pre>`);
  return html;
}

function previewText(chat) {
  const prefix = chat.lastFromMe ? '✓ ' : '';
  return prefix + (chat.lastPreview || '');
}

function listTime(ts) {
  if (!ts) return '';
  const today = dayKey(Date.now());
  const key = dayKey(ts);
  if (key === today) return fmtTime.format(new Date(ts));
  if (key === dayKey(Date.now() - 86_400_000)) return 'Kemarin';
  return fmtShort.format(new Date(ts));
}

function dayLabel(ts) {
  const key = dayKey(ts);
  if (key === dayKey(Date.now())) return 'Hari ini';
  if (key === dayKey(Date.now() - 86_400_000)) return 'Kemarin';
  return fmtDay.format(new Date(ts));
}

function formatBytes(bytes) {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

// ---------- unread markers (per browser) ----------
const seenKey = () => `iw-seen-${state.workerId}`;
const seenMap = () => { try { return JSON.parse(localStorage.getItem(seenKey()) || '{}'); } catch { return {}; } };
function markSeen(jid, ts) {
  const map = seenMap();
  if ((map[jid] || 0) >= ts) return;
  map[jid] = ts;
  localStorage.setItem(seenKey(), JSON.stringify(map));
}

// ---------- login ----------
function showLogin(message = '') {
  state.events?.close();
  state.events = null;
  $('app').hidden = true;
  $('login').hidden = false;
  $('login-error').textContent = message;
  $('login-key').focus();
}

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.target.querySelector('button');
  button.disabled = true;
  $('login-error').textContent = '';
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify({ key: $('login-key').value }) });
    $('login-key').value = '';
    await boot();
  } catch (error) {
    $('login-error').textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$('logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

// ---------- workers ----------
function renderTabs() {
  const tabs = $('tabs');
  tabs.replaceChildren();
  for (const worker of state.workers) {
    const tab = el('button', `tab${worker.id === state.workerId ? ' active' : ''}`);
    tab.append(avatar(worker.hasAvatar ? `/api/w/${worker.id}/avatar` : '', worker.name || worker.phone, `w${worker.id}`));
    tab.append(el('span', '', worker.name || prettyNumber(worker.phone)));
    tab.append(el('span', `dot${worker.status === 'online' ? ' online' : ''}`));
    tab.title = `Worker #${worker.id} · ${prettyNumber(worker.phone)} · ${worker.status}`;
    tab.addEventListener('click', () => selectWorker(worker.id));
    tabs.append(tab);
  }
}

function renderWorkerCard() {
  const worker = state.workers.find((item) => item.id === state.workerId);
  const card = $('worker-card');
  card.replaceChildren();
  if (!worker) return;
  card.append(avatar(worker.hasAvatar ? `/api/w/${worker.id}/avatar` : '', worker.name || worker.phone, `w${worker.id}`, 40));
  const text = el('div');
  text.append(el('strong', '', worker.name || prettyNumber(worker.phone)));
  text.append(el('small', '', `#${worker.id} · ${prettyNumber(worker.phone)} · ${worker.status === 'online' ? 'online' : worker.status}`));
  card.append(text);
}

async function selectWorker(id) {
  state.workerId = id;
  state.chatJid = null;
  localStorage.setItem('iw-worker', String(id));
  renderTabs();
  renderWorkerCard();
  closeChat();
  await loadChats();
}

// ---------- chat list ----------
async function loadChats() {
  if (!state.workerId) return;
  const workerId = state.workerId;
  const data = await api(`/api/w/${workerId}/chats`);
  if (workerId !== state.workerId) return;
  state.chats = data.chats;
  state.contacts = data.contacts || {};
  renderChats();
}

function renderChats() {
  const list = $('chat-list');
  const query = state.search.toLowerCase();
  const seen = seenMap();
  const chats = state.chats.filter((chat) => !query
    || chatTitle(chat).toLowerCase().includes(query)
    || String(chat.phone || chat.jid).includes(query)
    || String(chat.lastPreview || '').toLowerCase().includes(query));
  list.replaceChildren();
  $('chat-empty').hidden = state.chats.length > 0;
  for (const chat of chats) {
    const unread = !chat.lastFromMe && chat.lastTs > (seen[chat.jid] || 0) && chat.jid !== state.chatJid;
    const item = el('li', `chat-item${chat.jid === state.chatJid ? ' active' : ''}${unread ? ' unread' : ''}`);
    item.append(avatar(chat.avatarId ? `/api/w/${state.workerId}/avatar/${chat.avatarId}` : '', chatTitle(chat), chat.jid));
    const body = el('div', 'body');
    const top = el('div', 'row');
    top.append(el('span', 'name', `${chat.isGroup ? '👥 ' : ''}${chatTitle(chat)}`), el('span', 'time', listTime(chat.lastTs)));
    const bottom = el('div', 'row');
    bottom.append(el('span', 'preview', previewText(chat)));
    if (unread) bottom.append(el('span', 'badge', '●'));
    body.append(top, bottom);
    item.append(body);
    item.addEventListener('click', () => openChat(chat.jid));
    list.append(item);
  }
}

$('search').addEventListener('input', (event) => {
  state.search = event.target.value.trim();
  renderChats();
});

// ---------- messages ----------
function closeChat() {
  $('chat-view').hidden = true;
  $('chat-placeholder').hidden = false;
  $('app').classList.remove('chat-open');
}

$('back').addEventListener('click', () => {
  state.chatJid = null;
  closeChat();
  renderChats();
});

async function openChat(jid) {
  state.chatJid = jid;
  state.messages = [];
  $('chat-placeholder').hidden = true;
  $('chat-view').hidden = false;
  $('app').classList.add('chat-open');
  renderChatHeader();
  $('messages').replaceChildren(el('div', 'loader', 'Memuat pesan…'));
  renderChats();
  await loadMessages({ scroll: 'bottom' });
}

function renderChatHeader() {
  const chat = state.chats.find((item) => item.jid === state.chatJid) || { jid: state.chatJid };
  const box = $('chat-avatar');
  const fresh = avatar(chat.avatarId ? `/api/w/${state.workerId}/avatar/${chat.avatarId}` : '', chatTitle(chat), chat.jid);
  fresh.id = 'chat-avatar';
  box.replaceWith(fresh);
  $('chat-name').textContent = chatTitle(chat);
  const parts = [];
  if (chat.isGroup) parts.push(chat.members ? `Grup · ${chat.members} anggota` : 'Grup');
  else {
    const number = prettyNumber(chat.phone || numberOf(chat.jid));
    if (number && number !== chatTitle(chat)) parts.push(number);
    if (chat.pushName && chat.pushName !== chatTitle(chat)) parts.push(`~${chat.pushName}`);
  }
  if (chat.count) parts.push(`${chat.count} pesan tercatat`);
  $('chat-sub').textContent = parts.join(' · ');
}

async function loadMessages({ scroll = 'keep', before = null } = {}) {
  const jid = state.chatJid;
  const workerId = state.workerId;
  const params = new URLSearchParams({ limit: '60' });
  if (before) params.set('before', String(before));
  const data = await api(`/api/w/${workerId}/chats/${encodeURIComponent(jid)}/messages?${params}`);
  if (jid !== state.chatJid || workerId !== state.workerId) return;
  if (before) {
    const known = new Set(state.messages.map((item) => item.id));
    state.messages = [...data.messages.filter((item) => !known.has(item.id)), ...state.messages];
  } else {
    const older = state.messages.filter((item) => data.messages.length && item.ts < data.messages[0].ts);
    state.messages = [...older, ...data.messages];
  }
  // Only a fresh open or a scroll-up page tells whether older messages exist.
  if (before || state.messages.length === data.messages.length) state.hasMore = data.hasMore;
  renderMessages(scroll);
  const last = state.messages.at(-1);
  if (last) markSeen(jid, last.ts);
}

function renderMessages(scroll) {
  const pane = $('messages');
  const atBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 120;
  const oldHeight = pane.scrollHeight;
  const oldTop = pane.scrollTop;
  pane.replaceChildren();
  if (state.hasMore) pane.append(el('div', 'loader', 'Gulir ke atas untuk pesan lama'));
  if (!state.messages.length) pane.append(el('div', 'loader', 'Belum ada pesan.'));
  const chat = state.chats.find((item) => item.jid === state.chatJid);
  let lastDay = '';
  let lastSender = '';
  for (const message of state.messages) {
    const day = dayKey(message.ts);
    if (day !== lastDay) {
      pane.append(el('div', 'day', dayLabel(message.ts)));
      lastDay = day;
      lastSender = '';
    }
    const first = message.sender !== lastSender;
    lastSender = message.sender;
    pane.append(renderMessage(message, { first, group: chat?.isGroup }));
  }
  if (scroll === 'bottom' || (scroll === 'auto' && atBottom)) pane.scrollTop = pane.scrollHeight;
  else if (scroll === 'older') pane.scrollTop = pane.scrollHeight - oldHeight + oldTop;
  else pane.scrollTop = oldTop;
}

function mediaUrl(media, extra = '') {
  return `/api/w/${state.workerId}/media/${media.id}${extra}`;
}

function renderMedia(message, bubble) {
  const media = message.media;
  if (!media) return false;
  if (!media.id) {
    bubble.append(el('div', 'missing', `${kindLabel(message.kind)} tidak tersimpan${media.skipped ? ` (${media.skipped})` : ''}`));
    return false;
  }
  const url = mediaUrl(media);
  if (message.kind === 'sticker') {
    const img = el('img', 'sticker');
    img.src = url;
    img.alt = 'Stiker';
    img.loading = 'lazy';
    bubble.append(img);
    bubble.append(stickerMenu(media));
    if (media.audioId || media.sound) {
      // Sound sticker: no separate player. A tap plays the sound once, like WhatsApp.
      const wrap = el('div', 'sticker-wrap');
      img.replaceWith(wrap);
      wrap.append(img);
      const icon = el('span', 'sticker-sound-icon', media.audioId ? '🔊' : '🔇');
      icon.title = media.audioId ? `Stiker beraudio${media.soundSeconds ? ` · ${media.soundSeconds} dtk` : ''} · klik untuk putar` : 'Audio stiker tidak tersimpan';
      wrap.append(icon);
      if (media.audioId) {
        let audio = null;
        wrap.classList.add('playable');
        wrap.addEventListener('click', () => {
          if (!audio) {
            audio = new Audio(mediaUrl({ id: media.audioId }));
            audio.loop = false;
            audio.addEventListener('ended', () => wrap.classList.remove('playing'));
            audio.addEventListener('pause', () => wrap.classList.remove('playing'));
          }
          if (!audio.paused) { audio.pause(); return; }
          audio.currentTime = 0;
          audio.play().then(() => wrap.classList.add('playing')).catch(() => {});
        });
      }
    }
    return true;
  }
  if (message.kind === 'image') {
    const img = el('img', 'media');
    img.src = url;
    img.alt = 'Foto';
    img.loading = 'lazy';
    img.addEventListener('click', () => openViewer(url));
    bubble.append(img);
    return false;
  }
  if (message.kind === 'video' || message.kind === 'gif') {
    const video = el('video', 'media');
    video.src = url;
    video.preload = 'metadata';
    video.playsInline = true;
    if (message.kind === 'gif') { video.autoplay = true; video.loop = true; video.muted = true; }
    else video.controls = true;
    bubble.append(video);
    return false;
  }
  if (message.kind === 'audio' || message.kind === 'voice') {
    const audio = el('audio');
    audio.src = url;
    audio.controls = true;
    audio.preload = 'none';
    bubble.append(audio);
    return false;
  }
  const name = media.fileName || 'Dokumen';
  const link = el('a', 'doc');
  link.href = mediaUrl(media, `?download=1&name=${encodeURIComponent(name)}`);
  const ext = (name.split('.').pop() || 'file').slice(0, 4);
  const info = el('div');
  info.append(el('strong', '', name), el('small', '', [formatBytes(media.size), media.mimetype].filter(Boolean).join(' · ')));
  link.append(el('span', 'ext', ext), info);
  bubble.append(link);
  return false;
}

// ⋮ in the sticker's corner: sound sticker -> mp4, animated -> gif, static -> png.
function stickerMenu(media) {
  const sound = Boolean(media.audioId);
  const format = sound ? 'MP4 (dengan audio)' : (media.animated ? 'GIF' : 'PNG');
  const wrap = el('div', 'sticker-menu');
  const button = el('button', 'sticker-menu-btn', '⋮');
  button.type = 'button';
  button.title = 'Opsi stiker';
  const menu = el('div', 'sticker-menu-list');
  menu.hidden = true;
  const link = el('a', '', `⬇️ Download ${format}`);
  link.href = `/api/w/${state.workerId}/sticker/${media.id}${sound ? `?audio=${media.audioId}` : ''}`;
  link.download = '';
  link.addEventListener('click', (event) => {
    event.stopPropagation();
    menu.hidden = true;
    link.textContent = '⏳ Menyiapkan…';
    setTimeout(() => { link.textContent = `⬇️ Download ${format}`; }, 4000);
  });
  menu.append(link);
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    document.querySelectorAll('.sticker-menu-list').forEach((item) => { if (item !== menu) item.hidden = true; });
    menu.hidden = !menu.hidden;
  });
  wrap.append(button, menu);
  return wrap;
}
document.addEventListener('click', () => document.querySelectorAll('.sticker-menu-list').forEach((item) => { item.hidden = true; }));

function badge(kind, label, title) {
  const node = el('span', `badge-flag ${kind}`, label);
  node.title = title;
  return node;
}

function kindLabel(kind) {
  return { image: 'Foto', video: 'Video', gif: 'GIF', audio: 'Audio', voice: 'Pesan suara', sticker: 'Stiker', document: 'Dokumen' }[kind] || 'Media';
}

function renderMessage(message, { first, group }) {
  const flags = [
    message.deleted ? 'deleted' : '',
    message.edited ? 'edited' : '',
    message.viewOnce ? 'viewonce' : ''
  ].filter(Boolean);
  const row = el('div', `msg ${message.fromMe ? 'out' : 'in'}${first ? ' first' : ''}${flags.length ? ` changed ${flags.join(' ')}` : ''}`);
  row.dataset.id = message.id;
  const bubble = el('div', 'bubble');
  if (flags.length) {
    const badges = el('div', 'badges');
    if (message.deleted) badges.append(badge('deleted', '🚫 deleted', `Dihapus ${message.fromMe ? 'oleh kamu' : 'oleh pengirim'} · ${fmtTime.format(new Date(message.deleted))}`));
    if (message.edited) badges.append(badge('edited', '✏️ edited', `Diedit · ${fmtTime.format(new Date(message.edited))}`));
    if (message.viewOnce) badges.append(badge('viewonce', '① view once', 'Pesan sekali lihat'));
    bubble.append(badges);
  }
  if (group && !message.fromMe && first) {
    const sender = el('div', 'sender', nameFor(message.sender, message.pushName));
    sender.style.color = colorFor(message.sender);
    bubble.append(sender);
  }
  if (message.forwarded) bubble.append(el('div', 'tag', '↪ Diteruskan'));
  if (message.quoted) {
    const quote = el('div', 'quoted');
    quote.append(el('strong', '', nameFor(message.quoted.sender, 'Pesan')));
    quote.append(el('span', '', message.quoted.text || kindLabel(message.quoted.kind)));
    quote.addEventListener('click', () => jumpTo(message.quoted.id));
    bubble.append(quote);
  }
  const bare = renderMedia(message, bubble);
  if (bare && !message.text) bubble.classList.add('bare');
  if (message.kind === 'location' && message.location) {
    const box = el('div', 'location');
    const link = el('a');
    link.href = `https://maps.google.com/?q=${message.location.lat},${message.location.lng}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = `📍 ${message.location.name || `${message.location.lat.toFixed(5)}, ${message.location.lng.toFixed(5)}`}`;
    box.append(link);
    bubble.append(box);
  }
  if (message.kind === 'contact' && message.contacts?.length) {
    for (const contact of message.contacts) bubble.append(el('div', 'contact-card', `👤 ${contact.name}${contact.phone ? ` · ${prettyNumber(contact.phone)}` : ''}`));
  }
  const showText = message.text && !(message.kind === 'contact');
  if (showText) {
    const text = el('div', 'text');
    if (message.kind === 'poll') {
      text.append(el('strong', '', `📊 ${message.text}`));
      const list = el('ul', 'poll');
      for (const option of message.poll || []) list.append(el('li', '', option));
      text.append(list);
    } else {
      text.innerHTML = formatText(message.text);
    }
    bubble.append(text);
  }
  if (message.history?.length) {
    const old = el('div', 'history');
    for (const item of message.history) {
      const row = el('div', 'history-item');
      row.append(el('small', '', `Sebelum diedit · ${fmtTime.format(new Date(item.ts))}`));
      const text = el('div', 'text');
      text.innerHTML = formatText(item.text || '');
      row.append(text);
      old.append(row);
    }
    bubble.append(old);
  }
  const meta = el('span', 'meta');
  meta.append(document.createTextNode(fmtTime.format(new Date(message.ts))));
  if (showText) bubble.querySelector('.text').append(meta);
  else bubble.append(meta);
  row.append(bubble);
  const reactions = Object.entries(message.reactions || {});
  if (reactions.length) {
    const box = el('div', 'reactions');
    for (const [who, emoji] of reactions.slice(0, 4)) {
      const chip = el('span', `reaction${who === 'me' ? ' mine' : ''}`);
      chip.append(el('b', '', emoji), el('small', '', nameFor(who)));
      box.append(chip);
    }
    if (reactions.length > 4) box.append(el('span', 'reaction more', `+${reactions.length - 4}`));
    box.title = reactions.map(([who, emoji]) => `${emoji} ${nameFor(who)}`).join('\n');
    row.append(box);
  }
  return row;
}

function jumpTo(id) {
  const target = $('messages').querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (!target) return;
  target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  target.classList.remove('flash');
  void target.offsetWidth;
  target.classList.add('flash');
}

$('messages').addEventListener('scroll', async (event) => {
  const pane = event.target;
  if (pane.scrollTop > 80 || !state.hasMore || state.loadingOlder || !state.messages.length) return;
  state.loadingOlder = true;
  try { await loadMessages({ before: state.messages[0].ts, scroll: 'older' }); } finally { state.loadingOlder = false; }
});

function openViewer(url) {
  const viewer = $('viewer');
  const img = new Image();
  img.src = url;
  img.alt = '';
  viewer.replaceChildren(img);
  viewer.hidden = false;
}
$('viewer').addEventListener('click', () => { $('viewer').hidden = true; });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') $('viewer').hidden = true; });

// ---------- settings ----------
$('open-settings').addEventListener('click', async () => {
  const worker = state.workers.find((item) => item.id === state.workerId);
  if (!worker) return;
  $('settings-title').textContent = `Pengaturan · ${worker.name || prettyNumber(worker.phone)}`;
  $('settings-usage').textContent = 'Menghitung…';
  $('settings').showModal();
  const data = await api(`/api/w/${worker.id}/settings`);
  $('retention').checked = data.retention7d;
  $('settings-usage').textContent = `Data tersimpan: ${formatBytes(data.usage) || '0 B'} · ${state.chats.length} chat`;
});

$('retention').addEventListener('change', async (event) => {
  const enabled = event.target.checked;
  try {
    await api(`/api/w/${state.workerId}/retention`, { method: 'PUT', body: JSON.stringify({ enabled }) });
    if (enabled) await loadChats();
  } catch (error) {
    event.target.checked = !enabled;
    alert(error.message);
  }
});

$('purge').addEventListener('click', async () => {
  const worker = state.workers.find((item) => item.id === state.workerId);
  const answer = prompt(`Hapus SEMUA pesan & media worker #${worker.id} dari server?\nKetik HAPUS untuk lanjut.`);
  if (answer !== 'HAPUS') return;
  await api(`/api/w/${worker.id}/data`, { method: 'DELETE' });
  $('settings').close();
  state.chatJid = null;
  closeChat();
  await loadChats();
});

// ---------- live ----------
let chatsTimer = null;
let messagesTimer = null;
function connectEvents() {
  state.events?.close();
  const source = new EventSource('/api/events');
  state.events = source;
  source.onopen = () => $('live').classList.add('on');
  source.onerror = () => {
    $('live').classList.remove('on');
    api('/api/workers').catch(() => {});
  };
  source.addEventListener('message', (event) => {
    const payload = JSON.parse(event.data);
    if (payload.workerId !== state.workerId) return;
    clearTimeout(chatsTimer);
    chatsTimer = setTimeout(() => loadChats().catch(() => {}), 400);
    if (payload.event?.chat === state.chatJid) {
      clearTimeout(messagesTimer);
      messagesTimer = setTimeout(() => loadMessages({ scroll: 'auto' }).catch(() => {}), 250);
    }
  });
  source.addEventListener('purge', (event) => {
    const payload = JSON.parse(event.data);
    if (payload.workerId !== state.workerId) return;
    loadChats().then(() => { if (state.chatJid) loadMessages({ scroll: 'keep' }); }).catch(() => {});
  });
}

async function boot() {
  const data = await api('/api/workers');
  state.workers = data.workers;
  $('login').hidden = true;
  $('app').hidden = false;
  if (!state.workers.length) {
    $('tabs').replaceChildren(el('span', '', 'Belum ada worker dengan service important.'));
    return;
  }
  const saved = Number(localStorage.getItem('iw-worker'));
  await selectWorker(state.workers.some((item) => item.id === saved) ? saved : state.workers[0].id);
  connectEvents();
}

setInterval(() => {
  if ($('app').hidden) return;
  api('/api/workers').then((data) => { state.workers = data.workers; renderTabs(); renderWorkerCard(); }).catch(() => {});
}, 60_000);

boot().catch(() => showLogin());
