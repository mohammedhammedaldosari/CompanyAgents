/* Morning brief (spec §11): issued once a day after the brief time, built from the state at issue time. */
import { H } from '@agents/domain';
import type { Ctx } from '../context.js';
import type { Tx } from '../db/db.js';
import { newId } from '../core/ids.js';
import { listProducts, listTasks, toAlert, toBrief } from '../repo/rows.js';
import { act, company, kpi, patchCompany } from './common.js';

export async function issueBrief(ctx: Ctx, tx: Tx, force = false): Promise<void> {
  const now = Date.now(), dk = H.dayKey(now);
  const c = await company(tx, true);
  if (!force && c.last_brief_day === dk) return;
  const org = ctx.org(); const K = await kpi(tx, now); const d = new Date(now);
  const yS = H.dayStart(now) - H.DAY, yE = H.dayStart(now);
  const doneY = Number((await tx.query<{ n: number }>(`select count(*)::int n from tasks where status = 'done' and done_at >= $1 and done_at < $2`,
    [new Date(yS), new Date(yE)])).rows[0]!.n);
  const W = await listTasks(tx, `status = 'waiting' order by at nulls last`);
  const A = (await tx.query(`select * from alerts where not dismissed and level <> 'info'
    order by case level when 'critical' then 0 else 1 end, at desc limit 3`)).rows.map(toAlert);
  const stuck = (await listProducts(tx)).filter(p => { const lim = org.stage(p.stage).limit; return lim != null && H.daysSince(p.stageSince, now) > lim; });
  const up = await listTasks(tx, `status = 'scheduled' and at >= $1 and at < $2 order by at limit 4`, [new Date(now), new Date(yE + H.DAY)]);
  const L = [`صباح الخير. هذا إيجاز ${H.DAYS[d.getDay()]} ${H.date(now)}.`, '', 'أمس:',
    `• المبيعات ${H.sar(K.salesYesterday)} من ${K.ordersYesterday} طلبًا، وصافي الربح ${H.sar(K.profitYesterday)} (هامش ${H.p1(K.salesYesterday ? K.profitYesterday / K.salesYesterday * 100 : 0)}%).`,
    `• الإعلانات ${H.sar(K.adYesterday)}، بنسبة ${H.p1(K.salesYesterday ? K.adYesterday / K.salesYesterday * 100 : 0)}% من المبيعات.`,
    `• أنجز الوكلاء ${doneY} مهمة.`];
  if (W.length) L.push('', 'يحتاجك اليوم:', `• ${W.length} موافقات: ${W.slice(0, 3).map(t => t.title).join('، ')}.`);
  if (A.length) L.push('', 'أهم التنبيهات:', ...A.map(a => `• ${a.title}.`));
  if (stuck.length) L.push('', 'منتجات عالقة:', ...stuck.map(p => `• ${p.name} في مرحلة ${org.stage(p.stage).name} منذ ${H.daysSince(p.stageSince, now)} يومًا.`));
  if (up.length) L.push('', 'أبرز مهام اليوم:', ...up.map(t => `• ${H.hm(t.at!)} ${t.title} — ${org.dept(t.dept).name}`));
  const r = await tx.query('insert into briefs (id, at, text, read) values ($1,$2,$3,false) returning *', [newId('b'), new Date(now), L.join('\n')]);
  await tx.query('delete from briefs where id not in (select id from briefs order by at desc limit 14)');
  await patchCompany(tx, { last_brief_day: dk });
  tx.emit({ type: 'brief', brief: toBrief(r.rows[0]) });
  await act(tx, 'exec', org.manager('exec'), 'write', 'أصدر الإيجاز الصباحي', { brain: true });
}

export async function markBriefRead(ctx: Ctx, id: string): Promise<void> {
  await ctx.db.tx(async tx => {
    const r = await tx.query('update briefs set read = true where id = $1 returning *', [id]);
    if (r.rows[0]) tx.emit({ type: 'brief', brief: toBrief(r.rows[0]) });
  });
}
