import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { finish, makeApp, toolUse, wait } from './helpers.js';
import { snapshot } from '../src/services/snapshot.js';
import * as tasks from '../src/services/tasks.js';
import * as ops from '../src/services/ops.js';
import * as config from '../src/services/config.js';
import { EngineStopped, runTaskAgent } from '../src/agents/runtime.js';
import { getTask } from '../src/repo/rows.js';

type App = Awaited<ReturnType<typeof makeApp>>;
let A: App;
const sig = () => new AbortController().signal;
const task = (id: string) => getTask(A.ctx.db, id);

beforeAll(async () => { A = await makeApp(); await ops.seedDemo(A.ctx); });
afterAll(async () => { await A?.close(); });

describe('bootstrap', () => {
  it('creates the reference organisation, routines and planned runs', async () => {
    const s = await snapshot(A.ctx);
    expect(s.config.agents).toHaveLength(32);
    expect(s.routines).toHaveLength(18);
    expect(s.tasks.filter(t => t.routine).length).toBeGreaterThan(18);
    expect(s.products).toHaveLength(8);
    expect(s.products.find(p => p.id === 'p1')!.price).toBe(7900); // 79 SAR in halalas (spec §10)
    expect(Object.keys(s.connectors)).toHaveLength(34);
  });
  it('materialising routines twice creates no duplicates', async () => {
    const before = (await A.ctx.db.query('select count(*)::int n from tasks where routine_id is not null')).rows[0].n;
    await A.ctx.db.tx(async tx => { const { ensureRoutines } = await import('../src/services/routines.js'); await ensureRoutines(A.ctx, tx); });
    const after = (await A.ctx.db.query('select count(*)::int n from tasks where routine_id is not null')).rows[0].n;
    expect(after).toBe(before);
  });
});

describe('permission gate (spec §22)', () => {
  it('price +7% pauses for approval, then runs the stored call verbatim', async () => {
    const t = await tasks.createTask(A.ctx, { title: 'تحديث سعر منظم الأدراج +7%', dept: 'amazon', mode: 'auto' });
    expect(t!.ok).toBe(false);
    expect(A.jobs.queued).toContain(t!.id);
    A.llm.turns.push(toolUse('propose_price_change', { product_id: 'p1', percent: 7, reason: 'المنافس رفع سعره' }));
    await runTaskAgent(A.ctx, t!.id, sig());
    let cur = await task(t!.id);
    expect(cur.status).toBe('waiting');
    expect(cur.pendingCall?.tool).toBe('propose_price_change');
    expect(cur.approvalReason).toContain('تجاوز الحد 5%');
    expect(cur.artifact?.body).toContain('السعر المقترح: 85 ر.س');
    expect((await A.ctx.db.query(`select price from products where id = 'p1'`)).rows[0].price).toBe(7900); // nothing executed yet
    expect((await A.ctx.db.query(`select status from tool_calls where task_id = $1 and tool = 'propose_price_change'`, [t!.id])).rows[0].status).toBe('pending_approval');

    await tasks.approve(A.ctx, t!.id);
    cur = await task(t!.id);
    expect(cur.status).toBe('progress');
    A.llm.turns.push(req => {
      const last = req.messages[req.messages.length - 1]!;
      const txt = JSON.stringify(last.content);
      expect(txt).toContain('وافق المالك'); // the model is told the call ran as proposed
      return finish('رُفع السعر 7%').call(null, req);
    });
    await runTaskAgent(A.ctx, t!.id, sig());
    cur = await task(t!.id);
    expect(cur.status).toBe('done');
    expect(cur.result?.summary).toBe('رُفع السعر 7%');
    expect((await A.ctx.db.query(`select price from products where id = 'p1'`)).rows[0].price).toBe(8500);
    const calls = (await A.ctx.db.query(`select status, approved_by from tool_calls where task_id = $1 and tool = 'propose_price_change' order by id`, [t!.id])).rows;
    expect(calls.map(c => c.status)).toEqual(['approved', 'approved']);
  });

  it('price +4% executes immediately under the default policy', async () => {
    const t = await tasks.createTask(A.ctx, { title: 'تعديل سعر حامل الجوال +4%', dept: 'amazon', mode: 'auto' });
    expect(t!.ok).toBe(true);
    A.llm.turns.push(toolUse('propose_price_change', { product_id: 'p2', percent: 4, reason: 'موازنة' }), finish('تم تعديل السعر'));
    await runTaskAgent(A.ctx, t!.id, sig());
    expect((await task(t!.id)).status).toBe('done');
    expect((await A.ctx.db.query(`select price from products where id = 'p2'`)).rows[0].price).toBe(6100);
  });

  it('a gated call the model tries under a +4% task still needs approval when the value exceeds the limit', async () => {
    const t = await tasks.createTask(A.ctx, { title: 'مراجعة سعر الفرشاة', dept: 'amazon', mode: 'auto' });
    A.llm.turns.push(toolUse('propose_price_change', { product_id: 'p4', percent: -9, reason: 'منافس' }));
    await runTaskAgent(A.ctx, t!.id, sig());
    expect((await task(t!.id)).status).toBe('waiting');
    await tasks.reject(A.ctx, t!.id);
    expect((await task(t!.id)).status).toBe('cancelled');
    expect((await A.ctx.db.query(`select price from products where id = 'p4'`)).rows[0].price).toBe(9900);
  });

  it('payment always waits and never moves cash', async () => {
    const cash0 = (await A.ctx.db.query('select cash from company_state')).rows[0].cash;
    const t = await tasks.createTask(A.ctx, { title: 'تجهيز تحويل الدفعة الثانية', dept: 'finance', mode: 'auto' });
    A.llm.turns.push(toolUse('prepare_payment', { beneficiary: 'مصنع', amount_sar: 18500, reference: 'PO-1', purpose: 'الدفعة الثانية' }));
    await runTaskAgent(A.ctx, t!.id, sig());
    expect((await task(t!.id)).status).toBe('waiting');
    await tasks.approve(A.ctx, t!.id);
    A.llm.turns.push(finish('جُهّزت الدفعة'));
    await runTaskAgent(A.ctx, t!.id, sig());
    const cur = await task(t!.id);
    expect(cur.status).toBe('done');
    expect(cur.result?.summary).toBe('جُهّزت الدفعة وتنتظر التنفيذ منك في البنك');
    expect((await A.ctx.db.query('select cash from company_state')).rows[0].cash).toBe(cash0);
  });

  it('"after my approval" forces approval of a draft with no external action', async () => {
    const t = await tasks.createTask(A.ctx, { title: 'خطة عروض اليوم الوطني', dept: 'marketing', mode: 'approve' });
    A.llm.turns.push(finish('خطة العروض جاهزة', '# الخطة'));
    await runTaskAgent(A.ctx, t!.id, sig());
    let cur = await task(t!.id);
    expect(cur.status).toBe('waiting');
    expect(cur.artifact?.body).toBe('# الخطة');
    // send back with a note: the agent resumes the same transcript with the owner's note
    await tasks.sendBack(A.ctx, t!.id, 'أضف خصم 15%');
    A.llm.turns.push(req => {
      expect(JSON.stringify(req.messages.at(-1)!.content)).toContain('أضف خصم 15%');
      return finish('خطة معدلة', '# الخطة 2').call(null, req);
    });
    await runTaskAgent(A.ctx, t!.id, sig());
    cur = await task(t!.id);
    expect(cur.status).toBe('waiting');
    await tasks.approve(A.ctx, t!.id);
    expect((await task(t!.id)).status).toBe('done');
  });
});

describe('engine controls', () => {
  it('stopping the engine prevents any new model call', async () => {
    const t = await tasks.createTask(A.ctx, { title: 'تقرير المبيعات', dept: 'amazon', mode: 'auto' });
    await ops.setRunning(A.ctx, false);
    const calls = A.llm.requests.length;
    await expect(runTaskAgent(A.ctx, t!.id, sig())).rejects.toBeInstanceOf(EngineStopped);
    expect(A.llm.requests.length).toBe(calls);
    A.jobs.queued = [];
    await ops.setRunning(A.ctx, true);
    expect(A.jobs.queued).toContain(t!.id); // resumed work is re-queued
  });

  it('routes an automatic task through the CEO to the right department', async () => {
    const t = await tasks.createTask(A.ctx, { title: 'اطلب عينات من مصنع جديد', dept: 'auto', mode: 'auto' });
    expect(t!.dept).toBe('exec');
    await wait(1700);
    const cur = await task(t!.id);
    expect(cur.dept).toBe('supply');
    expect(cur.agent).not.toBe('المدير التنفيذي');
  });
});

describe('configuration versions', () => {
  it('publishes a rename, propagates it to tasks, and reverts as a new version', async () => {
    const cfg = structuredClone(A.ctx.org().config);
    cfg.agents.find(a => a.name === 'عمليات أمازون')!.name = 'محلل أمازون';
    const r = await config.publishConfig(A.ctx, cfg, 'اختبار');
    expect(r.version).toBe(2);
    expect(A.ctx.org().deptOf('محلل أمازون')).toBe('amazon');
    const n = (await A.ctx.db.query(`select count(*)::int n from tasks where agent = 'عمليات أمازون'`)).rows[0].n;
    expect(n).toBe(0);
    const back = await config.revertConfig(A.ctx, 1);
    expect(back.version).toBe(3);
    expect(A.ctx.org().deptOf('عمليات أمازون')).toBe('amazon');
  });

  it('rejects an invalid draft', async () => {
    const cfg = structuredClone(A.ctx.org().config);
    cfg.agents.find(a => a.name === 'عمليات أمازون')!.mgr = true;
    await expect(config.publishConfig(A.ctx, cfg)).rejects.toThrow('يحتاج مديرًا واحدًا');
  });

  it('policy edit changes approval for new tasks only (payment stays locked)', async () => {
    await config.setPolicies(A.ctx, A.ctx.org().config.policies.map(p => (p.action === 'price_change' ? { ...p, limit: 10 } : p.action === 'payment' ? { ...p, mode: 'auto' } : p)));
    const t = await tasks.createTask(A.ctx, { title: 'رفع سعر المنظم +7%', dept: 'amazon', mode: 'auto' });
    expect(t!.ok).toBe(true);
    expect(A.ctx.org().config.policies.find(p => p.action === 'payment')!.mode).toBe('always');
  });
});

describe('usage accounting', () => {
  it('records real token usage and cost per task', async () => {
    const u = (await A.ctx.db.query('select count(*)::int n, sum(cost)::bigint c from usage_records')).rows[0];
    expect(u.n).toBeGreaterThan(5);
    expect(Number(u.c)).toBeGreaterThan(0);
  });
});
