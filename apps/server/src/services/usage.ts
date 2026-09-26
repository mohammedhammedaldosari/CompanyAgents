/* Model usage & cost (admin "التكلفة والاستهلاك") — computed from real token counts returned by the API. */
import { H, type DeptId, type ModelKey, type Usage } from '@agents/domain';
import type { Ctx } from '../context.js';
import type { Queryable, Tx } from '../db/db.js';
import { company, mkAlert, patchCompany } from './common.js';

/** USD per million tokens [input, output]. Cache reads bill at 10%, 5-minute cache writes at 125% of input. */
const PRICES: { match: RegExp; inp: number; out: number }[] = [
  { match: /haiku/, inp: 1, out: 5 },
  { match: /sonnet-5/, inp: 2, out: 10 },
  { match: /sonnet/, inp: 3, out: 15 },
  { match: /opus-5-5/, inp: 4, out: 20 },
  { match: /opus/, inp: 5, out: 25 },
  { match: /fable|mythos/, inp: 10, out: 50 }
];

export interface TokenUsage { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }

/** Cost in halalas. */
export function costOf(modelId: string, u: TokenUsage, usdSar: number): number {
  const p = PRICES.find(x => x.match.test(modelId)) ?? PRICES[2]!;
  const usd = (u.input_tokens * p.inp + (u.cache_read_input_tokens || 0) * p.inp * 0.1 + (u.cache_creation_input_tokens || 0) * p.inp * 1.25
    + u.output_tokens * p.out) / 1e6;
  return Math.max(0, Math.round(usd * usdSar * 100));
}

export async function recordUsage(ctx: Ctx, tx: Tx, r: { kind: 'task' | 'chat'; taskId?: string | null; agent: string; dept: DeptId; model: ModelKey; modelId: string; usage: TokenUsage }): Promise<number> {
  const cost = costOf(r.modelId, r.usage, ctx.env.USD_SAR); const now = Date.now();
  await tx.query(`insert into usage_records (at, month, day, kind, task_id, agent, dept, model, model_id, input_tokens, output_tokens, cache_read, cache_write, cost)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
  [new Date(now), H.monthKey(now), H.dayKey(now), r.kind, r.taskId ?? null, r.agent, r.dept, r.model, r.modelId, r.usage.input_tokens, r.usage.output_tokens,
    r.usage.cache_read_input_tokens || 0, r.usage.cache_creation_input_tokens || 0, cost]);
  tx.after(async () => {
    await budgetCheck(ctx);
    ctx.bus.publish([{ type: 'usage', usage: await usageSummary(ctx.db) }]);
  });
  return cost;
}

export async function usageSummary(db: Queryable, now = Date.now()): Promise<Usage> {
  const month = H.monthKey(now);
  const prev = H.monthKey(H.addDays(new Date(new Date(now).getFullYear(), new Date(now).getMonth(), 1).getTime(), -1));
  const rows = (await db.query(`select agent, dept, model, day, task_id, (input_tokens + output_tokens + cache_read + cache_write) tokens, cost
    from usage_records where month = $1`, [month])).rows;
  const last = (await db.query<{ s: number }>('select coalesce(sum(cost),0)::bigint s from usage_records where month = $1', [prev])).rows[0]!.s;
  const c = await company(db);
  const U: Usage = { month, total: 0, tokens: 0, tasks: 0, byAgent: {}, byDept: {}, byModel: { HAIKU: 0, SONNET: 0, OPUS: 0 }, daily: {},
    warned: c.usage_month === month ? c.usage_warned : 0, lastMonthTotal: Number(last) };
  const tasks = new Set<string>();
  for (const r of rows) {
    const cost = Number(r.cost), tok = Number(r.tokens);
    U.total += cost; U.tokens += tok; if (r.task_id) tasks.add(r.task_id);
    const g = U.byAgent[r.agent] || (U.byAgent[r.agent] = { tasks: 0, tokens: 0, cost: 0, dept: r.dept });
    g.tokens += tok; g.cost += cost;
    U.byDept[r.dept] = (U.byDept[r.dept] || 0) + cost;
    U.byModel[r.model as ModelKey] = (U.byModel[r.model as ModelKey] || 0) + cost;
    U.daily[r.day] = (U.daily[r.day] || 0) + cost;
  }
  U.tasks = tasks.size;
  const perAgent = (await db.query(`select agent, count(distinct task_id)::int n from usage_records where month = $1 and task_id is not null group by agent`, [month])).rows;
  perAgent.forEach(x => { if (U.byAgent[x.agent]) U.byAgent[x.agent]!.tasks = x.n; });
  return U;
}

/** Warn at warnAt% and act at 100% of the monthly cap (spec admin §budget). */
export async function budgetCheck(ctx: Ctx): Promise<void> {
  const B = ctx.org().config.budget; const month = H.monthKey(Date.now());
  await ctx.db.tx(async tx => {
    const c = await company(tx, true);
    const warned = c.usage_month === month ? c.usage_warned : 0;
    const total = Number((await tx.query<{ s: number }>('select coalesce(sum(cost),0)::bigint s from usage_records where month = $1', [month])).rows[0]!.s);
    const p = (total / B.monthlyCap) * 100; const org = ctx.org();
    if (p >= 100 && warned < 100) {
      await patchCompany(tx, { usage_warned: 100, usage_month: month });
      await mkAlert(tx, { level: 'critical', dept: 'tech', agent: org.manager('tech'), title: `استهلاك النماذج بلغ السقف الشهري ${H.sar(B.monthlyCap)}`,
        detail: B.onCap === 'alert' ? 'لا إجراء تلقائي.' : B.onCap === 'downgrade' ? 'تحولت المهام الجديدة إلى هايكو.' : 'أُوقفت المهام غير الأساسية؛ الروتينات مستمرة.' });
    } else if (p >= B.warnAt && warned < B.warnAt) {
      await patchCompany(tx, { usage_warned: B.warnAt, usage_month: month });
      await mkAlert(tx, { level: 'warning', dept: 'tech', agent: org.manager('tech'), title: `استهلاك النماذج بلغ ${Math.round(p)}% من السقف الشهري` });
    }
  });
}

export async function overCap(ctx: Ctx, db: Queryable): Promise<boolean> {
  const total = Number((await db.query<{ s: number }>('select coalesce(sum(cost),0)::bigint s from usage_records where month = $1', [H.monthKey(Date.now())])).rows[0]!.s);
  return total >= ctx.org().config.budget.monthlyCap;
}
