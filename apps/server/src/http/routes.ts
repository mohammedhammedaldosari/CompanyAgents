/* REST contract (spec §18 + admin additions) and the live event stream. Handlers are thin: parse → service → result. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ACTION_TYPES, DEPT_IDS, FREQS, MODELS, STAGE_IDS, type Kpi, type NewTask, type ServerEvent } from '@agents/domain';
import type { Ctx } from '../context.js';
import { bad } from '../core/errors.js';
import { snapshot } from '../services/snapshot.js';
import * as tasks from '../services/tasks.js';
import * as routines from '../services/routines.js';
import * as products from '../services/products.js';
import * as config from '../services/config.js';
import * as conn from '../services/connectors.js';
import * as ops from '../services/ops.js';
import { ask, greet } from '../services/chat.js';
import { markBriefRead } from '../services/briefs.js';
import * as files from '../services/files.js';

const parse = <T>(s: z.ZodType<T>, v: unknown): T => {
  const r = s.safeParse(v ?? {});
  if (!r.success) throw bad(`مدخلات غير صالحة: ${r.error.issues.map(i => `${i.path.join('.') || 'body'} ${i.message}`).join('، ')}`);
  return r.data;
};
const P = (req: { params: unknown }) => req.params as Record<string, string>;
const id = z.string().min(1).max(80);

const newTask = z.object({
  title: z.string().min(1).max(300),
  dept: z.union([z.literal('auto'), z.enum(DEPT_IDS)]).default('auto'),
  mode: z.enum(['auto', 'schedule', 'approve', 'auto_internal']).optional(),
  at: z.number().int().nullable().optional(),
  model: z.enum(MODELS).optional(),
  team: z.boolean().optional(),
  productId: z.string().max(80).nullable().optional(),
  repeat: z.object({ freq: z.enum(FREQS), time: z.string().regex(/^\d\d:\d\d$/) }).nullable().optional(),
  source: z.string().max(80).nullable().optional()
});
const routineIn = z.object({ title: z.string().min(1).max(200), dept: z.enum(DEPT_IDS), agent: z.string().max(60).optional(), freq: z.enum(FREQS).optional(),
  dow: z.number().int().min(0).max(6).optional(), time: z.string().optional(), action: z.enum(ACTION_TYPES).optional() });
const routinePatch = routineIn.partial().extend({ paused: z.boolean().optional() });
const productIn = z.object({ name: z.string().min(1).max(200), sku: z.string().max(60).optional(), stage: z.enum(STAGE_IDS).optional(),
  cost: z.coerce.number().min(0).optional(), price: z.coerce.number().min(0).optional() });
const productPatch = z.object({ name: z.string().max(200).optional(), stage: z.enum(STAGE_IDS).optional(), note: z.string().max(5000).optional(),
  asin: z.string().max(20).nullable().optional(), price: z.number().min(0).optional(), cost: z.number().min(0).optional(),
  stock: z.number().int().min(0).optional(), sales7d: z.number().int().min(0).optional() });
const kpiIn = z.object({ salesToday: z.number().optional(), profitToday: z.number().optional(), adSpendToday: z.number().optional(),
  cash: z.number().optional(), ordersToday: z.number().int().optional() });

export function registerRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.get('/api/health', async () => ({ ok: true, version: '0.1.0', uptime: Math.round(process.uptime()), model: !!ctx.env.ANTHROPIC_API_KEY }));

  app.get('/api/state', async () => snapshot(ctx));
  app.get('/api/export', async (_req, reply) => {
    reply.header('content-disposition', `attachment; filename="agents-company-${new Date().toISOString().slice(0, 10)}.json"`);
    return ops.exportState(ctx);
  });
  app.post('/api/import', { bodyLimit: 50 * 1024 * 1024 }, async req => { await ops.importState(ctx, req.body as never); return { ok: true }; });

  // tasks
  app.post('/api/tasks', async req => tasks.createTask(ctx, parse(newTask, req.body) as NewTask));
  app.post('/api/tasks/reassign', async req => { const b = parse(z.object({ from: z.string(), to: z.string() }), req.body); return tasks.reassignOpen(ctx, b.from, b.to); });
  app.patch('/api/tasks/:id', async req => tasks.updateTask(ctx, parse(id, P(req).id), req.body as never));
  app.post('/api/tasks/:id/cancel', async req => { await tasks.cancelTask(ctx, P(req).id!); return { ok: true }; });
  app.post('/api/tasks/:id/run', async req => { await tasks.runNow(ctx, P(req).id!); return { ok: true }; });
  app.post('/api/tasks/:id/approve', async req => { await tasks.approve(ctx, P(req).id!); return { ok: true }; });
  app.post('/api/tasks/:id/send-back', async req => { await tasks.sendBack(ctx, P(req).id!, (req.body as { note?: string })?.note); return { ok: true }; });
  app.post('/api/tasks/:id/reject', async req => { await tasks.reject(ctx, P(req).id!); return { ok: true }; });
  app.get('/api/tasks/:id/calls', async req => (await ctx.db.query(
    `select at, agent, tool, connector, action, value, input, output, status, approved_by, approved_at, duration_ms, error from tool_calls where task_id = $1 order by id`, [P(req).id])).rows);

  // routines
  app.post('/api/routines', async req => routines.createRoutine(ctx, parse(routineIn, req.body)));
  app.patch('/api/routines/:id', async req => { await routines.updateRoutine(ctx, P(req).id!, parse(routinePatch, req.body)); return { ok: true }; });
  app.delete('/api/routines/:id', async req => { await routines.deleteRoutine(ctx, P(req).id!); return { ok: true }; });
  app.post('/api/routines/:id/run', async req => { await routines.runRoutine(ctx, P(req).id!); return { ok: true }; });

  // products & alerts
  app.post('/api/products', async req => products.createProduct(ctx, parse(productIn, req.body)));
  app.patch('/api/products/:id', async req => { await products.updateProduct(ctx, P(req).id!, parse(productPatch, req.body) as never); return { ok: true }; });
  app.post('/api/alerts/:id/dismiss', async req => { await products.dismissAlert(ctx, P(req).id!); return { ok: true }; });
  app.post('/api/alerts/:id/task', async req => products.taskFromAlert(ctx, P(req).id!));

  // configuration
  app.put('/api/policies', async req => { await config.setPolicies(ctx, req.body as never); return { ok: true }; });
  app.put('/api/config', async req => { const b = req.body as { config?: never; note?: string }; return config.publishConfig(ctx, b?.config as never, b?.note); });
  app.post('/api/config/revert/:v', async req => config.revertConfig(ctx, Number(P(req).v)));
  app.put('/api/metrics/:dept', async req => { await ops.setMetricBase(ctx, P(req).dept!, parse(z.tuple([z.number(), z.number()]), (req.body as { values?: unknown })?.values)); return { ok: true }; });

  // connectors
  app.get('/api/connectors', async () => conn.connectorsList(ctx, ctx.db));
  app.post('/api/connectors', async req => conn.addConnector(ctx, req.body as never));
  app.delete('/api/connectors/:id', async req => { await conn.removeConnector(ctx, P(req).id!); return { ok: true }; });
  app.post('/api/connectors/:id/:action', async req => conn.connectorAction(ctx, P(req).id!, P(req).action!, (req.body || {}) as never));
  app.post('/api/integrations/spapi/sync', async () => conn.syncSellerCentral(ctx));

  // chat, engine, briefs
  app.post('/api/chat/:dept/greet', async req => { await greet(ctx, P(req).dept!); return { ok: true }; });
  app.post('/api/chat/:dept', async req => ({ reply: await ask(ctx, P(req).dept!, String((req.body as { text?: string })?.text || '')) }));
  app.put('/api/running', async req => { await ops.setRunning(ctx, !!(req.body as { on?: boolean })?.on); return { ok: true }; });
  app.post('/api/briefs/:id/read', async req => { await markBriefRead(ctx, P(req).id!); return { ok: true }; });

  // OAuth 2.1 callback for MCP connectors. Reached by a cross-site redirect (no session cookie with SameSite=Strict),
  // so it is authorised by the single-use state bound to the flow instead.
  app.get('/api/oauth/callback', async (req, reply) => {
    const q = req.query as { code?: string; state?: string; error?: string; error_description?: string };
    let ok = false; let msg: string;
    try {
      if (q.error) throw new Error(q.error_description || q.error);
      if (!q.code || !q.state) throw new Error('رد التفويض ناقص');
      const { finishOAuth } = await import('../connectors/oauth.js');
      const tool = await finishOAuth(ctx, q.state, q.code, async t => (await ctx.db.query('select url from connectors where tool = $1', [t])).rows[0]?.url);
      const r = await conn.realTest(ctx, tool);
      if (r) await conn.report(ctx, tool, r);
      ok = !!r?.ok; msg = ok ? `تم ربط «${ctx.org().tool(tool)?.name ?? tool}» بنجاح` : `اكتمل التفويض لكن فشل الاختبار: ${r?.error ?? ''}`;
    } catch (e) { msg = (e as Error).message; }
    const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
    reply.type('text/html; charset=utf-8').header('cache-control', 'no-store');
    return `<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>التفويض</title>
<body style="font-family:system-ui;background:#16183D;color:#EEF0FF;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h2>${ok ? '✓' : '✗'} ${esc(msg)}</h2><p>يمكنك إغلاق هذه النافذة والعودة إلى لوحة الإدارة.</p></div>
<script>try{window.opener&&window.opener.postMessage({type:'agents:oauth',ok:${ok}},location.origin);setTimeout(()=>window.close(),1500)}catch(e){}</script></body></html>`;
  });

  // owner files and imports
  app.get('/api/files', async () => files.listFiles(ctx.db));
  app.post('/api/files', { bodyLimit: 15 * 1024 * 1024 }, async req => files.uploadFile(ctx, parse(z.object({ name: z.string().min(1).max(200),
    mime: z.string().max(100).optional(), dataBase64: z.string().min(1), kind: z.enum(['upload', 'bank', 'rates']).optional(), note: z.string().max(500).optional() }), req.body)));
  app.get('/api/files/:id/download', async (req, reply) => {
    const f = await files.downloadFile(ctx.db, P(req).id!);
    reply.header('content-type', f.mime).header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`);
    return reply.send(f.data);
  });
  app.delete('/api/files/:id', async req => { await files.deleteFile(ctx, P(req).id!); return { ok: true }; });
  app.post('/api/files/:id/import-bank', async req => files.importBankStatement(ctx, P(req).id!));

  // audit trail of tool calls (spec §20)
  app.get('/api/tool-calls', async req => {
    const lim = Math.min(500, Number((req.query as { limit?: string }).limit) || 100);
    return (await ctx.db.query(`select id, at, task_id, agent, dept, tool, connector, action, value, status, approved_by, duration_ms, error
      from tool_calls order by id desc limit $1`, [lim])).rows;
  });

  // ingestion from automation tools (n8n / Make / Zapier), amounts in halalas
  app.post('/api/ingest/kpi', async req => ops.ingestKpi(ctx, parse(kpiIn, req.body) as Partial<Kpi>));
  app.post('/api/ingest/product', async req => products.ingestProduct(ctx, parse(z.object({ sku: z.string().optional(), asin: z.string().optional(),
    stock: z.number().int().min(0).optional(), sales7d: z.number().int().min(0).optional(), price: z.number().min(0).optional(), cost: z.number().min(0).optional() }), req.body)));

  // live events (SSE)
  app.get('/api/events', (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write('retry: 5000\n\n');
    const send = (e: ServerEvent) => { res.write(`data: ${JSON.stringify(e)}\n\n`); };
    const off = ctx.bus.subscribe(send);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.raw.on('close', () => { off(); clearInterval(ping); });
  });
}
