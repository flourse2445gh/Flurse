// Shared helpers for the BudsBox pages: API client, money formatting,
// escaping and a toast. Loaded as a plain script so there is no build step.

const $ = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    ...options,
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// Prices are stored in paise; show them as whole rupees like the shop menus do.
function rupees(paise) {
  const value = (paise || 0) / 100;
  const hasFraction = Math.round(value * 100) % 100 !== 0;
  return '₹' + value.toLocaleString('en-IN', {
    minimumFractionDigits: hasFraction ? 2 : 0,
    maximumFractionDigits: 2,
  });
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function timeAgo(input) {
  if (!input) return '';
  const diff = Date.now() - new Date(input).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(input).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

function clockTime(input) {
  return new Date(input).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
}

let toastTimer;
function toast(message) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
}

// "2d 14h" / "4h 12m" / "38m" — the trial countdown the mockup showed.
function trialLeft(endsAt) {
  const diff = new Date(endsAt).getTime() - Date.now();
  if (diff <= 0) return { text: 'Trial over', over: true, urgent: true };
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  const d = Math.floor(h / 24);
  const text = d > 0 ? `${d}d ${h % 24}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
  return { text, over: false, urgent: diff < 12 * 3600000 };
}
