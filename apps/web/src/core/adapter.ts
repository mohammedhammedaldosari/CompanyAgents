/* Live adapter — the data contract of spec §18 over HTTP + Server-Sent Events.
   Authentication is an HttpOnly session cookie set by /api/auth/login; no token ever lives in page script or storage. */
import type {
  Alert, CompanyConfig, ConnectorStatus, DeptId, Freq, Kpi, NewTask, Policy, Product, Routine, ServerEvent, State, Task, ToolDef
} from '@agents/domain';

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); this.name = 'ApiError'; }
}

/** UI hooks the adapter reports through (set by the UI at start-up, so this module has no UI dependency). */
export const hooks: { toast: (msg: string) => void } = { toast: () => {} };

type Json = Record<string, unknown> | unknown[] | null;

async function req<T = unknown>(method: string, path: string, body?: Json | object): Promise<T> {
  let r: Response;
  try {
    r = await fetch(path, {
      method, credentials: 'same-origin',
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } catch (e) { hooks.toast('تعذّر الوصول للخادم، أُعيد المحاولة خلال 5 ثوانٍ'); throw e; }
  if (r.status === 401) { window.dispatchEvent(new CustomEvent('agents:unauthorized')); throw new ApiError('غير مصرّح', 401); }
  if (!r.ok) {
    let msg = `خطأ من الخادم (${r.status})`;
    try { const j = await r.json() as { error?: string }; if (j && j.error) msg = j.error; } catch { /* not JSON */ }
    hooks.toast(msg);
    throw new ApiError(msg, r.status);
  }
  return (r.status === 204 ? null : await r.json()) as T;
}

export const auth = {
  me: (): Promise<{ authenticated: boolean; ownerConfigured: boolean }> => fetch('/api/auth/me', { credentials: 'same-origin' }).then(r => r.json()),
  /** null on success, otherwise the error message to show */
  async login(password: string): Promise<string | null> {
    const r = await fetch('/api/auth/login', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
    if (r.ok) return null;
    try { return ((await r.json()) as { error?: string }).error || 'تعذّر الدخول'; } catch { return 'تعذّر الدخول'; }
  },
  logout: (): Promise<Response> => fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{}' })
};

export interface FileMeta { id: string; name: string; mime: string; kind: 'upload' | 'bank' | 'rates'; size: number; note: string; uploadedAt: number; hasText: boolean }
export interface BankImport { rows: number; added: number; skipped: number; cash: number | null; monthExpenses: number }
export interface ToolCall {
  id: number; at: string; task_id: string | null; agent: string; dept: DeptId; tool: string; connector: string | null; action: string | null;
  value: number | null; status: string; approved_by: string | null; duration_ms: number | null; error: string | null
}
export type ConnectorResult = ConnectorStatus & { authorizeUrl?: string };
type Ok = { ok: true };

export const adapter = {
  load: () => req<State>('GET', '/api/state'),
  subscribe(cb: (e: ServerEvent) => void): () => void {
    let es: EventSource | null = null; let closed = false;
    const open = () => {
      if (closed) return;
      es = new EventSource('/api/events', { withCredentials: true });
      es.onmessage = m => { try { cb(JSON.parse(m.data) as ServerEvent); } catch { /* ignore malformed frame */ } };
      es.onerror = () => {
        es?.close();
        setTimeout(() => { open(); req<State>('GET', '/api/state').then(s => cb({ type: 'snapshot', state: s })).catch(() => {}); }, 5000);
      };
    };
    open();
    return () => { closed = true; es?.close(); };
  },

  // tasks
  createTask: (i: NewTask) => req<Task | null>('POST', '/api/tasks', i),
  cancelTask: (id: string) => req<Ok>('POST', `/api/tasks/${id}/cancel`, {}),
  runNow: (id: string) => req<Ok>('POST', `/api/tasks/${id}/run`, {}),
  approve: (id: string) => req<Ok>('POST', `/api/tasks/${id}/approve`, {}),
  sendBack: (id: string, note?: string) => req<Ok>('POST', `/api/tasks/${id}/send-back`, { note }),
  reject: (id: string) => req<Ok>('POST', `/api/tasks/${id}/reject`, {}),
  updateTask: (id: string, p: Partial<Task>) => req<Task>('PATCH', `/api/tasks/${id}`, p),
  reassignOpen: (from: string, to: string) => req<number>('POST', '/api/tasks/reassign', { from, to }),
  taskCalls: (id: string) => req<ToolCall[]>('GET', `/api/tasks/${id}/calls`),

  // routines
  createRoutine: (i: { title: string; dept: DeptId; agent?: string; freq?: Freq; dow?: number; time?: string }) => req<Routine>('POST', '/api/routines', i),
  updateRoutine: (id: string, p: Partial<Routine>) => req<Ok>('PATCH', `/api/routines/${id}`, p),
  deleteRoutine: (id: string) => req<Ok>('DELETE', `/api/routines/${id}`),
  runRoutine: (id: string) => req<Ok>('POST', `/api/routines/${id}/run`, {}),

  // products & alerts
  createProduct: (i: { name: string; sku?: string; stage?: string; cost?: number; price?: number }) => req<Product>('POST', '/api/products', i),
  updateProduct: (id: string, p: Partial<Product>) => req<Ok>('PATCH', `/api/products/${id}`, p),
  dismissAlert: (id: string) => req<Ok>('POST', `/api/alerts/${id}/dismiss`, {}),
  taskFromAlert: (id: string) => req<Task>('POST', `/api/alerts/${id}/task`, {}),

  // configuration
  setPolicies: (p: Policy[]) => req<Ok>('PUT', '/api/policies', p),
  publishConfig: (config: CompanyConfig, note?: string) => req<{ version: number; changes: string[]; moved: number }>('PUT', '/api/config', { config, note }),
  revertConfig: (v: number) => req<{ version: number }>('POST', `/api/config/revert/${v}`, {}),
  setMetric: (dept: DeptId, values: [number, number]) => req<Ok>('PUT', `/api/metrics/${dept}`, { values }),

  // chat, engine, briefs
  ask: (d: DeptId, text: string) => req<{ reply: string }>('POST', `/api/chat/${d}`, { text }).then(r => r && r.reply),
  greet: (d: DeptId) => req<Ok>('POST', `/api/chat/${d}/greet`, {}),
  setRunning: (on: boolean) => req<Ok>('PUT', '/api/running', { on }),
  markBriefRead: (id: string) => req<Ok>('POST', `/api/briefs/${id}/read`, {}),

  // connectors
  connectors: () => req<(ConnectorStatus & { tool: string; method: string; phase: number })[]>('GET', '/api/connectors'),
  connectorAction: (id: string, action: string, p?: Record<string, unknown>) => req<ConnectorResult>('POST', `/api/connectors/${id}/${action}`, p || {}),
  addConnector: (i: Record<string, unknown>) => req<ToolDef>('POST', '/api/connectors', i),
  removeConnector: (id: string) => req<Ok>('DELETE', `/api/connectors/${id}`),

  // data
  exportState: () => req<State>('GET', '/api/export'),
  importState: (s: State) => req<Ok>('POST', '/api/import', s),
  listFiles: () => req<FileMeta[]>('GET', '/api/files'),
  uploadFile: (f: { name: string; mime: string; kind: FileMeta['kind']; note?: string; dataBase64: string }) => req<FileMeta & { imported?: BankImport }>('POST', '/api/files', f),
  deleteFile: (id: string) => req<Ok>('DELETE', `/api/files/${id}`),
  importBank: (id: string) => req<BankImport>('POST', `/api/files/${id}/import-bank`, {}),
  toolCalls: (limit = 150) => req<ToolCall[]>('GET', `/api/tool-calls?limit=${limit}`),
  changePassword: (current: string, next: string) => req<Ok>('POST', '/api/auth/password', { current, next }),
  reset: async (): Promise<void> => { hooks.toast('إعادة الضبط غير متاحة في الوضع المتصل'); }
};

export type Adapter = typeof adapter;
export type { Alert, Kpi };
