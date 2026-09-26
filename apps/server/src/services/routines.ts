/* Routines (spec §10, §16): CRUD and idempotent materialisation of planned runs for the next nine days. */
import { H, isHm, pickAgent, routineRuns, type ActionType, type DeptId, type Freq, type Routine } from '@agents/domain';
import type { Ctx } from '../context.js';
import type { Tx } from '../db/db.js';
import { bad } from '../core/errors.js';
import { newId } from '../core/ids.js';
import { getRoutine, listRoutines, saveRoutine } from '../repo/rows.js';
import { act, audit } from './common.js';
import { agentLoad, emitTask, makeTask, startTask } from './tasks.js';
import { insertTask } from '../repo/rows.js';

const HORIZON_DAYS = 9;

/** Routine value for price/budget runs is decided by the agent from real data; no random values in production. */
async function planRun(ctx: Ctx, tx: Tx, r: Routine, at: number, status: 'scheduled' | 'progress') {
  return makeTask(ctx, tx, { title: r.title, dept: r.dept, agent: r.agent, action: r.action, at, routine: r.id, source: 'روتين', status });
}

/** Creates every missing future run (unique index on routine_id+at makes this safe to call concurrently). */
export async function ensureRoutines(ctx: Ctx, tx: Tx, now = Date.now()): Promise<number> {
  const org = ctx.org(); let n = 0;
  for (const r of await listRoutines(tx)) {
    if (r.paused || !org.deptOn(r.dept)) continue;
    const runs = routineRuns(r, now, HORIZON_DAYS).filter(at => at > now);
    if (!runs.length) continue;
    const have = new Set((await tx.query<{ at: Date }>('select at from tasks where routine_id = $1 and at = any($2)', [r.id, runs.map(x => new Date(x))]))
      .rows.map(x => x.at.getTime()));
    for (const at of runs) {
      if (have.has(at)) continue;
      const t = await planRun(ctx, tx, r, at, 'scheduled');
      const ins = await tx.query('select 1 from tasks where routine_id = $1 and at = $2', [r.id, new Date(at)]);
      if (ins.rowCount) continue;
      await insertTask(tx, t); emitTask(tx, t); n++;
    }
  }
  return n;
}

export interface NewRoutine { title: string; dept: DeptId; agent?: string; freq?: Freq; dow?: number; time?: string; action?: ActionType }

export async function createRoutine(ctx: Ctx, i: NewRoutine): Promise<Routine> {
  const org = ctx.org(); const title = String(i.title || '').trim();
  if (!title) throw bad('عنوان الروتين فارغ');
  if (!org.dept(i.dept)) throw bad('قسم غير معروف');
  const time = i.time || '09:00'; if (!isHm(time)) throw bad('الوقت غير صالح');
  return ctx.db.tx(async tx => {
    const agent = i.agent && org.deptOf(i.agent) === i.dept ? i.agent : pickAgent(org, i.dept, title, false, await agentLoad(tx));
    const r: Routine = { id: newId('r'), title, dept: i.dept, agent, freq: i.freq || 'workdays', time, action: i.action || 'internal', paused: false };
    if (r.freq === 'weekly') r.dow = i.dow ?? new Date().getDay();
    await saveRoutine(tx, r); tx.emit({ type: 'routine.upsert', routine: r });
    await ensureRoutines(ctx, tx);
    await act(tx, r.dept, r.agent, 'start', `أُنشئ روتين «${r.title}»`);
    await audit(tx, 'الروتينات', 'إنشاء', r.title);
    return r;
  });
}

async function cancelFutureRuns(tx: Tx, id: string): Promise<void> {
  const r = await tx.query(`update tasks set status = 'cancelled', done_at = now(), updated_at = now()
    where routine_id = $1 and status = 'scheduled' and at > now() returning id`, [id]);
  const { getTask } = await import('../repo/rows.js');
  for (const x of r.rows) emitTask(tx, await getTask(tx, x.id));
}

export async function updateRoutine(ctx: Ctx, id: string, patch: Partial<Routine>): Promise<void> {
  const org = ctx.org();
  await ctx.db.tx(async tx => {
    const r = await getRoutine(tx, id);
    if (patch.title != null) { const s = String(patch.title).trim(); if (!s) throw bad('عنوان الروتين فارغ'); r.title = s; }
    if (patch.time != null) { if (!isHm(patch.time)) throw bad('الوقت غير صالح'); r.time = patch.time; }
    if (patch.freq) r.freq = patch.freq;
    if (patch.dow != null) r.dow = Math.max(0, Math.min(6, Number(patch.dow)));
    if (patch.action) r.action = patch.action;
    if (patch.paused != null) r.paused = !!patch.paused;
    if (patch.agent && org.deptOf(patch.agent)) { r.agent = patch.agent; r.dept = org.deptOf(patch.agent)!; }
    else if (patch.dept && org.dept(patch.dept) && patch.dept !== r.dept) { r.dept = patch.dept; r.agent = org.manager(r.dept); }
    if (r.freq === 'weekly' && r.dow == null) r.dow = new Date().getDay();
    if (r.freq !== 'weekly') delete r.dow;
    await saveRoutine(tx, r);
    await cancelFutureRuns(tx, id);
    tx.emit({ type: 'routine.upsert', routine: r });
    await ensureRoutines(ctx, tx);
    const onlyPause = Object.keys(patch).length === 1 && 'paused' in patch;
    await audit(tx, 'الروتينات', onlyPause ? (patch.paused ? 'إيقاف' : 'استئناف') : 'تعديل', r.title);
  });
}

export async function deleteRoutine(ctx: Ctx, id: string): Promise<void> {
  await ctx.db.tx(async tx => {
    const r = await getRoutine(tx, id);
    await cancelFutureRuns(tx, id);
    await tx.query('delete from routines where id = $1', [id]);
    tx.emit({ type: 'routine.remove', id });
    await audit(tx, 'الروتينات', 'حذف', r.title);
  });
}

export async function runRoutine(ctx: Ctx, id: string): Promise<void> {
  await ctx.db.tx(async tx => {
    const r = await getRoutine(tx, id); const now = Date.now();
    const t = await planRun(ctx, tx, r, now, 'progress');
    await insertTask(tx, t);
    await startTask(ctx, tx, t, now);
    await audit(tx, 'الروتينات', 'تشغيل الآن', r.title);
  });
}

export const HORIZON = HORIZON_DAYS * H.DAY;
