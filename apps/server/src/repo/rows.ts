/* Row <-> domain mapping and small typed queries. Every function takes a Queryable so it works inside or outside a transaction. */
import type {
  ActionType, Alert, Brief, ConnectorStatus, DeptId, ModelKey, PendingCall, Product, Routine, StageId, Task, TaskStatus
} from '@agents/domain';
import type { Queryable } from '../db/db.js';
import { notFound } from '../core/errors.js';

const ms = (d: Date | null | undefined): number | null => (d ? d.getTime() : null);
const ts = (n: number | null | undefined): Date | null => (n == null ? null : new Date(n));

/* ---------- tasks ---------- */

export interface TaskRow extends Task {
  pendingCall: PendingCall | null;
  routing: { mode: string; at: number | null; model?: ModelKey | null } | null;
  ownerNote: string | null;
  fix: boolean;
  attempts: number;
}

export const TASK_COLS = `id, title, dept, agent, status, at, done_at, progress, action, value, ok, force, routine_id, source, product_id, model,
  team, via_exec, routing, artifact, result, approval_reason, pending_call, owner_note, fix, cost, tokens, attempts, created_at`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toTask(r: any): TaskRow {
  const t: TaskRow = {
    id: r.id, title: r.title, dept: r.dept, agent: r.agent, status: r.status, at: ms(r.at), doneAt: ms(r.done_at),
    progress: Number(r.progress), action: r.action, ok: r.ok, force: r.force, routine: r.routine_id, source: r.source,
    productId: r.product_id, model: r.model, team: r.team, viaExec: r.via_exec, artifact: r.artifact, result: r.result,
    approvalReason: r.approval_reason, pendingCall: r.pending_call, routing: r.routing, ownerNote: r.owner_note, fix: r.fix,
    attempts: r.attempts, createdAt: ms(r.created_at) ?? undefined
  };
  if (r.value != null) t.value = Number(r.value);
  if (r.cost != null) t.cost = Number(r.cost);
  if (r.tokens != null) t.tokens = r.tokens;
  return t;
}

/** Public shape sent to the browser (internal execution fields stripped). */
export function publicTask(t: TaskRow): Task {
  const { pendingCall: _p, routing: _r, ownerNote: _o, fix: _f, attempts: _a, ...pub } = t;
  return pub;
}

export async function getTask(db: Queryable, id: string, lock = false): Promise<TaskRow> {
  const r = await db.query(`select ${TASK_COLS} from tasks where id = $1${lock ? ' for update' : ''}`, [id]);
  if (!r.rows[0]) throw notFound('المهمة غير موجودة');
  return toTask(r.rows[0]);
}

export async function findTask(db: Queryable, id: string): Promise<TaskRow | null> {
  const r = await db.query(`select ${TASK_COLS} from tasks where id = $1`, [id]);
  return r.rows[0] ? toTask(r.rows[0]) : null;
}

export async function insertTask(db: Queryable, t: TaskRow): Promise<void> {
  await db.query(`insert into tasks (id, title, dept, agent, status, at, done_at, progress, action, value, ok, force, routine_id, source,
      product_id, model, team, via_exec, routing, artifact, result, approval_reason, pending_call, owner_note, fix, cost, tokens, attempts)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)`,
  [t.id, t.title, t.dept, t.agent, t.status, ts(t.at), ts(t.doneAt), t.progress, t.action, t.value ?? null, t.ok, !!t.force, t.routine,
    t.source, t.productId, t.model, t.team, t.viaExec, t.routing ? JSON.stringify(t.routing) : null, jsonOrNull(t.artifact),
    jsonOrNull(t.result), t.approvalReason ?? null, jsonOrNull(t.pendingCall), t.ownerNote, t.fix, t.cost ?? null, t.tokens ?? null, t.attempts]);
}

export async function saveTask(db: Queryable, t: TaskRow): Promise<void> {
  await db.query(`update tasks set title=$2, dept=$3, agent=$4, status=$5, at=$6, done_at=$7, progress=$8, action=$9, value=$10, ok=$11,
      force=$12, source=$13, product_id=$14, model=$15, team=$16, via_exec=$17, routing=$18, artifact=$19, result=$20, approval_reason=$21,
      pending_call=$22, owner_note=$23, fix=$24, cost=$25, tokens=$26, attempts=$27, updated_at=now() where id=$1`,
  [t.id, t.title, t.dept, t.agent, t.status, ts(t.at), ts(t.doneAt), t.progress, t.action, t.value ?? null, t.ok, !!t.force, t.source,
    t.productId, t.model, t.team, t.viaExec, t.routing ? JSON.stringify(t.routing) : null, jsonOrNull(t.artifact), jsonOrNull(t.result),
    t.approvalReason ?? null, jsonOrNull(t.pendingCall), t.ownerNote, t.fix, t.cost ?? null, t.tokens ?? null, t.attempts]);
}

export async function listTasks(db: Queryable, where = 'true', params: unknown[] = []): Promise<TaskRow[]> {
  return (await db.query(`select ${TASK_COLS} from tasks where ${where}`, params)).rows.map(toTask);
}

const jsonOrNull = (v: unknown) => (v == null ? null : JSON.stringify(v));

export function blankTask(o: Partial<TaskRow> & { id: string; title: string; dept: DeptId; agent: string }): TaskRow {
  return {
    status: 'scheduled' as TaskStatus, at: null, doneAt: null, progress: 0, action: 'internal' as ActionType, ok: true, force: false,
    routine: null, source: null, productId: null, model: 'SONNET' as ModelKey, team: false, viaExec: false, artifact: null, result: null,
    approvalReason: null, pendingCall: null, routing: null, ownerNote: null, fix: false, attempts: 0, ...o
  };
}

/* ---------- routines ---------- */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toRoutine(r: any): Routine {
  const o: Routine = { id: r.id, title: r.title, dept: r.dept, agent: r.agent, freq: r.freq, time: r.time, action: r.action, paused: r.paused };
  if (r.dow != null) o.dow = r.dow;
  return o;
}
export async function listRoutines(db: Queryable): Promise<Routine[]> {
  return (await db.query('select * from routines order by created_at, id')).rows.map(toRoutine);
}
export async function getRoutine(db: Queryable, id: string): Promise<Routine> {
  const r = await db.query('select * from routines where id = $1', [id]);
  if (!r.rows[0]) throw notFound('الروتين غير موجود');
  return toRoutine(r.rows[0]);
}
export async function saveRoutine(db: Queryable, r: Routine): Promise<void> {
  await db.query(`insert into routines (id, title, dept, agent, freq, dow, time, action, paused) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    on conflict (id) do update set title=excluded.title, dept=excluded.dept, agent=excluded.agent, freq=excluded.freq, dow=excluded.dow,
    time=excluded.time, action=excluded.action, paused=excluded.paused`,
  [r.id, r.title, r.dept, r.agent, r.freq, r.dow ?? null, r.time, r.action, r.paused]);
}

/* ---------- products ---------- */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toProduct(r: any, stages: { stage: StageId; at: number }[] = []): Product {
  return { id: r.id, name: r.name, sku: r.sku, asin: r.asin, stage: r.stage, stageSince: r.stage_since.getTime(), cost: Number(r.cost),
    price: Number(r.price), stock: r.stock, sales7d: r.sales7d, note: r.note, flags: r.flags || {}, stages };
}
export async function listProducts(db: Queryable, where = 'true', params: unknown[] = []): Promise<Product[]> {
  const rows = (await db.query(`select * from products where ${where} order by created_at, id`, params)).rows;
  if (!rows.length) return [];
  const st = (await db.query<{ product_id: string; stage: StageId; at: Date }>(
    'select product_id, stage, at from product_stages where product_id = any($1) order by at, id', [rows.map(r => r.id)])).rows;
  const by = new Map<string, { stage: StageId; at: number }[]>();
  st.forEach(s => { const a = by.get(s.product_id) || []; a.push({ stage: s.stage, at: s.at.getTime() }); by.set(s.product_id, a); });
  return rows.map(r => toProduct(r, by.get(r.id) || []));
}
export async function getProduct(db: Queryable, id: string, lock = false): Promise<Product> {
  const p = (await listProducts(db, `id = $1${lock ? '' : ''}`, [id]))[0];
  if (!p) throw notFound('المنتج غير موجود');
  return p;
}
export async function saveProduct(db: Queryable, p: Product): Promise<void> {
  await db.query(`insert into products (id, name, sku, asin, stage, stage_since, cost, price, stock, sales7d, note, flags)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    on conflict (id) do update set name=excluded.name, sku=excluded.sku, asin=excluded.asin, stage=excluded.stage, stage_since=excluded.stage_since,
    cost=excluded.cost, price=excluded.price, stock=excluded.stock, sales7d=excluded.sales7d, note=excluded.note, flags=excluded.flags`,
  [p.id, p.name, p.sku, p.asin, p.stage, new Date(p.stageSince), p.cost, p.price, p.stock, p.sales7d, p.note, JSON.stringify(p.flags || {})]);
}

/* ---------- alerts ---------- */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toAlert(r: any): Alert {
  return { id: r.id, level: r.level, dept: r.dept, agent: r.agent, title: r.title, detail: r.detail, productId: r.product_id,
    at: r.at.getTime(), dismissed: r.dismissed, taskId: r.task_id };
}
export async function getAlert(db: Queryable, id: string): Promise<Alert> {
  const r = await db.query('select * from alerts where id = $1', [id]);
  if (!r.rows[0]) throw notFound('التنبيه غير موجود');
  return toAlert(r.rows[0]);
}

/* ---------- briefs ---------- */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const toBrief = (r: any): Brief => ({ id: r.id, at: r.at.getTime(), text: r.text, read: r.read });

/* ---------- connectors ---------- */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toConnector(r: any, hasSecret: boolean): ConnectorStatus {
  return { state: r.state, scopes: r.scopes, lastSync: ms(r.last_sync), log: r.log || [], hasSecret, last4: r.last4, url: r.url,
    auth: r.auth, latency: r.latency, lastError: r.last_error };
}
