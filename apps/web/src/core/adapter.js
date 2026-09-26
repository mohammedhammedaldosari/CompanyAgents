/* Live adapter — the data contract of spec §18 over HTTP + Server-Sent Events.
   Authentication is an HttpOnly session cookie set by /api/auth/login; no token ever lives in page script or storage. */
import { UI } from '../ui/ui.js';

async function req(method, path, body) {
  let r;
  try {
    r = await fetch(path, { method, credentials: 'same-origin', headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch (e) { UI.toast('تعذّر الوصول للخادم، أُعيد المحاولة خلال 5 ثوانٍ'); throw e; }
  if (r.status === 401) { const e = new Error('غير مصرّح'); e.status = 401; window.dispatchEvent(new CustomEvent('agents:unauthorized')); throw e; }
  if (!r.ok) {
    let msg = `خطأ من الخادم (${r.status})`;
    try { const j = await r.json(); if (j && j.error) msg = j.error; } catch { /* not JSON */ }
    UI.toast(msg); const e = new Error(msg); e.status = r.status; throw e;
  }
  return r.status === 204 ? null : r.json();
}

export const auth = {
  me: () => fetch('/api/auth/me', { credentials: 'same-origin' }).then(r => r.json()),
  async login(password) {
    const r = await fetch('/api/auth/login', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
    if (r.ok) return null;
    try { return (await r.json()).error || 'تعذّر الدخول'; } catch { return 'تعذّر الدخول'; }
  },
  logout: () => fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{}' })
};

export const adapter = {
  load: () => req('GET', '/api/state'),
  subscribe(cb) {
    let es = null, closed = false;
    const open = () => {
      if (closed) return;
      es = new EventSource('/api/events', { withCredentials: true });
      es.onmessage = m => { try { cb(JSON.parse(m.data)); } catch { /* ignore malformed frame */ } };
      es.onerror = () => {
        es.close();
        setTimeout(() => { open(); req('GET', '/api/state').then(s => cb({ type: 'snapshot', state: s })).catch(() => {}); }, 5000);
      };
    };
    open();
    return () => { closed = true; if (es) es.close(); };
  },
  createTask: i => req('POST', '/api/tasks', i),
  cancelTask: id => req('POST', `/api/tasks/${id}/cancel`, {}),
  runNow: id => req('POST', `/api/tasks/${id}/run`, {}),
  approve: id => req('POST', `/api/tasks/${id}/approve`, {}),
  sendBack: (id, note) => req('POST', `/api/tasks/${id}/send-back`, { note }),
  reject: id => req('POST', `/api/tasks/${id}/reject`, {}),
  createRoutine: i => req('POST', '/api/routines', i),
  updateRoutine: (id, p) => req('PATCH', `/api/routines/${id}`, p),
  deleteRoutine: id => req('DELETE', `/api/routines/${id}`),
  runRoutine: id => req('POST', `/api/routines/${id}/run`, {}),
  createProduct: i => req('POST', '/api/products', i),
  updateProduct: (id, p) => req('PATCH', `/api/products/${id}`, p),
  dismissAlert: id => req('POST', `/api/alerts/${id}/dismiss`, {}),
  taskFromAlert: id => req('POST', `/api/alerts/${id}/task`, {}),
  setPolicies: p => req('PUT', '/api/policies', p),
  ask: (d, text) => req('POST', `/api/chat/${d}`, { text }).then(r => r && r.reply),
  greet: d => req('POST', `/api/chat/${d}/greet`, {}),
  setRunning: on => req('PUT', '/api/running', { on }),
  markBriefRead: id => req('POST', `/api/briefs/${id}/read`, {}),
  connectors: () => req('GET', '/api/connectors'),
  exportState: () => req('GET', '/api/export'),
  importState: s => req('POST', '/api/import', s),
  publishConfig: (config, note) => req('PUT', '/api/config', { config, note }),
  revertConfig: v => req('POST', `/api/config/revert/${v}`, {}),
  updateTask: (id, p) => req('PATCH', `/api/tasks/${id}`, p),
  reassignOpen: (from, to) => req('POST', '/api/tasks/reassign', { from, to }),
  connectorAction: (id, action, p) => req('POST', `/api/connectors/${id}/${action}`, p || {}),
  addConnector: i => req('POST', '/api/connectors', i),
  removeConnector: id => req('DELETE', `/api/connectors/${id}`),
  listFiles: () => req('GET', '/api/files'),
  uploadFile: f => req('POST', '/api/files', f),
  deleteFile: id => req('DELETE', `/api/files/${id}`),
  importBank: id => req('POST', `/api/files/${id}/import-bank`, {}),
  toolCalls: (limit = 150) => req('GET', `/api/tool-calls?limit=${limit}`),
  taskCalls: id => req('GET', `/api/tasks/${id}/calls`),
  setMetric: (dept, values) => req('PUT', `/api/metrics/${dept}`, { values }),
  changePassword: (current, next) => req('POST', '/api/auth/password', { current, next }),
  reset: async () => UI.toast('إعادة الضبط غير متاحة في الوضع المتصل')
};
