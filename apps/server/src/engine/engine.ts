/* The engine: pg-boss queue for task execution (retry with backoff, one active run per task) and a minute schedule
   for everything time-based (spec §16, §17 real-mode equivalents, §21 pruning). */
import PgBoss from 'pg-boss';
import { H, cover } from '@agents/domain';
import type { Ctx, Jobs } from '../context.js';
import { listProducts, listTasks, saveProduct } from '../repo/rows.js';
import { company, emitKpi, mkAlert, patchCompany } from '../services/common.js';
import { issueBrief } from '../services/briefs.js';
import { ensureRoutines } from '../services/routines.js';
import { markFailed, startTask } from '../services/tasks.js';
import { overCap } from '../services/usage.js';
import { spConfig, spRefresh, syncAds, syncSellerCentral } from '../services/connectors.js';
import { spConfigured } from '../connectors/spapi.js';
import { EngineStopped, NotConfigured, runTaskAgent } from '../agents/runtime.js';

const Q_EXEC = 'task-execute';
const Q_TICK = 'engine-minute';
const MAX_ATTEMPTS = 3;

export class Engine implements Jobs {
  private boss: PgBoss | null = null;
  private running = new Map<string, AbortController>();
  private lastSp = 0;
  private lastRecover = 0;
  constructor(private ctx: () => Ctx) {}

  async start(databaseUrl: string, concurrency: number): Promise<void> {
    const boss = new PgBoss({ connectionString: databaseUrl, schema: 'pgboss', max: Math.max(4, concurrency + 2) });
    boss.on('error', e => this.ctx().log.error({ err: e }, 'pg-boss'));
    await boss.start();
    await boss.createQueue(Q_EXEC, { name: Q_EXEC, policy: 'stately', retryLimit: MAX_ATTEMPTS - 1, retryDelay: 20, retryBackoff: true, expireInSeconds: 30 * 60 });
    await boss.createQueue(Q_TICK, { name: Q_TICK, policy: 'singleton' });
    for (let i = 0; i < concurrency; i++) {
      await boss.work<{ taskId: string }>(Q_EXEC, { batchSize: 1, pollingIntervalSeconds: 1 }, async ([job]) => { if (job) await this.execute(job.data.taskId); });
    }
    await boss.work(Q_TICK, { pollingIntervalSeconds: 5 }, async () => { await this.minute(); });
    await boss.schedule(Q_TICK, '* * * * *', {}, { tz: process.env.TZ || 'Asia/Riyadh' });
    this.boss = boss;
    await this.minute(); // catch up immediately after a restart
  }

  async stop(): Promise<void> {
    this.abortAll();
    await this.boss?.stop({ graceful: true, timeout: 10_000 }).catch(() => {});
  }

  /* ---------- Jobs interface ---------- */

  async enqueueTask(taskId: string): Promise<void> {
    if (!this.boss) return;
    await this.boss.send(Q_EXEC, { taskId }, { singletonKey: taskId });
  }
  abortTask(taskId: string): void { this.running.get(taskId)?.abort(); }
  abortAll(): void { for (const c of this.running.values()) c.abort(); }

  /* ---------- execution ---------- */

  private async execute(taskId: string): Promise<void> {
    const ctx = this.ctx();
    if (this.running.has(taskId)) return;
    const ctrl = new AbortController(); this.running.set(taskId, ctrl);
    try {
      await runTaskAgent(ctx, taskId, ctrl.signal);
    } catch (e) {
      if (e instanceof EngineStopped || ctrl.signal.aborted) return; // task stays "in progress" and is re-queued on resume
      const msg = (e as Error).message || String(e);
      if (e instanceof NotConfigured) { await markFailed(ctx, taskId, msg, { configError: true }); return; }
      const r = await ctx.db.query<{ attempts: number }>(`update tasks set attempts = attempts + 1 where id = $1 and status = 'progress' returning attempts`, [taskId]);
      const attempts = r.rows[0]?.attempts ?? MAX_ATTEMPTS;
      ctx.log.warn({ err: e, taskId, attempts }, 'task execution failed');
      if (attempts >= MAX_ATTEMPTS) { await markFailed(ctx, taskId, msg); return; }
      throw e; // pg-boss retries with exponential backoff
    } finally { this.running.delete(taskId); }
  }

  /* ---------- the minute ---------- */

  async minute(): Promise<void> {
    const ctx = this.ctx(); const now = Date.now(); const org = ctx.org();
    const c = await company(ctx.db);

    // day change: yesterday's numbers are simply the previous kpi_daily row; reset per-day flags
    if (c.last_day !== H.dayKey(now)) {
      await ctx.db.tx(async tx => { await patchCompany(tx, { last_day: H.dayKey(now), greeted: {} }); await emitKpi(tx); });
    }

    await ctx.db.tx(tx => ensureRoutines(ctx, tx, now));

    if (c.running) {
      // start every due scheduled task (routine runs and owner-scheduled tasks)
      const lean = org.config.budget.onCap === 'pause' && await overCap(ctx, ctx.db);
      const due = await listTasks(ctx.db, `status = 'scheduled' and at <= $1 and routing is null order by at limit 50`, [new Date(now)]);
      for (const t of due) {
        if (!org.deptOn(t.dept) || !org.agentOn(t.agent)) continue;
        if (lean && !t.routine) continue;
        await ctx.db.tx(async tx => {
          const cur = (await listTasks(tx, `id = $1 and status = 'scheduled' for update`, [t.id]))[0];
          if (cur) await startTask(ctx, tx, cur, now);
        });
      }
      // orphaned "in progress" tasks (e.g. after a crash) go back to the queue
      if (now - this.lastRecover > 5 * H.MIN) {
        this.lastRecover = now;
        const r = await ctx.db.query(`select id from tasks where status = 'progress' and routing is null`);
        for (const x of r.rows) if (!this.running.has(x.id)) await this.enqueueTask(x.id);
      }
    }

    // morning brief (spec §11)
    if (now >= H.atTime(H.dayStart(now), org.settings.briefTime) && c.last_brief_day !== H.dayKey(now)) {
      await ctx.db.tx(tx => issueBrief(ctx, tx));
    }

    // stalled products (spec §13) and low stock recovery
    await ctx.db.tx(async tx => {
      for (const p of await listProducts(tx)) {
        const days = H.daysSince(p.stageSince, now); const lim = org.stage(p.stage).limit;
        let dirty = false;
        if (lim != null && days > lim && p.flags.stall !== p.stage) {
          p.flags.stall = p.stage; dirty = true;
          const rd = p.stage === 'research';
          await mkAlert(tx, { level: 'warning', dept: rd ? 'research' : 'supply', agent: org.manager(rd ? 'research' : 'supply'),
            title: `${p.name} عالق في مرحلة ${org.stage(p.stage).name} منذ ${days} يومًا`, productId: p.id });
        }
        if (p.flags.low && cover(p) >= org.settings.warnStockDays) { p.flags.low = false; dirty = true; }
        if (dirty) { await saveProduct(tx, p); tx.emit({ type: 'product.upsert', product: p }); }
      }
    });

    // pruning (spec §21): cancelled > 1 day, dismissed alerts past retention, old activity and expired sessions
    await ctx.db.query(`delete from tasks where status = 'cancelled' and coalesce(done_at, at, created_at) < now() - interval '1 day'`);
    await ctx.db.query(`delete from alerts where dismissed and at < now() - make_interval(days => $1)`, [org.settings.alertRetentionDays]);
    await ctx.db.query(`delete from events where t < now() - interval '30 days'`);
    await ctx.db.query(`delete from sessions where expires_at < now()`);

    // Seller Central sync
    if (now - this.lastSp >= ctx.env.SPAPI_SYNC_MINUTES * H.MIN) {
      this.lastSp = now;
      const st = (await ctx.db.query(`select state from connectors where tool = 'sellercentral'`)).rows[0]?.state;
      if (st === 'connected' && spConfigured(spConfig(ctx), await spRefresh(ctx, ctx.db))) {
        await syncSellerCentral(ctx).catch(e => ctx.log.warn({ err: e }, 'spapi sync'));
      }
      await syncAds(ctx).catch(e => ctx.log.warn({ err: e }, 'ads sync'));
    }
    ctx.refreshMetrics();
  }
}

/** Minimal Jobs used when the engine is disabled (tests, CLI). */
export const noJobs: Jobs = { enqueueTask: async () => {}, abortTask: () => {}, abortAll: () => {} };

export { MAX_ATTEMPTS };
