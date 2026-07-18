// Global AI Assistant widget -- a persistent, dashboard-wide floating chat (FAB + panel),
// featuring programmatically synthesized sound cues, session persistence, 3D interactive
// badges, and status orb state synchronization.

const AI_MAX_MESSAGE_LENGTH = 1000;
const AI_LOG_MAX_MESSAGES = 200;
const SESSION_STORAGE_KEY = 'sentinelpay-chat-log';

let aiWidgetOpened = false;
let aiRequestInFlight = false;
let chatHistory = [];
let soundEnabled = localStorage.getItem('sentinelpay-chat-sound') !== 'false';

// Programmatic Web Audio synthesis for clean UI feedback sound chimes
function playSound(type) {
  if (!soundEnabled) return;
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    const ctx = new AudioContextClass();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.connect(gain);
    gain.connect(ctx.destination);

    const now = ctx.currentTime;
    if (type === 'send') {
      // Short high-pitched slide chime for sending
      osc.type = 'sine';
      osc.frequency.setValueAtTime(520, now);
      osc.frequency.exponentialRampToValueAtTime(1040, now + 0.1);
      gain.gain.setValueAtTime(0.06, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
      osc.start(now);
      osc.stop(now + 0.12);
    } else if (type === 'receive') {
      // Soft double-chime for incoming replies
      osc.type = 'sine';
      osc.frequency.setValueAtTime(784, now); // G5
      gain.gain.setValueAtTime(0.04, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);

      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.connect(gain2);
      gain2.connect(ctx.destination);
      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(987.77, now + 0.07); // B5
      gain2.gain.setValueAtTime(0, now);
      gain2.gain.setValueAtTime(0.04, now + 0.07);
      gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.22);

      osc.start(now);
      osc.stop(now + 0.15);
      osc2.start(now + 0.07);
      osc2.stop(now + 0.22);
    }
  } catch (e) {
    console.warn('Web Audio playback failed:', e);
  }
}

// Sync the AI status orb next to the assistant title
function setAiStatus(status) {
  const orb = document.getElementById('ai-widget-status');
  if (!orb) return;
  orb.className = 'ai-status-orb';
  if (status === 'thinking') {
    orb.classList.add('thinking');
    orb.title = 'AI Status: Thinking…';
  } else if (status === 'answering') {
    orb.classList.add('answering');
    orb.title = 'AI Status: Answering…';
  } else {
    orb.title = 'AI Status: Idle';
  }
}

// Format message text and scan for entities to render as 3D interactive clickable badges
function aiFormatMessageText(text) {
  let escaped = escapeHtml(text);

  // Convert newlines to breaks
  escaped = escaped.replace(/\n/g, '<br>');

  // Identify transaction IDs (e.g. t_abc123) and wrap in 3D clickable badges
  escaped = escaped.replace(/\bt_[a-z0-9-]{6,}\b/gi, (match) => {
    return `<span class="ai-badge" data-action="transaction" data-id="${match}">${match}</span>`;
  });

  // Identify account/user/merchant IDs (e.g. u_12345, m_store) and wrap in 3D clickable badges
  escaped = escaped.replace(/\b(u|m|biz|cust|acct)_[a-z0-9_]{3,}\b/gi, (match) => {
    return `<span class="ai-badge" data-action="account" data-id="${match}">${match}</span>`;
  });

  return escaped;
}

function aiAppendMessage(role, text, { typing = false, save = true } = {}) {
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

  // Persist message state in sessionStorage
  if (!typing && save) {
    chatHistory.push({ role, text });
    sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(chatHistory));
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
  playSound('send');
  if (input) input.value = '';
  if (suggestions) suggestions.classList.add('hidden');

  aiRequestInFlight = true;
  if (sendBtn) sendBtn.disabled = true;
  setAiStatus('thinking');

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
    setAiStatus('answering');
    aiAppendMessage('assistant', replyText || 'No reply received.');
    playSound('receive');
  } catch (err) {
    console.error('AI chat request failed:', err);
    if (typingBubble) typingBubble.remove();
    aiAppendMessage('assistant', "I couldn't reach the server just now. Check your connection and try again.");
    playSound('receive');
  } finally {
    aiRequestInFlight = false;
    if (sendBtn) sendBtn.disabled = false;
    setTimeout(() => setAiStatus('idle'), 600);
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

function clearChatHistory() {
  chatHistory = [];
  sessionStorage.removeItem(SESSION_STORAGE_KEY);
  const log = document.getElementById('ai-widget-log');
  if (log) {
    log.innerHTML = '';
    // Re-insert initial welcome message
    const welcomeText = "Hi, I'm your fraud-ops assistant. Ask me about a transaction, an account's risk score, what a decision means, or how scoring works — try one of these:";
    aiAppendMessage('assistant', welcomeText, { save: true });
  }
  const suggestions = document.getElementById('ai-widget-suggestions');
  if (suggestions) suggestions.classList.remove('hidden');
}

function updateSoundButton() {
  const btn = document.getElementById('ai-widget-sound');
  if (btn) {
    btn.textContent = soundEnabled ? '🔊' : '🔇';
    btn.title = soundEnabled ? 'Mute sound effects' : 'Unmute sound effects';
  }
}

function toggleSound() {
  soundEnabled = !soundEnabled;
  localStorage.setItem('sentinelpay-chat-sound', soundEnabled);
  updateSoundButton();
}

function loadChatHistory() {
  const stored = sessionStorage.getItem(SESSION_STORAGE_KEY);
  if (stored) {
    try {
      chatHistory = JSON.parse(stored);
      const log = document.getElementById('ai-widget-log');
      if (log) {
        log.innerHTML = '';
        chatHistory.forEach((msg) => {
          aiAppendMessage(msg.role, msg.text, { typing: false, save: false });
        });
      }
      const suggestions = document.getElementById('ai-widget-suggestions');
      if (suggestions && chatHistory.length > 1) {
        suggestions.classList.add('hidden');
      }
    } catch (e) {
      console.error('Failed to parse stored chat history:', e);
      chatHistory = [];
    }
  } else {
    // Save initial welcome message into history log on first initialization
    const welcomeMsg = document.querySelector('.ai-msg-assistant .ai-bubble');
    if (welcomeMsg) {
      chatHistory = [{ role: 'assistant', text: welcomeMsg.textContent.trim() }];
      sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(chatHistory));
    }
  }
}

function initAiWidget() {
  const fab = document.getElementById('ai-widget-fab');
  const closeBtn = document.getElementById('ai-widget-close');
  const clearBtn = document.getElementById('ai-widget-clear');
  const soundBtn = document.getElementById('ai-widget-sound');
  const form = document.getElementById('ai-widget-form');
  const input = document.getElementById('ai-widget-input');
  const suggestions = document.getElementById('ai-widget-suggestions');
  const widget = document.getElementById('ai-widget');
  const log = document.getElementById('ai-widget-log');

  if (!fab || !form || !input || !widget) return;

  // Initialize values
  updateSoundButton();
  loadChatHistory();
  setAiStatus('idle');

  fab.addEventListener('click', aiToggleWidget);
  if (closeBtn) closeBtn.addEventListener('click', aiCloseWidget);
  if (clearBtn) clearBtn.addEventListener('click', clearChatHistory);
  if (soundBtn) soundBtn.addEventListener('click', toggleSound);

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

  // Handle clickable 3D entity badges inside bubbles
  if (log) {
    log.addEventListener('click', (event) => {
      const badge = event.target.closest('.ai-badge');
      if (!badge) return;
      const action = badge.dataset.action;
      const id = badge.dataset.id;
      if (action === 'transaction') {
        aiSendMessage(`Tell me about ${id}`);
      } else if (action === 'account') {
        aiSendMessage(`How risky is ${id}`);
      }
    });
  }

  widget.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') aiCloseWidget();
  });

  document.addEventListener('sentinelpay:open-ai-assistant', (event) => {
    aiOpenWidget();
    const prefill = event.detail && event.detail.message;
    if (prefill) aiSendMessage(prefill);
  });

  document.addEventListener('click', (event) => {
    const askBtn = event.target.closest('.ask-ai-btn');
    if (!askBtn) return;
    const transactionId = askBtn.getAttribute('data-transaction-id');
    if (!transactionId) return;
    aiOpenWidget();
    aiSendMessage(`Tell me about ${transactionId}`);
  });

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
