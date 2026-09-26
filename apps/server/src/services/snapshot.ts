/* Full state snapshot for GET /api/state (the UI store is rebuilt from this, then kept current by events). */
import type { ChatMessage, DeptId, Policy, State } from '@agents/domain';
import type { Ctx } from '../context.js';
import { listProducts, listRoutines, listTasks, publicTask, toAlert, toBrief } from '../repo/rows.js';
import { company, kpi, recentEvents } from './common.js';
import { configHistory } from './config.js';
import { connectorMap } from './connectors.js';
import { computeMetrics } from './metrics.js';
import { usageSummary } from './usage.js';

const TASK_WINDOW = `status in ('scheduled','progress','waiting','backlog') or (status = 'done' and done_at > now() - interval '35 days')
  or (status = 'cancelled' and coalesce(done_at, at, created_at) > now() - interval '1 day')`;

export async function snapshot(ctx: Ctx): Promise<State> {
  const db = ctx.db; const org = ctx.org();
  const [c, tasks, routines, products, alerts, briefs, chats, events, K, metrics, usage, connectors, history, audit, base] = await Promise.all([
    company(db),
    listTasks(db, `${TASK_WINDOW} order by coalesce(at, created_at) desc limit 900`),
    listRoutines(db),
    listProducts(db),
    db.query(`select * from alerts where not dismissed or at > now() - make_interval(days => $1) order by at desc limit 300`, [org.settings.alertRetentionDays]).then(r => r.rows.map(toAlert)),
    db.query('select * from briefs order by at desc limit 14').then(r => r.rows.map(toBrief)),
    db.query(`select dept, me, text from (select *, row_number() over (partition by dept order by id desc) rn from chats) x where rn <= 60 order by id`).then(r => r.rows),
    recentEvents(db, 150),
    kpi(db),
    computeMetrics(ctx, db),
    usageSummary(db),
    connectorMap(ctx, db),
    configHistory(db),
    db.query('select * from audit_log order by at desc limit 400').then(r => r.rows.map(x => ({ id: x.id, at: x.at.getTime(), actor: x.actor, area: x.area,
      action: x.action, target: x.target, detail: x.detail }))),
    db.query('select dept, v0, v1 from metrics_base').then(r => Object.fromEntries(r.rows.map(x => [x.dept, [x.v0, x.v1]])))
  ]);
  const chatMap: Partial<Record<DeptId, ChatMessage[]>> = {};
  chats.forEach(m => { (chatMap[m.dept as DeptId] ||= []).push({ me: m.me, text: m.text }); });
  return {
    v: 4, notes: c.notes_count, tasks: tasks.map(publicTask), routines, products, alerts, policies: org.config.policies as Policy[], kpi: K, metrics,
    chats: chatMap, briefs, events, running: c.running, config: org.config, configHistory: history, audit, usage, connectors, base
  };
}
