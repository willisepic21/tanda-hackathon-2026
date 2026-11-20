// Shared browser helpers: API calls, device identity, worker jobs.
// Resolves the API origin from this file's URL so the widget also works when
// embedded on a different site.

export const API_BASE = new URL('..', import.meta.url).href.replace(/\/$/, '');

export async function api(path, body) {
  const r = await fetch(API_BASE + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(json.reason || json.error || `HTTP ${r.status}`);
    err.status = r.status;
    err.code = json.code;
    throw err;
  }
  return json;
}

/** The device token is this browser's anonymous identity for 2-device replication. */
export async function getDeviceToken({ key = 'foldpass-device', storage = localStorage, label = '' } = {}) {
  let token = storage.getItem(key);
  if (!token) {
    token = (await api('/api/device', { label })).deviceToken;
    storage.setItem(key, token);
  }
  return token;
}

/** Calls fn(deviceToken); if the server no longer recognises the device, re-registers once. */
export async function withDevice(opts, fn) {
  try {
    return await fn(await getDeviceToken(opts));
  } catch (err) {
    if (err.code !== 'BAD_DEVICE') throw err;
    (opts.storage || localStorage).removeItem(opts.key || 'foldpass-device');
    return fn(await getDeviceToken(opts));
  }
}

export function isMobile() {
  return navigator.userAgentData?.mobile ?? /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

export function createWorker() {
  const url = new URL('../widget/worker.js', import.meta.url);
  if (url.origin === location.origin) return new Worker(url, { type: 'module' });
  // Cross-origin embed: browsers refuse cross-origin worker URLs, so bootstrap via a blob.
  const blob = new Blob([`import ${JSON.stringify(url.href)};`], { type: 'text/javascript' });
  return new Worker(URL.createObjectURL(blob), { type: 'module' });
}

/** Run one job on a worker. Returns { promise, cancel }. */
export function runJob(worker, job, onProgress) {
  let cancel;
  const promise = new Promise((resolve, reject) => {
    cancel = () => reject(Object.assign(new Error('cancelled'), { cancelled: true }));
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') onProgress?.(data);
      else if (data.type === 'done') resolve(data);
    };
    worker.onerror = (e) => reject(new Error(e.message || 'worker error'));
    worker.postMessage(job);
  });
  return { promise, cancel };
}

export const fmt = new Intl.NumberFormat();

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
