/* Department card metrics (spec §6, §10): fixed metrics come from metrics_base, "=…" metrics are computed live. */
import { OPS_IDS, cover, type DeptId, type MetricSpec, type ServerEvent } from '@agents/domain';
import type { Ctx } from '../context.js';
import type { Queryable } from '../db/db.js';
import { kpi } from './common.js';
import { listProducts } from '../repo/rows.js';

export async function computeMetrics(ctx: Ctx, db: Queryable): Promise<Partial<Record<DeptId, [number, number]>>> {
  const org = ctx.org();
  const base = Object.fromEntries((await db.query('select dept, v0, v1 from metrics_base')).rows.map(r => [r.dept, [r.v0, r.v1]]));
  const K = await kpi(db); const P = await listProducts(db);
  const approvals = Number((await db.query(`select count(*)::int n from tasks where status = 'waiting'`)).rows[0].n);
  const busy = Number((await db.query(`select count(distinct agent)::int n from tasks where status = 'progress'`)).rows[0].n);
  const val = (d: DeptId, i: 0 | 1): number => {
    const spec: MetricSpec | undefined = org.metricSpec(d, i);
    if (typeof spec === 'number' || spec === undefined) return base[d]?.[i] ?? 0;
    switch (spec) {
      case '=approvals': return approvals;
      case '=kpi.ordersToday': return K.ordersToday;
      case '=lowStock': return P.filter(p => p.stage === 'live' && cover(p) < org.settings.warnStockDays).length;
      case '=stage.shipping': return P.filter(p => p.stage === 'shipping').length;
      case '=acos': return K.salesToday ? Math.round((K.adSpendToday / K.salesToday) * 1000) / 10 : 0;
      case '=busyAgents': return busy;
    }
  };
  return Object.fromEntries(OPS_IDS.map(d => [d, [val(d, 0), val(d, 1)] as [number, number]]));
}

/** Emits `metric` events only for departments whose values changed; coalesces bursts (≤ 1 run / 300 ms). */
export function metricsRefresher(getCtx: () => Ctx): () => void {
  let last: Record<string, string> = {}; let timer: NodeJS.Timeout | null = null; let running = false; let again = false;
  const run = async () => {
    timer = null;
    if (running) { again = true; return; }
    running = true;
    try {
      const ctx = getCtx(); const m = await computeMetrics(ctx, ctx.db); const ev: ServerEvent[] = [];
      for (const [d, v] of Object.entries(m)) { const k = v.join(','); if (last[d] !== k) { last[d] = k; ev.push({ type: 'metric', dept: d as DeptId, values: v }); } }
      if (ev.length) ctx.bus.publish(ev);
    } catch (e) { getCtx().log.warn({ err: e }, 'metrics refresh'); }
    finally { running = false; if (again) { again = false; schedule(); } }
  };
  const schedule = () => { if (!timer) timer = setTimeout(run, 300); };
  (schedule as { reset?: () => void }).reset = () => { last = {}; };
  return schedule;
}
