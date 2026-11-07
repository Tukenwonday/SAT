// API client for SAT backend

export function getPin(name) {
  if (!name) return '';
  try {
    return localStorage.getItem(`satbank:pin:${name}`) || '';
  } catch (e) {
    return '';
  }
}

export function setPin(name, pin) {
  if (!name) return;
  try {
    localStorage.setItem(`satbank:pin:${name}`, pin);
  } catch (e) {}
}

export async function api(endpoint, options = {}) {
  const url = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  const opts = { ...options };
  opts.headers = {
    'Content-Type': 'application/json',
    ...(opts.headers || {}),
  };
  if (opts.body && typeof opts.body === 'object') {
    opts.body = JSON.stringify(opts.body);
  }

  try {
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => null);
    return data || { ok: false, error: 'invalid-json' };
  } catch (err) {
    return { ok: false, error: 'network', details: err.message };
  }
}

