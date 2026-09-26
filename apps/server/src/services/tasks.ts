/* Task lifecycle (spec §9, §12, §14): creation, CEO routing, start, completion, approval, send-back, rejection. */
import {
  H, approvalReason, inferAction, inferValue, linkProduct, modelFor, needsApproval, pickAgent, policyFor, routeDept,
  type ActionType, type DeptId, type NewTask, type Task
} from '@agents/domain';
import type { Ctx } from '../context.js';
import type { Queryable, Tx } from '../db/db.js';
import { bad } from '../core/errors.js';
import { newId } from '../core/ids.js';
import { blankTask, getTask, insertTask, listProducts, publicTask, saveTask, type TaskRow } from '../repo/rows.js';
import { act, audit, bumpNotes, company } from './common.js';
import { applyApprovedEffect } from './effects.js';
import { recordUsage } from './usage.js';
import { issueBrief } from './briefs.js';

export const emitTask = (tx: Tx, t: TaskRow) => tx.emit({ type: 'task.upsert', task: publicTask(t) });

/** Open-task count per agent, used for load balancing when no specialist name matches. */
export async function agentLoad(db: Queryable): Promise<Record<string, number>> {
  const r = await db.query<{ agent: string; n: number }>(`select agent, count(*)::int n from tasks where status in ('scheduled','progress','waiting','backlog') group by agent`);
  return Object.fromEntries(r.rows.map(x => [x.agent, x.n]));
}

/** Approval decision for a task's own action (the tool-level gate re-checks every real call). */
export function taskNeedsApproval(ctx: Ctx, t: Pick<Task, 'action' | 'value' | 'agent' | 'dept' | 'force'>): { ok: boolean; reason: string | null } {
  const org = ctx.org(); const cfg = org.config;
  const p = policyFor(cfg.policies, cfg.overrides || [], t.action, org.agent(t.agent)?.id, t.dept);
  const need = needsApproval(p, t.value);
  return { ok: !(need || t.force), reason: need || t.force ? approvalReason(p, t.action, t.value, !!t.force) : null };
}

async function monthOverCap(ctx: Ctx, db: Queryable): Promise<boolean> {
  const cap = ctx.org().config.budget.monthlyCap;
  const r = await db.query<{ s: number }>('select coalesce(sum(cost),0)::bigint s from usage_records where month = $1', [H.monthKey(Date.now())]);
  return Number(r.rows[0]!.s) >= cap;
}

export interface MakeTask {
  title: string; dept: DeptId; agent?: string; status?: Task['status']; at?: number | null; action?: ActionType; value?: number;
  productId?: string | null; model?: Task['model']; team?: boolean; viaExec?: boolean; source?: string | null; routine?: string | null;
  force?: boolean; progress?: number; fix?: boolean;
}

/** Builds a task with agent, product link, model and approval flag resolved (does not persist). */
export async function makeTask(ctx: Ctx, tx: Queryable, o: MakeTask): Promise<TaskRow> {
  const org = ctx.org();
  const agent = o.agent || pickAgent(org, o.dept, o.title, o.team, await agentLoad(tx));
  const t = blankTask({ id: newId('t'), title: o.title, dept: o.dept, agent });
  Object.assign(t, {
    status: o.status ?? 'scheduled', at: o.at ?? null, action: o.action ?? 'internal', routine: o.routine ?? null, source: o.source ?? null,
    team: !!o.team, viaExec: !!o.viaExec, force: !!o.force, progress: o.progress ?? 0, fix: !!o.fix
  });
  if (o.value !== undefined && o.value !== null && !Number.isNaN(o.value)) t.value = o.value;
  t.productId = o.productId !== undefined ? o.productId : linkProduct(o.title, await listProducts(tx));
  t.model = o.model ?? modelFor(org, agent);
  const cfg = org.config;
  if (cfg.budget.onCap === 'downgrade' && await monthOverCap(ctx, tx)) t.model = 'HAIKU';
  const g = taskNeedsApproval(ctx, t);
  t.ok = g.ok; t.approvalReason = g.reason;
  return t;
}

/** Owner-facing createTask (spec §14 composer). */
export async function createTask(ctx: Ctx, i: NewTask): Promise<Task | null> {
  const title = String(i.title || '').trim();
  if (!title) throw bad('اكتب المهمة أولًا');
  if (title.length > 300) throw bad('عنوان المهمة أطول من 300 حرف');
  const org = ctx.org();
  if (i.dept !== 'auto' && !org.dept(i.dept)) throw bad('قسم غير معروف');
  const action = inferAction(title), value = inferValue(title);
  const force = i.mode === 'approve';
  if (i.repeat) {
    const { createRoutine } = await import('./routines.js');
    const dept = i.dept === 'auto' ? (routeDept(title, org) || 'exec') : i.dept;
    await createRoutine(ctx, { title, dept, freq: i.repeat.freq, time: i.repeat.time, action, dow: new Date().getDay() });
    return null;
  }
  return ctx.db.tx(async tx => {
    const now = Date.now();
    let t: TaskRow;
    if (i.dept === 'auto') {
      t = await makeTask(ctx, tx, { title, dept: 'exec', agent: org.manager('exec'), status: 'progress', at: now, progress: 3, action, value,
        model: i.model, team: i.team, viaExec: true, productId: i.productId ?? undefined, source: i.source ?? null, force });
      t.routing = { mode: i.mode || 'auto', at: i.at ?? null, model: i.model ?? null };
      await insertTask(tx, t); emitTask(tx, t);
      await act(tx, 'exec', t.agent, 'route', `يوجّه «${title}»`);
      // spec §14 step 2: the CEO classifies after 1.5 s (visible routing beat in the UI)
      tx.after(() => { setTimeout(() => routeTask(ctx, t.id).catch(e => ctx.log.error(e, 'route')), 1500); });
    } else {
      const sch = i.mode === 'schedule';
      t = await makeTask(ctx, tx, { title, dept: i.dept, team: i.team, status: sch ? 'scheduled' : 'progress', at: sch ? (i.at || now + H.HOUR) : now,
        action, value, model: i.model, source: i.source ?? null, productId: i.productId ?? undefined, force });
      await insertTask(tx, t);
      if (sch) emitTask(tx, t); else await startTask(ctx, tx, t);
    }
    if (i.mode !== 'auto_internal') await audit(tx, 'المهام', 'إضافة مهمة', title);
    return publicTask(t);
  });
}

/** CEO routing step (spec §14 steps 2–5). */
export async function routeTask(ctx: Ctx, id: string): Promise<void> {
  await ctx.db.tx(async tx => {
    const t = await getTask(tx, id, true);
    if (!t.routing || t.status !== 'progress') return;
    const org = ctx.org(); const { mode, at, model } = t.routing; t.routing = null;
    const d = routeDept(t.title, org);
    if (d) { t.dept = d; t.agent = pickAgent(org, d, t.title, t.team, await agentLoad(tx)); }
    else t.agent = org.dept('exec').agents[1] || org.manager('exec');
    t.progress = 0;
    t.model = model || modelFor(org, t.agent);
    const g = taskNeedsApproval(ctx, { ...t, force: mode === 'approve' || t.force });
    t.ok = g.ok; t.approvalReason = g.reason;
    await act(tx, 'exec', org.manager('exec'), 'route', d ? `وجّه «${t.title}» إلى ${org.dept(d).name}` : `أبقى «${t.title}» في الإدارة التنفيذية`,
      d ? { route: { from: 'exec', to: d } } : {});
    if (mode === 'schedule') { t.status = 'scheduled'; t.at = at || Date.now() + H.HOUR; await saveTask(tx, t); emitTask(tx, t); }
    else await startTask(ctx, tx, t);
  });
}

/** Moves a task to "in progress" and hands it to the executor after commit. */
export async function startTask(ctx: Ctx, tx: Tx, t: TaskRow, now = Date.now()): Promise<void> {
  t.status = 'progress';
  if (!t.at || t.at > now) t.at = now;
  t.progress = Math.max(0, t.progress || 0);
  await saveTask(tx, t); emitTask(tx, t);
  await act(tx, t.dept, t.agent, 'start', `بدأ «${t.title}»`, { tool: primaryTool(ctx, t) });
  const c = await company(tx);
  if (c.running) tx.after(() => ctx.jobs.enqueueTask(t.id));
}

/** The connector most associated with a task, used for the tool→department pulse in the scene. */
export function primaryTool(ctx: Ctx, t: Pick<Task, 'dept' | 'agent' | 'action'>): string | null {
  const org = ctx.org(); const allowed = org.agent(t.agent)?.tools;
  const tools = org.dept(t.dept).tools.filter(x => !allowed || allowed.includes(x));
  if (!tools.length) return null;
  const m: Partial<Record<ActionType, string>> = { price_change: 'sellercentral', listing_edit: 'sellercentral', ad_budget: 'amazonads',
    supplier_msg: tools.includes('alibaba') ? 'alibaba' : 'gmail', external_email: 'gmail', purchase_order: 'gmail', payment: 'bank', report: 'gsheets' };
  const pick = m[t.action];
  return pick && tools.includes(pick) ? pick : tools[0]!;
}

/* ---------- completion ---------- */

export interface ExecOutcome {
  summary: string;
  document?: string | null;
  /** true when a gated action was executed (or decided) during the run */
  actedExternally?: boolean;
  notes?: string[];
}

/** Finishes an execution: waiting with a draft when the task itself needs approval and no gated call decided it, otherwise done. */
export async function finishTask(ctx: Ctx, tx: Tx, t: TaskRow, out: ExecOutcome): Promise<void> {
  if (!t.ok && !out.actedExternally) {
    t.status = 'waiting'; t.progress = 100;
    t.artifact = { name: `note-${t.id.slice(2, 10)}.md`, body: out.document || out.summary };
    t.result = { summary: out.summary };
    await saveTask(tx, t); emitTask(tx, t);
    await act(tx, t.dept, t.agent, 'draft', `صاغ «${t.title}» · بانتظار موافقتك`, { brain: true });
    return;
  }
  await completeTask(ctx, tx, t, out, false);
}

export async function completeTask(ctx: Ctx, tx: Tx, t: TaskRow, out: ExecOutcome, approved: boolean): Promise<void> {
  t.status = 'done'; t.doneAt = Date.now(); t.progress = 100; t.pendingCall = null;
  const file = out.document ? { name: `${H.slug(t.title) || t.id}.md`, body: out.document } : (t.artifact || null);
  t.result = { summary: out.summary, file };
  if (t.action === 'payment') t.result.summary = 'جُهّزت الدفعة وتنتظر التنفيذ منك في البنك';
  await saveTask(tx, t); emitTask(tx, t);
  await bumpNotes(tx);
  if (t.fix) await tx.query(`update metrics_base set v1 = greatest(0, v1 - 1) where dept = 'tech'`);
  await act(tx, t.dept, t.agent, 'finish', approved ? `نفّذ «${t.title}» بعد موافقتك` : `أنهى «${t.title}»`,
    { tool: primaryTool(ctx, t), brain: true });
  if (t.routine === 'r1') await issueBrief(ctx, tx, true);
  ctx.refreshMetrics();
}

/* ---------- owner decisions ---------- */

export async function approve(ctx: Ctx, id: string): Promise<void> {
  await ctx.db.tx(async tx => {
    const t = await getTask(tx, id, true);
    if (t.status !== 'waiting') throw bad('المهمة ليست بانتظار الموافقة');
    await audit(tx, 'الموافقات', 'موافقة', t.title);
    if (t.pendingCall) {
      // the stored call is executed verbatim by the executor, then the agent writes the result
      await tx.query(`update tool_calls set status = 'approved', approved_by = 'المالك', approved_at = now()
        where task_id = $1 and status = 'pending_approval'`, [t.id]);
      t.pendingCall = { ...t.pendingCall, approved: true } as TaskRow['pendingCall'];
      t.status = 'progress'; t.progress = 90;
      await saveTask(tx, t); emitTask(tx, t);
      await act(tx, t.dept, t.agent, 'approve', `وافقت على «${t.title}»`);
      const c = await company(tx);
      if (c.running) tx.after(() => ctx.jobs.enqueueTask(t.id));
      return;
    }
    // task-level approval of a draft: apply the effect implied by the task itself
    await tx.query(`update task_runs set status = 'done', finished_at = now() where task_id = $1 and status = 'waiting'`, [t.id]);
    const note = await applyApprovedEffect(ctx, tx, t);
    await completeTask(ctx, tx, t, { summary: note || t.result?.summary || `اكتملت «${t.title}»`, document: t.artifact?.body ?? null }, true);
  });
}

export async function sendBack(ctx: Ctx, id: string, note?: string): Promise<void> {
  await ctx.db.tx(async tx => {
    const t = await getTask(tx, id, true);
    if (t.status !== 'waiting') throw bad('المهمة ليست بانتظار الموافقة');
    t.ownerNote = String(note || 'راجع المسودة وحسّنها').slice(0, 2000);
    if (t.pendingCall) await tx.query(`update tool_calls set status = 'rejected', approved_by = 'المالك', approved_at = now()
      where task_id = $1 and status = 'pending_approval'`, [t.id]);
    t.status = 'progress'; t.progress = 45;
    await saveTask(tx, t); emitTask(tx, t);
    await act(tx, t.dept, t.agent, 'start', `يعدّل «${t.title}»`);
    await audit(tx, 'الموافقات', 'إعادة للتعديل', t.title, note || null);
    const c = await company(tx);
    if (c.running) tx.after(() => ctx.jobs.enqueueTask(t.id));
  });
}

export async function reject(ctx: Ctx, id: string): Promise<void> {
  await ctx.db.tx(async tx => {
    const t = await getTask(tx, id, true);
    if (t.status === 'done' || t.status === 'cancelled') throw bad('المهمة منتهية');
    await tx.query(`update tool_calls set status = 'rejected', approved_by = 'المالك', approved_at = now() where task_id = $1 and status = 'pending_approval'`, [t.id]);
    t.status = 'cancelled'; t.doneAt = Date.now(); t.pendingCall = null;
    await tx.query(`update task_runs set status = 'aborted', finished_at = now() where task_id = $1 and status in ('waiting','running')`, [t.id]);
    await saveTask(tx, t); emitTask(tx, t);
    await act(tx, t.dept, t.agent, 'cancel', `أُلغي «${t.title}» برفضك`);
    await audit(tx, 'الموافقات', 'رفض', t.title);
    tx.after(() => ctx.jobs.abortTask(t.id));
  });
  ctx.refreshMetrics();
}

export async function cancelTask(ctx: Ctx, id: string): Promise<void> {
  await ctx.db.tx(async tx => {
    const t = await getTask(tx, id, true);
    if (t.status === 'done' || t.status === 'cancelled') return;
    await tx.query(`update tool_calls set status = 'rejected' where task_id = $1 and status = 'pending_approval'`, [t.id]);
    t.status = 'cancelled'; t.doneAt = Date.now(); t.pendingCall = null; t.routing = null;
    await tx.query(`update task_runs set status = 'aborted', finished_at = now() where task_id = $1 and status in ('waiting','running')`, [t.id]);
    await saveTask(tx, t); emitTask(tx, t);
    await act(tx, t.dept, t.agent, 'cancel', `أُلغي «${t.title}»`);
    await audit(tx, 'المهام', 'إلغاء', t.title);
    tx.after(() => ctx.jobs.abortTask(t.id));
  });
  ctx.refreshMetrics();
}

export async function runNow(ctx: Ctx, id: string): Promise<void> {
  await ctx.db.tx(async tx => {
    const t = await getTask(tx, id, true);
    if (!['scheduled', 'backlog'].includes(t.status)) throw bad('يمكن تشغيل المهام المجدولة أو المؤجلة فقط');
    t.at = Date.now(); t.attempts = 0;
    await startTask(ctx, tx, t, t.at);
    await audit(tx, 'المهام', 'تشغيل الآن', t.title);
  });
}

/** Admin edit of an open task (title, agent, model, action/value, product, time). */
export async function updateTask(ctx: Ctx, id: string, p: Partial<Task>): Promise<Task> {
  return ctx.db.tx(async tx => {
    const org = ctx.org(); const t = await getTask(tx, id, true);
    if (t.status === 'done' || t.status === 'cancelled') throw bad('لا يمكن تعديل مهمة منتهية');
    const before = `${t.title} · ${t.agent}`;
    if (p.title != null) { const s = String(p.title).trim(); if (!s) throw bad('عنوان المهمة فارغ'); t.title = s.slice(0, 300); }
    if (p.agent) { const d = org.deptOf(p.agent); if (!d) throw bad('وكيل غير معروف'); t.agent = p.agent; t.dept = d; }
    if (p.model && ['SONNET', 'OPUS', 'HAIKU'].includes(p.model)) t.model = p.model;
    if (p.action) t.action = p.action;
    if ('value' in p) { if (p.value == null || Number.isNaN(Number(p.value))) delete t.value; else t.value = Number(p.value); }
    if ('productId' in p) t.productId = p.productId || null;
    if (p.at && (t.status === 'scheduled' || t.status === 'backlog')) { t.at = Number(p.at); t.status = 'scheduled'; }
    if (t.status !== 'waiting') { const g = taskNeedsApproval(ctx, t); t.ok = g.ok; t.approvalReason = g.reason; }
    await saveTask(tx, t); emitTask(tx, t);
    const after = `${t.title} · ${t.agent}`;
    await audit(tx, 'المهام', 'تعديل مهمة', t.title, before !== after ? `${before} إلى ${after}` : null);
    return publicTask(t);
  });
}

export async function reassignOpen(ctx: Ctx, from: string, to: string): Promise<number> {
  const org = ctx.org();
  if (!org.deptOf(to)) throw bad('اختر وكيلًا');
  if (from === to) throw bad('اختر وكيلين مختلفين');
  return ctx.db.tx(async tx => {
    const rows = await tx.query(`update tasks set agent = $2, dept = $3, updated_at = now()
      where agent = $1 and status in ('scheduled','progress','waiting','backlog') returning id`, [from, to, org.deptOf(to)]);
    for (const r of rows.rows) emitTask(tx, await getTask(tx, r.id));
    await audit(tx, 'المهام', 'إعادة إسناد جماعي', `${from} إلى ${to}`, `${rows.rowCount} مهمة`);
    return rows.rowCount ?? 0;
  });
}

/* ---------- used by the executor ---------- */

export async function markFailed(ctx: Ctx, id: string, err: string, opts: { configError?: boolean } = {}): Promise<void> {
  const { mkAlert } = await import('./common.js');
  await ctx.db.tx(async tx => {
    const t = await getTask(tx, id, true);
    if (t.status !== 'progress') return;
    t.status = 'backlog'; t.progress = 0; t.result = { summary: `فشل التنفيذ: ${err}`.slice(0, 500) };
    await saveTask(tx, t); emitTask(tx, t);
    const org = ctx.org();
    if (opts.configError) await mkAlert(tx, { level: 'critical', dept: 'tech', agent: org.manager('tech'), title: 'لا يمكن تشغيل الوكلاء: إعداد الخادم ناقص', detail: err.slice(0, 500) }, { dedupeHours: 24 });
    else await mkAlert(tx, { level: 'warning', dept: 'tech', agent: org.manager('tech'), title: `فشل تنفيذ «${t.title}»`, detail: err.slice(0, 500) });
  });
  ctx.refreshMetrics();
}

export { recordUsage };
