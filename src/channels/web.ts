import http from 'http';

import { ASSISTANT_NAME } from '../config.js';
import { readEnvFile } from '../env.js';
import {
  getChatMessages,
  storeChatMetadata,
  storeMessageDirect,
} from '../db.js';
import { logger } from '../logger.js';
import { Channel } from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';

const WEB_JID = 'web:main';
const WEB_FOLDER = 'web';

export class WebChannel implements Channel {
  name = 'web';
  private server: http.Server | null = null;
  private opts: ChannelOpts;
  private port: number;
  private secret: string | null;
  private sseClients: Map<string, http.ServerResponse> = new Map();

  constructor(port: number, secret: string | null, opts: ChannelOpts) {
    this.port = port;
    this.secret = secret;
    this.opts = opts;
    this.server = http.createServer(this.handleRequest.bind(this));
  }

  private isAuthorized(req: http.IncomingMessage): boolean {
    if (!this.secret) return true;
    const auth = req.headers['authorization'];
    if (auth === `Bearer ${this.secret}`) return true;
    const url = new URL(req.url || '/', `http://localhost`);
    return url.searchParams.get('token') === this.secret;
  }

  private handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const url = new URL(req.url || '/', `http://localhost:${this.port}`);
    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(UI_HTML);
      return;
    }

    if (!this.isAuthorized(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    if (req.method === 'GET' && pathname === '/events') {
      this.handleSSE(req, res);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/message') {
      this.handleInbound(req, res);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/history') {
      this.handleHistory(res);
      return;
    }

    res.writeHead(404);
    res.end();
  }

  private handleSSE(req: http.IncomingMessage, res: http.ServerResponse): void {
    const clientId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');

    this.sseClients.set(clientId, res);
    logger.debug({ clientId }, 'Web SSE client connected');

    req.on('close', () => {
      this.sseClients.delete(clientId);
      logger.debug({ clientId }, 'Web SSE client disconnected');
    });
  }

  private handleInbound(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        const { text } = JSON.parse(body) as { text?: unknown };
        if (!text || typeof text !== 'string' || !text.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing text field' }));
          return;
        }

        const groups = this.opts.registeredGroups();
        if (!groups[WEB_JID]) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Web group not registered yet' }));
          return;
        }

        const id = `web-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const ts = new Date().toISOString();

        this.opts.onMessage(WEB_JID, {
          id,
          chat_jid: WEB_JID,
          sender: 'web-user',
          sender_name: 'You',
          content: text.trim(),
          timestamp: ts,
          is_from_me: false,
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
  }

  private handleHistory(res: http.ServerResponse): void {
    try {
      const messages = getChatMessages(WEB_JID, 100);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ messages }));
    } catch (err) {
      logger.error({ err }, 'Web: failed to load history');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to load history' }));
    }
  }

  async connect(): Promise<void> {
    // Auto-register web group if not already present
    const groups = this.opts.registeredGroups();
    if (!groups[WEB_JID] && this.opts.registerGroup) {
      logger.info('Web: auto-registering web group');
      this.opts.registerGroup(WEB_JID, {
        name: 'Web Chat',
        folder: WEB_FOLDER,
        trigger: '',
        added_at: new Date().toISOString(),
        requiresTrigger: false,
        isMain: false,
      });
    }

    // Ensure chat metadata exists so messages FK constraint is satisfied
    storeChatMetadata(WEB_JID, new Date().toISOString(), 'Web Chat', 'web');

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.port, () => {
        logger.info({ port: this.port }, 'Web channel listening');
        console.log(`\n  Web chat: http://localhost:${this.port}\n`);
        resolve();
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!jid.startsWith('web:')) return;

    // Store agent response in DB for history
    storeMessageDirect({
      id: `web-bot-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      chat_jid: jid,
      sender: ASSISTANT_NAME,
      sender_name: ASSISTANT_NAME,
      content: text,
      timestamp: new Date().toISOString(),
      is_from_me: true,
      is_bot_message: true,
    });

    // Push to all connected SSE clients
    const payload = `data: ${JSON.stringify({ type: 'message', text })}\n\n`;
    for (const [clientId, clientRes] of this.sseClients) {
      try {
        clientRes.write(payload);
      } catch {
        this.sseClients.delete(clientId);
      }
    }
  }

  isConnected(): boolean {
    return this.server?.listening ?? false;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('web:');
  }

  async disconnect(): Promise<void> {
    for (const clientRes of this.sseClients.values()) {
      try {
        clientRes.end();
      } catch {
        /* ignore */
      }
    }
    this.sseClients.clear();
    await new Promise<void>((resolve) => {
      this.server?.close(() => resolve());
      if (!this.server?.listening) resolve();
    });
    this.server = null;
  }
}

registerChannel('web', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['WEB_PORT', 'WEB_SECRET']);
  const portStr = process.env.WEB_PORT || envVars.WEB_PORT || '';
  if (!portStr) return null;
  const port = parseInt(portStr, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    logger.warn({ portStr }, 'Web: invalid WEB_PORT value, skipping');
    return null;
  }
  const secret = process.env.WEB_SECRET || envVars.WEB_SECRET || null;
  return new WebChannel(port, secret, opts);
});

// ---------------------------------------------------------------------------
// Embedded chat UI (served at GET /)
// ---------------------------------------------------------------------------

const UI_HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>NanoClaw</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg:           #f5f4ed;
      --surface:      #faf9f5;
      --card:         #ffffff;
      --sand:         #e8e6dc;
      --near-black:   #141413;
      --terracotta:   #c96442;
      --coral:        #d97757;
      --charcoal:     #4d4c48;
      --olive:        #5e5d59;
      --stone:        #87867f;
      --silver:       #b0aea5;
      --border-cream: #f0eee6;
      --border-warm:  #e8e6dc;
      --dark-surface: #30302e;
      --focus:        #3898ec;
      --online:       #4ade80;
      --offline:      #ef4444;
      --r-sm:   8px;
      --r-md:   12px;
      --r-lg:   16px;
      --r-xl:   32px;
      --shadow-card: rgba(0,0,0,0.05) 0px 4px 24px;
      --shadow-ring: 0px 0px 0px 1px #d1cfc5;
    }

    html, body {
      height: 100%;
    }

    body {
      background: var(--bg);
      color: var(--near-black);
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 14px;
      line-height: 1.60;
      height: 100dvh;
      display: flex;
      overflow: hidden;
    }

    /* ── Sidebar ── */
    #sidebar {
      width: 240px;
      flex-shrink: 0;
      background: var(--surface);
      border-right: 1px solid var(--border-warm);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    #sidebar-header {
      padding: 20px 16px 16px;
      border-bottom: 1px solid var(--border-cream);
      flex-shrink: 0;
    }

    #sidebar-header h1 {
      font-family: Georgia, 'Times New Roman', serif;
      font-weight: 500;
      font-size: 17px;
      color: var(--near-black);
      letter-spacing: -0.01em;
    }

    #sidebar-list {
      flex: 1;
      overflow-y: auto;
      padding: 8px 0 16px;
    }

    #sidebar-list::-webkit-scrollbar { width: 3px; }
    #sidebar-list::-webkit-scrollbar-thumb { background: var(--border-warm); border-radius: 2px; }

    .sidebar-group {
      margin-top: 8px;
    }

    .sidebar-group-label {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--stone);
      padding: 8px 16px 4px;
      user-select: none;
    }

    .sidebar-item {
      display: block;
      width: 100%;
      padding: 7px 16px;
      background: transparent;
      border: none;
      text-align: left;
      cursor: pointer;
      font-family: inherit;
      font-size: 13px;
      line-height: 1.4;
      color: var(--charcoal);
      transition: background 0.12s;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .sidebar-item:hover {
      background: var(--border-cream);
    }

    .sidebar-item.active {
      background: var(--sand);
      color: var(--near-black);
      font-weight: 500;
    }

    /* ── Main area ── */
    #main {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      min-width: 0;
    }

    #main-header {
      flex-shrink: 0;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 14px 24px;
      background: var(--surface);
      border-bottom: 1px solid var(--border-cream);
    }

    #main-header h2 {
      font-family: Georgia, 'Times New Roman', serif;
      font-weight: 500;
      font-size: 15px;
      color: var(--near-black);
      flex: 1;
    }

    #status {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--sand);
      flex-shrink: 0;
      transition: background 0.3s;
    }
    #status.online  { background: var(--online); }
    #status.offline { background: var(--offline); }

    /* ── Messages ── */
    #messages {
      flex: 1;
      overflow-y: auto;
      padding: 24px 24px 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      scroll-behavior: smooth;
    }

    #messages::-webkit-scrollbar { width: 4px; }
    #messages::-webkit-scrollbar-thumb { background: var(--border-warm); border-radius: 2px; }

    /* Date divider */
    .date-divider {
      display: flex;
      align-items: center;
      gap: 12px;
      margin: 8px 0 4px;
    }

    .date-divider::before,
    .date-divider::after {
      content: '';
      flex: 1;
      height: 1px;
      background: var(--border-cream);
    }

    .date-divider span {
      font-size: 11px;
      color: var(--stone);
      white-space: nowrap;
      padding: 0 2px;
    }

    /* Message bubbles */
    .msg {
      display: flex;
      flex-direction: column;
      gap: 3px;
      max-width: min(78%, 620px);
    }

    .msg.user  { align-self: flex-end;   align-items: flex-end; }
    .msg.agent { align-self: flex-start; align-items: flex-start; }

    .bubble {
      padding: 10px 14px;
      border-radius: var(--r-lg);
      font-size: 14px;
      line-height: 1.60;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .user .bubble {
      background: var(--near-black);
      color: var(--silver);
      border-bottom-right-radius: 4px;
    }

    .agent .bubble {
      background: var(--card);
      color: var(--near-black);
      border: 1px solid var(--border-cream);
      border-bottom-left-radius: 4px;
      box-shadow: var(--shadow-card);
    }

    .ts {
      font-size: 11px;
      color: var(--stone);
      padding: 0 2px;
    }

    /* Thinking dots */
    #thinking {
      display: none;
      align-self: flex-start;
      background: var(--card);
      border: 1px solid var(--border-cream);
      box-shadow: var(--shadow-card);
      border-radius: var(--r-lg);
      border-bottom-left-radius: 4px;
      padding: 12px 16px;
      gap: 5px;
      align-items: center;
    }

    #thinking.visible { display: flex; }

    #thinking span {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--silver);
      animation: blink 1.4s infinite both;
    }

    #thinking span:nth-child(2) { animation-delay: 0.22s; }
    #thinking span:nth-child(3) { animation-delay: 0.44s; }

    @keyframes blink {
      0%, 80%, 100% { opacity: 0.25; transform: scale(0.80); }
      40%           { opacity: 1;    transform: scale(1); }
    }

    /* ── Footer / input ── */
    #footer {
      flex-shrink: 0;
      padding: 12px 24px 20px;
      background: var(--surface);
      border-top: 1px solid var(--border-cream);
    }

    .input-row {
      display: flex;
      align-items: flex-end;
      gap: 8px;
      background: var(--card);
      border: 1px solid var(--border-warm);
      border-radius: var(--r-md);
      padding: 8px 8px 8px 14px;
      transition: border-color 0.15s, box-shadow 0.15s;
    }

    .input-row:focus-within {
      border-color: var(--focus);
      box-shadow: 0 0 0 3px rgba(56, 152, 236, 0.12);
    }

    textarea {
      flex: 1;
      background: transparent;
      border: none;
      color: var(--near-black);
      font-family: inherit;
      font-size: 14px;
      line-height: 1.5;
      resize: none;
      min-height: 22px;
      max-height: 150px;
      outline: none;
    }

    textarea::placeholder { color: var(--silver); }

    #send {
      flex-shrink: 0;
      width: 34px;
      height: 34px;
      background: var(--near-black);
      border: none;
      border-radius: var(--r-sm);
      color: var(--surface);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.15s, opacity 0.15s;
    }

    #send:hover:not(:disabled) {
      background: var(--charcoal);
      box-shadow: var(--shadow-ring);
    }

    #send:disabled {
      background: var(--sand);
      color: var(--stone);
      cursor: default;
    }

    #send svg {
      width: 15px;
      height: 15px;
      fill: none;
      stroke: currentColor;
      stroke-width: 1.8;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    /* ── Mobile: hide sidebar ── */
    @media (max-width: 639px) {
      #sidebar { display: none; }
    }
  </style>
</head>
<body>

  <!-- Sidebar -->
  <aside id="sidebar">
    <div id="sidebar-header">
      <h1>NanoClaw</h1>
    </div>
    <nav id="sidebar-list" aria-label="Chat history"></nav>
  </aside>

  <!-- Main chat area -->
  <div id="main">
    <header id="main-header">
      <h2>Web Chat</h2>
      <div id="status" title="Connection status"></div>
    </header>

    <div id="messages" role="log" aria-live="polite" aria-label="Messages">
      <div id="thinking" aria-label="Agent is typing">
        <span></span><span></span><span></span>
      </div>
    </div>

    <footer id="footer">
      <div class="input-row">
        <textarea
          id="input"
          placeholder="Message…"
          rows="1"
          aria-label="Message input"
        ></textarea>
        <button id="send" disabled title="Send (Enter)" aria-label="Send message">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <line x1="1" y1="15" x2="15" y2="1"/>
            <polyline points="6,1 15,1 15,10"/>
          </svg>
        </button>
      </div>
    </footer>
  </div>

<script>
(function () {
  'use strict';

  const messagesEl  = document.getElementById('messages');
  const thinkingEl  = document.getElementById('thinking');
  const inputEl     = document.getElementById('input');
  const sendBtn     = document.getElementById('send');
  const statusEl    = document.getElementById('status');
  const sidebarList = document.getElementById('sidebar-list');

  let es      = null;
  let waiting = false;

  const SECRET = new URLSearchParams(location.search).get('token') || '';

  /* ── URL helpers ── */
  function qs(path) {
    return SECRET ? path + '?token=' + encodeURIComponent(SECRET) : path;
  }

  /* ── Status dot ── */
  function setStatus(s) {
    statusEl.className = s;
    statusEl.title = s === 'online' ? 'Connected' : s === 'offline' ? 'Disconnected' : 'Connecting…';
  }

  /* ── Formatting ── */
  function fmtTime(iso) {
    return (iso ? new Date(iso) : new Date())
      .toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function toYMD(iso) {
    const d = iso ? new Date(iso) : new Date();
    return d.toISOString().slice(0, 10); // YYYY-MM-DD
  }

  function fmtDateLabel(ymd) {
    const d     = new Date(ymd + 'T00:00:00');
    const today = new Date(); today.setHours(0,0,0,0);
    const diff  = Math.round((today - d) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  /* ── Date dividers ── */
  let lastRenderedDay = null;

  function ensureDateDivider(ymd) {
    if (lastRenderedDay === ymd) return;
    lastRenderedDay = ymd;

    const div = document.createElement('div');
    div.className = 'date-divider';
    div.dataset.day = ymd;
    div.innerHTML = '<span>' + fmtDateLabel(ymd) + '</span>';
    messagesEl.insertBefore(div, thinkingEl);
  }

  /* ── Append a message bubble ── */
  function appendMessage(text, role, ts) {
    const ymd = toYMD(ts);
    ensureDateDivider(ymd);

    const wrap = document.createElement('div');
    wrap.className = 'msg ' + role;

    const b = document.createElement('div');
    b.className = 'bubble';
    b.textContent = text;

    const t = document.createElement('div');
    t.className = 'ts';
    t.textContent = fmtTime(ts);

    wrap.appendChild(b);
    wrap.appendChild(t);
    messagesEl.insertBefore(wrap, thinkingEl);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  /* ── Thinking indicator ── */
  function setThinking(on) {
    thinkingEl.className = on ? 'visible' : '';
    if (on) messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  /* ── Sidebar ── */
  // Stores: { [ymd]: { snippet: string, label: string } }
  const sidebarDays = {};

  function sidebarPeriod(ymd) {
    const today = new Date(); today.setHours(0,0,0,0);
    const d     = new Date(ymd + 'T00:00:00');
    const diff  = Math.round((today - d) / 86400000);
    if (diff === 0)  return 'TODAY';
    if (diff === 1)  return 'YESTERDAY';
    if (diff <= 7)   return 'LAST 7 DAYS';
    return 'OLDER';
  }

  const PERIOD_ORDER = ['TODAY', 'YESTERDAY', 'LAST 7 DAYS', 'OLDER'];

  function renderSidebar() {
    sidebarList.innerHTML = '';

    // Group days by period
    const groups = {};
    for (const ymd of Object.keys(sidebarDays).sort().reverse()) {
      const period = sidebarPeriod(ymd);
      if (!groups[period]) groups[period] = [];
      groups[period].push(ymd);
    }

    for (const period of PERIOD_ORDER) {
      if (!groups[period] || groups[period].length === 0) continue;

      const grp = document.createElement('div');
      grp.className = 'sidebar-group';

      const lbl = document.createElement('div');
      lbl.className = 'sidebar-group-label';
      lbl.textContent = period;
      grp.appendChild(lbl);

      for (const ymd of groups[period]) {
        const info   = sidebarDays[ymd];
        const btn    = document.createElement('button');
        btn.className = 'sidebar-item';
        btn.type      = 'button';
        btn.title     = info.snippet;
        btn.textContent = info.snippet;
        btn.dataset.day = ymd;

        btn.addEventListener('click', () => {
          // Scroll to date divider in main
          const divider = messagesEl.querySelector('[data-day="' + ymd + '"]');
          if (divider) {
            divider.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
          // Highlight active
          sidebarList.querySelectorAll('.sidebar-item').forEach(el => el.classList.remove('active'));
          btn.classList.add('active');
        });

        grp.appendChild(btn);
      }

      sidebarList.appendChild(grp);
    }
  }

  function registerSidebarEntry(ymd, text, role) {
    // Only index user messages as snippet, fallback to agent if nothing else
    if (sidebarDays[ymd] && role !== 'user') return;
    if (sidebarDays[ymd] && role === 'user' && sidebarDays[ymd]._hasUser) return;

    const snippet = text.replace(/\\s+/g, ' ').trim().slice(0, 36)
      + (text.trim().length > 36 ? '…' : '');

    sidebarDays[ymd] = {
      snippet,
      _hasUser: role === 'user',
    };
  }

  /* ── Load history ── */
  async function loadHistory() {
    try {
      const r = await fetch(qs('/api/history'));
      if (!r.ok) return;
      const { messages } = await r.json();
      for (const m of (messages || [])) {
        const role = m.is_from_me ? 'agent' : 'user';
        const ymd  = toYMD(m.timestamp);
        registerSidebarEntry(ymd, m.content, role);
        appendMessage(m.content, role, m.timestamp);
      }
      renderSidebar();
    } catch (_) { /* silent */ }
  }

  /* ── SSE connection ── */
  function connectSSE() {
    if (es) { es.close(); es = null; }
    setStatus('');

    es = new EventSource(qs('/events'));

    es.onopen = () => {
      setStatus('online');
      updateSendBtn();
    };

    es.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data);
        if (d.type === 'message') {
          setThinking(false);
          const now = new Date().toISOString();
          const ymd = toYMD(now);
          registerSidebarEntry(ymd, d.text, 'agent');
          appendMessage(d.text, 'agent', now);
          renderSidebar();
          waiting = false;
          updateSendBtn();
        }
      } catch (_) { /* ignore malformed */ }
    };

    es.onerror = () => {
      setStatus('offline');
      es.close();
      es = null;
      updateSendBtn();
      setTimeout(connectSSE, 3000);
    };
  }

  /* ── Send button state ── */
  function updateSendBtn() {
    sendBtn.disabled = waiting || !inputEl.value.trim() || !es || es.readyState !== 1;
  }

  /* ── Send message ── */
  async function send() {
    const text = inputEl.value.trim();
    if (!text || waiting || !es || es.readyState !== 1) return;

    waiting = true;
    const now = new Date().toISOString();
    const ymd = toYMD(now);
    registerSidebarEntry(ymd, text, 'user');
    appendMessage(text, 'user', now);
    renderSidebar();

    inputEl.value = '';
    inputEl.style.height = 'auto';
    setThinking(true);
    updateSendBtn();

    try {
      const r = await fetch(qs('/api/message'), {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ text }),
      });
      if (!r.ok) throw new Error('send failed');
    } catch (_) {
      setThinking(false);
      waiting = false;
      updateSendBtn();
    }
  }

  /* ── Event listeners ── */
  sendBtn.addEventListener('click', send);

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });

  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 150) + 'px';
    updateSendBtn();
  });

  /* ── Boot ── */
  loadHistory().then(connectSSE);
}());
</script>
</body>
</html>`;
