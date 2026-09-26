/* Shared building blocks used by every service: company state, KPI, activity feed, audit log, alerts. */
import {
  H, type ActivityEvent, type ActivityKind, type Alert, type AlertLevel, type DeptId, type Kpi, type ServerEvent
} from '@agents/domain';
import type { Queryable, Tx } from '../db/db.js';
import { newId } from '../core/ids.js';
import { toAlert } from '../repo/rows.js';

export interface CompanyRow {
  running: boolean;
  notes_count: number;
  cash: number;
  last_brief_day: number;
  last_day: number;
  usage_warned: number;
  usage_month: string;
  greeted: Record<string, number>;
}

export async function company(db: Queryable, lock = false): Promise<CompanyRow> {
  const r = await db.query<CompanyRow>(`select * from company_state where id = 1${lock ? ' for update' : ''}`);
  if (!r.rows[0]) throw new Error('company_state غير مهيأة — شغّل التهيئة');
  return r.rows[0];
}

export async function patchCompany(db: Queryable, patch: Partial<CompanyRow>): Promise<void> {
  const keys = Object.keys(patch) as (keyof CompanyRow)[];
  if (!keys.length) return;
  const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
  const vals = keys.map(k => (k === 'greeted' ? JSON.stringify(patch[k]) : patch[k]));
  await db.query(`update company_state set ${sets}, updated_at = now() where id = 1`, vals);
}

/* ---------- KPI (spec §9 Kpi, §11) ---------- */

interface KpiDay { sales: number; profit: number; ad_spend: number; orders: number }

export async function kpi(db: Queryable, now = Date.now()): Promise<Kpi> {
  const today = H.isoDay(now), yday = H.isoDay(H.addDays(now, -1));
  const r = await db.query<KpiDay & { day: string }>(`select to_char(day, 'YYYY-MM-DD') as day, sales, profit, ad_spend, orders from kpi_daily where day in ($1, $2)`, [today, yday]);
  const t = r.rows.find(x => x.day === today), y = r.rows.find(x => x.day === yday);
  const c = await company(db);
  return {
    salesToday: t?.sales ?? 0, profitToday: t?.profit ?? 0, adSpendToday: t?.ad_spend ?? 0, ordersToday: t?.orders ?? 0,
    salesYesterday: y?.sales ?? 0, profitYesterday: y?.profit ?? 0, adYesterday: y?.ad_spend ?? 0, ordersYesterday: y?.orders ?? 0,
    cash: c.cash
  };
}

/** Upserts today's KPI row with absolute values (sources report totals, not deltas). */
export async function setKpiDay(tx: Tx, day: number, v: Partial<KpiDay>): Promise<void> {
  const cols = (['sales', 'profit', 'ad_spend', 'orders'] as const).filter(k => v[k] != null);
  if (!cols.length) return;
  await tx.query(`insert into kpi_daily (day, ${cols.join(', ')}) values ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')})
    on conflict (day) do update set ${cols.map(c => `${c} = excluded.${c}`).join(', ')}`, [H.isoDay(day), ...cols.map(c => Math.round(v[c]!))]);
}

export async function emitKpi(tx: Tx): Promise<void> { tx.emit({ type: 'kpi', kpi: await kpi(tx) }); }

/* ---------- activity feed ---------- */

export async function act(tx: Tx, dept: DeptId, agent: string, kind: ActivityKind, text: string,
  extra: Omit<Extract<ServerEvent, { type: 'activity' }>, 'type' | 'event'> = {}): Promise<void> {
  const ev: ActivityEvent = { t: Date.now(), dept, agent, kind, text };
  await tx.query('insert into events (t, dept, agent, kind, text) values ($1,$2,$3,$4,$5)', [new Date(ev.t), dept, agent, kind, text]);
  tx.emit({ type: 'activity', event: ev, ...extra });
}

export async function recentEvents(db: Queryable, n = 150): Promise<ActivityEvent[]> {
  const r = await db.query('select t, dept, agent, kind, text from events order by id desc limit $1', [n]);
  return r.rows.reverse().map(x => ({ t: x.t.getTime(), dept: x.dept, agent: x.agent, kind: x.kind, text: x.text }));
}

/* ---------- audit log (owner actions, spec §20) ---------- */

export async function audit(tx: Tx, area: string, action: string, target = '', detail: string | string[] | null = null, actor = 'المالك'): Promise<void> {
  const e = { id: newId('l'), at: Date.now(), actor, area, action, target, detail };
  await tx.query('insert into audit_log (id, at, actor, area, action, target, detail) values ($1,$2,$3,$4,$5,$6,$7)',
    [e.id, new Date(e.at), actor, area, action, target, detail == null ? null : JSON.stringify(detail)]);
  tx.emit({ type: 'audit', entry: e });
}

/* ---------- alerts (spec §12) ---------- */

export async function mkAlert(tx: Tx, a: { level: AlertLevel; dept: DeptId; agent: string; title: string; detail?: string; productId?: string | null },
  opts: { dedupeHours?: number } = {}): Promise<Alert | null> {
  if (opts.dedupeHours) {
    const dup = await tx.query('select 1 from alerts where title = $1 and not dismissed and at > now() - make_interval(hours => $2)', [a.title, opts.dedupeHours]);
    if (dup.rowCount) return null;
  }
  const r = await tx.query(`insert into alerts (id, level, dept, agent, title, detail, product_id, at) values ($1,$2,$3,$4,$5,$6,$7,now()) returning *`,
    [newId('a'), a.level, a.dept, a.agent, a.title.slice(0, 300), (a.detail || '').slice(0, 2000), a.productId ?? null]);
  const alert = toAlert(r.rows[0]);
  tx.emit({ type: 'alert.upsert', alert });
  await act(tx, a.dept, a.agent, 'alert', alert.title);
  return alert;
}

export async function bumpNotes(tx: Tx, n = 1): Promise<void> {
  const r = await tx.query<{ notes_count: number }>('update company_state set notes_count = notes_count + $1 where id = 1 returning notes_count', [n]);
  tx.emit({ type: 'notes', count: r.rows[0]!.notes_count });
}
