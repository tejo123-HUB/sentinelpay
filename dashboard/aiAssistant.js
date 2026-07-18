// Global AI Assistant widget -- a persistent, dashboard-wide floating chat (FAB + panel), replacing
// the previous implementation that lived buried as a small, easy-to-miss panel at the bottom of the
// Analytics tab's grid, invisible from every other view. Talks to the same POST /ai/chat endpoint
// (server/routes/ai.js -> server/aiAssistant.js) -- this file is presentation only, no scoring/
// business logic lives here, same separation every other dashboard/*.js file already follows.
//
// Markup lives in index.html's `.ai-widget` block, a sibling of every `.view <main>` (not nested
// inside one), so opening/closing it and its conversation state survive switching tabs.

const AI_MAX_MESSAGE_LENGTH = 1000;
const AI_LOG_MAX_MESSAGES = 200; // cap DOM growth across a long-running demo session, same reasoning as MAX_TABLE_ROWS in app.js

let aiWidgetOpened = false; // becomes true the first time the panel is opened -- used only to dismiss the one-time attention badge
let aiRequestInFlight = false;

function aiFormatMessageText(text) {
  // Assistant replies use "\n• " for bullet lists (see server/aiAssistant.js's greeting/fallback
  // messages) -- escape first (never trust transaction/account data echoed back in a reply), then
  // turn newlines into real line breaks so the list actually renders as one item per line.
  return escapeHtml(text).replace(/\n/g, '<br>');
}

function aiAppendMessage(role, text, { typing = false } = {}) {
  const log = document.getElementById('ai-widget-log');
  if (!log) return null;

  const msg = document.createElement('div');
  msg.className = `ai-msg ai-msg-${role}`;
  if (typing) msg.classList.add('ai-msg-typing');

  const avatar = document.createElement('span');
  avatar.className = 'ai-avatar';
  avatar.setAttribute('aria-hidden', 'true');
  avatar.textContent = role === 'user' ? '' : '✦';

  const bubble = document.createElement('div');
  bubble.className = 'ai-bubble';
  if (typing) {
    bubble.innerHTML = '<span class="ai-typing-dot"></span><span class="ai-typing-dot"></span><span class="ai-typing-dot"></span>';
  } else {
    bubble.innerHTML = aiFormatMessageText(text);
  }

  msg.appendChild(avatar);
  msg.appendChild(bubble);
  log.appendChild(msg);
  log.scrollTop = log.scrollHeight;

  while (log.children.length > AI_LOG_MAX_MESSAGES) {
    log.removeChild(log.firstElementChild);
  }
  return msg;
}

async function aiSendMessage(rawMessage) {
  const message = (rawMessage || '').trim();
  if (!message || aiRequestInFlight) return;

  const input = document.getElementById('ai-widget-input');
  const sendBtn = document.getElementById('ai-widget-send');
  const suggestions = document.getElementById('ai-widget-suggestions');

  aiAppendMessage('user', message);
  if (input) input.value = '';
  if (suggestions) suggestions.classList.add('hidden'); // once a real conversation starts, quick chips just take up space

  aiRequestInFlight = true;
  if (sendBtn) sendBtn.disabled = true;
  const typingBubble = aiAppendMessage('assistant', '', { typing: true });

  try {
    const res = await window.sentinelpayAuthFetch('/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: message.slice(0, AI_MAX_MESSAGE_LENGTH) }),
    });
    const data = await res.json().catch(() => ({}));
    const replyText = res.ok ? data.reply : data.error || `Something went wrong (HTTP ${res.status}).`;
    if (typingBubble) typingBubble.remove();
    aiAppendMessage('assistant', replyText || 'No reply received.');
  } catch (err) {
    console.error('AI chat request failed:', err);
    if (typingBubble) typingBubble.remove();
    aiAppendMessage('assistant', "I couldn't reach the server just now. Check your connection and try again.");
  } finally {
    aiRequestInFlight = false;
    if (sendBtn) sendBtn.disabled = false;
    if (input) input.focus();
  }
}

function aiOpenWidget() {
  const panel = document.getElementById('ai-widget-panel');
  const fab = document.getElementById('ai-widget-fab');
  const badge = document.getElementById('ai-widget-fab-badge');
  if (!panel || !fab) return;
  panel.classList.remove('hidden');
  fab.setAttribute('aria-expanded', 'true');
  fab.classList.add('ai-widget-fab-active');
  if (badge) badge.classList.add('hidden');
  aiWidgetOpened = true;
  const input = document.getElementById('ai-widget-input');
  if (input) input.focus();
}

function aiCloseWidget() {
  const panel = document.getElementById('ai-widget-panel');
  const fab = document.getElementById('ai-widget-fab');
  if (!panel || !fab) return;
  panel.classList.add('hidden');
  fab.setAttribute('aria-expanded', 'false');
  fab.classList.remove('ai-widget-fab-active');
}

function aiToggleWidget() {
  const panel = document.getElementById('ai-widget-panel');
  if (!panel) return;
  if (panel.classList.contains('hidden')) aiOpenWidget();
  else aiCloseWidget();
}

function initAiWidget() {
  const fab = document.getElementById('ai-widget-fab');
  const closeBtn = document.getElementById('ai-widget-close');
  const form = document.getElementById('ai-widget-form');
  const input = document.getElementById('ai-widget-input');
  const suggestions = document.getElementById('ai-widget-suggestions');
  const widget = document.getElementById('ai-widget');
  if (!fab || !form || !input || !widget) return;

  fab.addEventListener('click', aiToggleWidget);
  if (closeBtn) closeBtn.addEventListener('click', aiCloseWidget);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    aiSendMessage(input.value);
  });

  if (suggestions) {
    suggestions.addEventListener('click', (event) => {
      const chip = event.target.closest('.ai-suggestion-chip');
      if (!chip) return;
      aiSendMessage(chip.textContent);
    });
  }

  // Escape closes the panel from anywhere inside it, without swallowing Escape globally.
  widget.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') aiCloseWidget();
  });

  // Cross-file affordances: the Analytics tab's "Ask the AI Assistant" CTA (analytics.js) and any
  // "Ask AI" button rendered next to a transaction row (app.js/audit.js) both just dispatch a
  // DOM CustomEvent rather than calling into this file's functions directly -- keeps those files
  // decoupled from this widget's internals/load order, the same event-based pattern app.js already
  // uses for `sentinelpay:transaction`/`sentinelpay:view-shown`.
  document.addEventListener('sentinelpay:open-ai-assistant', (event) => {
    aiOpenWidget();
    const prefill = event.detail && event.detail.message;
    if (prefill) aiSendMessage(prefill);
  });

  // Event delegation (not a per-row listener) since transaction rows are created/destroyed
  // continuously by the live feed -- one listener on document survives all of that churn.
  document.addEventListener('click', (event) => {
    const askBtn = event.target.closest('.ask-ai-btn');
    if (!askBtn) return;
    const transactionId = askBtn.getAttribute('data-transaction-id');
    if (!transactionId) return;
    aiOpenWidget();
    aiSendMessage(`Tell me about ${transactionId}`);
  });

  // A one-time subtle nudge (a small badge on the FAB) the first time the dashboard loads, so a
  // first-time viewer notices there's an assistant at all -- dismissed permanently for this
  // session the moment the panel is opened once (see aiOpenWidget), never nagging after that.
  setTimeout(() => {
    if (aiWidgetOpened) return;
    const badge = document.getElementById('ai-widget-fab-badge');
    if (badge) badge.classList.remove('hidden');
  }, 1500);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initAiWidget);
} else {
  initAiWidget();
}
