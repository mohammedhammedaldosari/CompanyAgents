/* Agent runtime: a manual Claude tool-use loop with a server-side permission gate (spec §20 "دورة تنفيذ مهمة").
   - Every external action is evaluated by policy on the server; approval-bound calls are stored verbatim and the run pauses.
   - After approval the stored call is executed exactly as proposed (never regenerated), then the agent writes its result.
   - The transcript is append-only and persisted, so a run survives restarts and resumes after the owner decides. */
import Anthropic from '@anthropic-ai/sdk';
import { approvalReason, needsApproval, policyFor, type ModelKey, type PendingCall } from '@agents/domain';
import type { Ctx, LlmClient } from '../context.js';
import { AppError } from '../core/errors.js';
import { getProduct, getTask, saveTask, type TaskRow } from '../repo/rows.js';
import { act, company, kpi } from '../services/common.js';
import { emitTask, finishTask, type ExecOutcome } from '../services/tasks.js';
import { recordUsage } from '../services/usage.js';
import { secretId } from '../services/connectors.js';
import { openMcp, type McpSession } from '../connectors/mcp.js';
import { agentSystemPrompt, taskMessage } from './prompts.js';
import { builtinTools, mcpTools, type AgentTool, type RunEnv } from './tools.js';

export class EngineStopped extends Error { constructor() { super('أُوقف المحرك'); this.name = 'EngineStopped'; } }
export class NotConfigured extends AppError { constructor(m: string) { super(m, 400); this.name = 'NotConfigured'; } }

let client: Anthropic | null = null; let clientKey = '';
export function anthropic(ctx: Ctx): LlmClient {
  if (ctx.llm) return ctx.llm;
  if (!ctx.env.ANTHROPIC_API_KEY) throw new NotConfigured('ANTHROPIC_API_KEY غير مضبوط في الخادم؛ لا يمكن تشغيل الوكلاء');
  if (!client || clientKey !== ctx.env.ANTHROPIC_API_KEY) { client = new Anthropic({ apiKey: ctx.env.ANTHROPIC_API_KEY, maxRetries: 3 }); clientKey = ctx.env.ANTHROPIC_API_KEY; }
  return client;
}

export function modelId(ctx: Ctx, m: ModelKey): string {
  return m === 'OPUS' ? ctx.env.MODEL_OPUS : m === 'HAIKU' ? ctx.env.MODEL_HAIKU : ctx.env.MODEL_SONNET;
}

/** Request options shared by task runs and chat: adaptive thinking + effort on current models; Haiku 4.5 takes neither. */
export function modelOptions(ctx: Ctx, id: string): Pick<Anthropic.MessageCreateParamsNonStreaming, 'thinking' | 'output_config'> {
  if (/haiku/.test(id)) return {};
  return { thinking: { type: 'adaptive' }, output_config: { effort: ctx.env.AGENT_EFFORT } };
}

interface RunState {
  messages: Anthropic.MessageParam[];
  /** tool results produced in the last turn but not yet sent (the run paused before sending them) */
  pendingResults: Anthropic.ToolResultBlockParam[];
  actedExternally: boolean;
  turns: number;
}

async function logToolCall(ctx: Ctx, env: RunEnv, tool: AgentTool, input: unknown, status: string, extra: { output?: unknown; error?: string; ms?: number; value?: number } = {}): Promise<void> {
  await ctx.db.query(`insert into tool_calls (task_id, agent, dept, tool, connector, action, value, input, output, status, duration_ms, error, approved_by, approved_at)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
  [env.taskId, env.agent, env.dept, tool.name, tool.connector ?? null, tool.action ?? tool.kind, extra.value ?? null, JSON.stringify(input ?? {}),
    extra.output === undefined ? null : JSON.stringify(extra.output), status, extra.ms ?? null, extra.error ?? null,
    status === 'approved' ? 'المالك' : null, status === 'approved' ? new Date() : null]);
}

async function execTool(ctx: Ctx, env: RunEnv, tool: AgentTool, input: Record<string, unknown>, status: 'executed' | 'approved'): Promise<{ text: string; isError: boolean }> {
  const t0 = Date.now();
  try {
    const text = await tool.run(input, env);
    await logToolCall(ctx, env, tool, input, status, { output: text.slice(0, 4000), ms: Date.now() - t0, value: tool.valueFrom?.(input) });
    return { text, isError: false };
  } catch (e) {
    if (env.signal.aborted) throw e;
    const msg = (e as Error).message || String(e);
    await logToolCall(ctx, env, tool, input, 'error', { error: msg.slice(0, 1000), ms: Date.now() - t0 });
    return { text: `فشل تنفيذ الأداة: ${msg.slice(0, 500)}`, isError: true };
  }
}

async function openConnectors(ctx: Ctx, t: TaskRow): Promise<{ tools: AgentTool[]; sessions: McpSession[] }> {
  const org = ctx.org(); const allowed = org.agent(t.agent)?.tools;
  const ids = org.dept(t.dept).tools.filter(x => !allowed || allowed.includes(x));
  if (!ids.length) return { tools: [], sessions: [] };
  const rows = (await ctx.db.query(`select tool, url, scopes from connectors where tool = any($1) and state = 'connected' and url <> ''`, [ids])).rows;
  const tools: AgentTool[] = []; const sessions: McpSession[] = [];
  for (const r of rows) {
    try {
      const s = await openMcp(r.url, await ctx.vault.get(ctx.db, secretId(r.tool)));
      sessions.push(s); tools.push(...mcpTools(r.tool, s, r.scopes));
    } catch (e) { ctx.log.warn({ err: e, connector: r.tool }, 'mcp connect failed; continuing without it'); }
  }
  return { tools, sessions };
}

async function assertRunning(ctx: Ctx, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new EngineStopped();
  if (!(await company(ctx.db)).running) throw new EngineStopped();
}

/** Executes (or resumes) one task. Returns when the task is done, waiting for approval, or failed (throws). */
export async function runTaskAgent(ctx: Ctx, taskId: string, signal: AbortSignal): Promise<void> {
  const api = anthropic(ctx);
  let t = await getTask(ctx.db, taskId);
  if (t.status !== 'progress' || t.routing) return;
  const org = ctx.org(); const cfg = org.config;
  const agentCfg = org.agent(t.agent);
  const env: RunEnv = { ctx, taskId, agent: t.agent, dept: t.dept, signal };
  const model = modelId(ctx, t.model);
  const system = agentSystemPrompt({ name: t.agent, deptName: org.dept(t.dept).name, role: agentCfg?.role || '', instructions: agentCfg?.instructions || '', isManager: org.isMgr(t.agent) });
  const { tools: extTools, sessions } = await openConnectors(ctx, t);
  const tools = [...builtinTools(t.dept, t.action), ...extTools];
  const byName = new Map(tools.map(x => [x.name, x]));

  try {
    // ---- load or start the transcript ----
    const prev = (await ctx.db.query(`select id, messages from task_runs where task_id = $1 and status = 'waiting' order by id desc limit 1`, [taskId])).rows[0];
    let runId: number; let st: RunState;
    if (prev) {
      runId = prev.id; st = prev.messages as RunState;
      await ctx.db.query(`update task_runs set status = 'running' where id = $1`, [runId]);
      const pc = t.pendingCall as (PendingCall & { approved?: boolean }) | null;
      const results = [...st.pendingResults]; const extraText: string[] = [];
      if (pc?.approved) {
        const tool = byName.get(pc.tool);
        const r = tool ? await execTool(ctx, env, tool, pc.input, 'approved') : { text: 'تعذّر التنفيذ: الأداة لم تعد متاحة لهذا الوكيل', isError: true };
        results.push({ type: 'tool_result', tool_use_id: pc.toolUseId, content: `وافق المالك ونُفّذ الفعل كما اقترحته حرفيًا.\n${r.text}`, is_error: r.isError });
        st.actedExternally = true;
        await ctx.db.tx(async tx => { await act(tx, t.dept, t.agent, 'finish', `نفّذ «${t.title}» بعد موافقتك`, { tool: pc.connector ?? null }); });
      } else if (pc) {
        results.push({ type: 'tool_result', tool_use_id: pc.toolUseId, content: `لم يُنفّذ: أعاده المالك للتعديل. ملاحظته: ${t.ownerNote || '—'}`, is_error: true });
      } else if (t.ownerNote) {
        extraText.push(`ملاحظات المالك على المسودة: ${t.ownerNote}\nعدّل العمل بناءً عليها ثم استدعِ submit_result.`);
      }
      const content: Anthropic.ContentBlockParam[] = [...results, ...extraText.map(text => ({ type: 'text' as const, text }))];
      if (content.length) st.messages.push({ role: 'user', content });
      st.pendingResults = [];
      t.pendingCall = null; t.ownerNote = null;
      await saveTask(ctx.db, t);
    } else {
      await ctx.db.query(`update task_runs set status = 'failed', finished_at = now(), error = coalesce(error, 'interrupted') where task_id = $1 and status = 'running'`, [taskId]);
      const product = t.productId ? await getProduct(ctx.db, t.productId).catch(() => null) : null;
      st = { messages: [{ role: 'user', content: taskMessage(t, { product, kpi: await kpi(ctx.db), now: Date.now(), approvalNote: null, agent: agentCfg }) }],
        pendingResults: [], actedExternally: false, turns: 0 };
      runId = (await ctx.db.query(`insert into task_runs (task_id, status, model_id, messages) values ($1,'running',$2,$3) returning id`, [taskId, model, JSON.stringify(st)])).rows[0].id;
    }
    const save = (status: string, error?: string) => ctx.db.query(`update task_runs set status = $2, messages = $3, error = $4, finished_at = case when $2 in ('done','failed','aborted') then now() else finished_at end where id = $1`,
      [runId, status, JSON.stringify(st), error ?? null]);

    // ---- the loop ----
    const apiTools: Anthropic.Tool[] = tools.map(x => ({ name: x.name, description: x.description, input_schema: x.input_schema }));
    while (true) {
      await assertRunning(ctx, signal);
      if (st.turns >= ctx.env.AGENT_MAX_TURNS) {
        await save('failed', 'max turns');
        throw new AppError(`تجاوز الوكيل الحد الأقصى للخطوات (${ctx.env.AGENT_MAX_TURNS}) دون إنهاء المهمة`);
      }
      st.turns++;
      const res = await api.messages.create({
        model, max_tokens: ctx.env.AGENT_MAX_TOKENS,
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        tools: apiTools, messages: st.messages, ...modelOptions(ctx, model)
      }, { signal });
      await ctx.db.tx(async tx => {
        const cost = await recordUsage(ctx, tx, { kind: 'task', taskId, agent: t.agent, dept: t.dept, model: t.model, modelId: model, usage: res.usage });
        const cur = await getTask(tx, taskId, true);
        if (cur.status !== 'progress') throw new EngineStopped();
        cur.progress = Math.min(90, (cur.progress || 0) + 12);
        cur.cost = (cur.cost || 0) + cost; cur.tokens = (cur.tokens || 0) + res.usage.input_tokens + res.usage.output_tokens;
        await saveTask(tx, cur); emitTask(tx, cur); t = cur;
      });
      st.messages.push({ role: 'assistant', content: res.content as Anthropic.ContentBlockParam[] });

      if (res.stop_reason === 'refusal') { await save('failed', 'refusal'); throw new AppError('رفض النموذج تنفيذ هذه المهمة لأسباب تتعلق بسياسة الاستخدام'); }
      if (res.stop_reason === 'max_tokens') { await save('failed', 'max_tokens'); throw new AppError('انقطع رد النموذج لبلوغ حد الرموز'); }
      if (res.stop_reason === 'pause_turn') { await save('running'); continue; }

      const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
      if (!uses.length) {
        const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map(b => b.text).join('\n').trim();
        return await finalize({ summary: (text.split('\n')[0] || 'اكتملت المهمة').slice(0, 300), document: text || null, actedExternally: st.actedExternally });
      }

      const results: Anthropic.ToolResultBlockParam[] = [];
      let finish: ExecOutcome | null = null; let paused = false;
      for (const u of uses) {
        const tool = byName.get(u.name); const input = (u.input || {}) as Record<string, unknown>;
        if (paused || finish) { results.push({ type: 'tool_result', tool_use_id: u.id, content: 'لم يُنفّذ: توقف التشغيل عند خطوة سابقة.', is_error: true }); continue; }
        if (!tool) { results.push({ type: 'tool_result', tool_use_id: u.id, content: 'أداة غير معروفة', is_error: true }); continue; }
        await assertRunning(ctx, signal);
        if (tool.kind === 'finish') {
          finish = { summary: String(input.summary || '').slice(0, 300) || 'اكتملت المهمة', document: String(input.document || '') || null, actedExternally: st.actedExternally };
          results.push({ type: 'tool_result', tool_use_id: u.id, content: 'تم.' });
          continue;
        }
        if (tool.kind === 'read') {
          const r = await execTool(ctx, env, tool, input, 'executed');
          results.push({ type: 'tool_result', tool_use_id: u.id, content: r.text.slice(0, 30000), is_error: r.isError });
          continue;
        }
        // ---- permission gate (server-side, spec §20) ----
        const action = tool.action!; const value = tool.valueFrom?.(input);
        const p = policyFor(cfg.policies, cfg.overrides || [], action, agentCfg?.id, t.dept);
        const need = needsApproval(p, value) || !!t.force || action === 'payment';
        if (!need) {
          const r = await execTool(ctx, env, tool, input, 'executed');
          st.actedExternally = st.actedExternally || !r.isError;
          results.push({ type: 'tool_result', tool_use_id: u.id, content: r.text, is_error: r.isError });
          if (!r.isError) await ctx.db.tx(tx => act(tx, t.dept, t.agent, 'finish', `نفّذ ${tool.description.split('.')[0]}`, { tool: tool.connector ?? null }));
          continue;
        }
        const reason = approvalReason(p, action, value, !!t.force && !needsApproval(p, value));
        const draft = tool.draft ? await tool.draft(input, env) : JSON.stringify(input, null, 1);
        await logToolCall(ctx, env, tool, input, 'pending_approval', { value });
        const pending: PendingCall = { tool: tool.name, input, action, connector: tool.connector ?? null, reason, toolUseId: u.id };
        if (value !== undefined) pending.value = value;
        await ctx.db.tx(async tx => {
          const cur = await getTask(tx, taskId, true);
          if (cur.status !== 'progress') throw new EngineStopped();
          cur.status = 'waiting'; cur.progress = 100; cur.pendingCall = pending; cur.approvalReason = reason; cur.ok = false;
          cur.artifact = { name: `note-${cur.id.slice(2, 10)}.md`, body: `${draft}\n\nمع التحية، الفريق` };
          if (value !== undefined) cur.value = value;
          await saveTask(tx, cur); emitTask(tx, cur);
          await act(tx, cur.dept, cur.agent, 'draft', `صاغ «${cur.title}» · بانتظار موافقتك`, { brain: true });
        });
        paused = true;
      }
      if (paused) { st.pendingResults = results; await save('waiting'); ctx.refreshMetrics(); return; }
      if (finish) {
        // keep the transcript resumable in case the task-level approval sends it back
        st.pendingResults = results;
        return await finalize(finish);
      }
      st.messages.push({ role: 'user', content: results });
      await save('running');
    }

    async function finalize(out: ExecOutcome): Promise<void> {
      let waiting = false;
      await ctx.db.tx(async tx => {
        const cur = await getTask(tx, taskId, true);
        if (cur.status !== 'progress') throw new EngineStopped();
        await finishTask(ctx, tx, cur, out);
        waiting = (cur.status as string) === 'waiting';
      });
      await save(waiting ? 'waiting' : 'done');
    }
  } finally {
    await Promise.all(sessions.map(s => s.close().catch(() => {})));
  }
}
