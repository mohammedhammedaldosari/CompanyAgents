/* Department chat (spec §15). "مهمة: …" creates a task; other messages go to the department manager (Claude, read-only
   tools) when a model key is configured, otherwise to the data-driven answer engine. */
import type Anthropic from '@anthropic-ai/sdk';
import { H, OPS_IDS, type DeptId } from '@agents/domain';
import type { Ctx } from '../context.js';
import { bad } from '../core/errors.js';
import { listProducts, listTasks, publicTask, toAlert } from '../repo/rows.js';
import { company, kpi, patchCompany } from './common.js';
import { computeMetrics } from './metrics.js';
import { answer, opener, type AnswerData } from './answers.js';
import { createTask } from './tasks.js';
import { recordUsage } from './usage.js';
import { anthropic, modelId, modelOptions } from '../agents/runtime.js';
import { agentSystemPrompt } from '../agents/prompts.js';
import { READ_TOOLS, type RunEnv } from '../agents/tools.js';

async function push(ctx: Ctx, dept: DeptId, me: boolean, text: string): Promise<void> {
  await ctx.db.tx(async tx => {
    await tx.query('insert into chats (dept, me, text) values ($1,$2,$3)', [dept, me, text]);
    await tx.query(`delete from chats where dept = $1 and id not in (select id from chats where dept = $1 order by id desc limit 60)`, [dept]);
    tx.emit({ type: 'chat', dept, message: { me, text } });
  });
}

async function answerData(ctx: Ctx): Promise<AnswerData> {
  const db = ctx.db;
  const [tasks, products, alerts, K, metrics, base] = await Promise.all([
    listTasks(db, `status <> 'cancelled' and coalesce(done_at, at, created_at) > now() - interval '35 days'`),
    listProducts(db),
    db.query('select * from alerts order by at desc limit 200').then(r => r.rows.map(toAlert)),
    kpi(db), computeMetrics(ctx, db),
    db.query('select dept, v0, v1 from metrics_base').then(r => Object.fromEntries(r.rows.map(x => [x.dept, [x.v0, x.v1]])))
  ]);
  return { org: ctx.org(), tasks: tasks.map(publicTask), products, alerts, kpi: K, metrics, base, now: Date.now() };
}

const validDept = (d: string): d is DeptId => (OPS_IDS as readonly string[]).includes(d) || d === 'core';

export async function greet(ctx: Ctx, dept: string): Promise<void> {
  if (!validDept(dept) || dept === 'core') return;
  const dk = H.dayKey(Date.now());
  const c = await company(ctx.db);
  if (c.greeted[dept] === dk) return;
  await patchCompany(ctx.db, { greeted: { ...c.greeted, [dept]: dk } });
  await push(ctx, dept, false, opener(dept, await answerData(ctx)));
}

async function llmReply(ctx: Ctx, dept: DeptId, question: string): Promise<string> {
  const api = anthropic(ctx); const org = ctx.org(); const mgr = org.manager(dept); const cfg = org.agent(mgr);
  const model = modelId(ctx, cfg?.model || 'SONNET');
  const history = (await ctx.db.query('select me, text from chats where dept = $1 order by id desc limit 12', [dept])).rows.reverse();
  const messages: Anthropic.MessageParam[] = [];
  for (const m of history) {
    const role = m.me ? 'user' : 'assistant';
    if (messages.length && messages[messages.length - 1]!.role === role) (messages[messages.length - 1]!.content as string) += `\n${m.text}`;
    else messages.push({ role, content: m.text });
  }
  if (!messages.length || messages[0]!.role !== 'user') messages.unshift({ role: 'user', content: question });
  if (messages[messages.length - 1]!.role !== 'user') messages.push({ role: 'user', content: question });
  const system = `${agentSystemPrompt({ name: mgr, deptName: org.dept(dept).name, role: cfg?.role || '', instructions: cfg?.instructions || '', isManager: true })}

أنت الآن في محادثة مباشرة مع المالك داخل لوحة القسم. أجب بإيجاز (حتى 8 أسطر)، واستخدم الأدوات للحصول على الأرقام الحقيقية، والقوائم بصيغة «• …».
إن طلب المالك تنفيذ عمل فاقترح عليه كتابة «مهمة: …» ليُنشأ كمهمة.`;
  const tools = READ_TOOLS.filter(t => t.name !== 'brain_write');
  const byName = new Map(tools.map(t => [t.name, t]));
  const env: RunEnv = { ctx, taskId: null, agent: mgr, dept, signal: AbortSignal.timeout(120_000) };
  for (let turn = 0; turn < 6; turn++) {
    const res = await api.messages.create({
      model, max_tokens: 4000, system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      tools: tools.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema })), messages, ...modelOptions(ctx, model)
    }, { signal: env.signal });
    await ctx.db.tx(tx => recordUsage(ctx, tx, { kind: 'chat', agent: mgr, dept, model: cfg?.model || 'SONNET', modelId: model, usage: res.usage }));
    messages.push({ role: 'assistant', content: res.content as Anthropic.ContentBlockParam[] });
    const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (!uses.length || res.stop_reason === 'refusal') {
      return res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map(b => b.text).join('\n').trim() || '—';
    }
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const u of uses) {
      const t = byName.get(u.name);
      const text = t ? await t.run((u.input || {}) as Record<string, unknown>, env).catch(e => `خطأ: ${(e as Error).message}`) : 'أداة غير معروفة';
      results.push({ type: 'tool_result', tool_use_id: u.id, content: text.slice(0, 20000) });
    }
    messages.push({ role: 'user', content: results });
  }
  return 'لم أصل إلى إجابة مكتملة؛ حاول صياغة السؤال بشكل أدق.';
}

export async function ask(ctx: Ctx, dept: string, text: string): Promise<string> {
  const q = String(text || '').trim().slice(0, 2000);
  if (!q) return '';
  if (!validDept(dept)) throw bad('قسم غير معروف');
  await push(ctx, dept, true, q);
  let reply: string;
  const m = q.match(/^(مهمة:|مهمه:|add task:)\s*(.+)$/is);
  if (m) {
    const t = await createTask(ctx, { title: m[2]!.trim(), dept: dept === 'core' ? 'exec' : dept, mode: 'auto_internal', source: 'المحادثة' });
    reply = t ? `أُضيفت «${t.title}». بدأ ${t.agent} العمل عليها.` : 'أُنشئ روتين للمهمة.';
  } else if (ctx.env.ANTHROPIC_API_KEY) {
    try { reply = await llmReply(ctx, dept, q); }
    catch (e) {
      ctx.log.warn({ err: e }, 'chat model failed; using data answer');
      reply = `${answer(dept, q, await answerData(ctx))}\n(رد آلي من البيانات؛ تعذّر الوصول للنموذج الآن)`;
    }
  } else reply = answer(dept, q, await answerData(ctx));
  await push(ctx, dept, false, reply);
  return reply;
}
