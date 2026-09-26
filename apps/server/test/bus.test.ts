import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServerEvent } from '@agents/domain';
import { build, type Built } from '../src/app.js';
import { loadEnv } from '../src/env.js';
import { FakeLlm, RecordingJobs, TEST_DB, makeApp, wait } from './helpers.js';
import * as tasks from '../src/services/tasks.js';
import * as config from '../src/services/config.js';
import { snapshot } from '../src/services/snapshot.js';

let A: Awaited<ReturnType<typeof makeApp>>; let B: Built; let jobsB: RecordingJobs;
const received: ServerEvent[] = [];

beforeAll(async () => {
  A = await makeApp({ EVENT_BUS: 'pg' });
  jobsB = new RecordingJobs();
  const env = loadEnv({ DATABASE_URL: TEST_DB, MASTER_KEY: 'test-master-key-0123456789', ANTHROPIC_API_KEY: 'test', LOG_LEVEL: 'silent', ENGINE_DISABLED: 'true', EVENT_BUS: 'pg' } as NodeJS.ProcessEnv);
  B = await build(env, { llm: new FakeLlm(), jobs: jobsB, logger: false });
  B.ctx.bus.subscribe(e => received.push(e));
});
afterAll(async () => { await B?.close(); await A?.close(); });

describe('multi-instance event bus (LISTEN/NOTIFY)', () => {
  it('delivers task events from instance A to subscribers on instance B', async () => {
    const t = await tasks.createTask(A.ctx, { title: 'تقرير المبيعات اليومي', dept: 'amazon', mode: 'schedule', at: Date.now() + 3600_000 });
    await wait(400);
    expect(received.some(e => e.type === 'task.upsert' && e.task.id === t!.id)).toBe(true);
  });

  it('reloads the published config on B and refetches the snapshot', async () => {
    const cfg = structuredClone(A.ctx.org().config);
    cfg.agents.find(a => a.name === 'عمليات أمازون')!.name = 'عمليات المتجر';
    received.length = 0;
    await config.publishConfig(A.ctx, cfg, 'اختبار الناقل');
    await wait(800);
    expect(B.ctx.org().deptOf('عمليات المتجر')).toBe('amazon');
    const snap = received.find(e => e.type === 'snapshot');
    expect(snap && snap.type === 'snapshot' && snap.state.config.agents.some(a => a.name === 'عمليات المتجر')).toBe(true);
    expect((await snapshot(B.ctx)).config.version).toBe(A.ctx.org().config.version);
  });

  it('an abort issued on A reaches the executor on B', async () => {
    A.ctx.jobs.abortTask('t_remote');
    await wait(400);
    expect(jobsB.aborted).toContain('t_remote');
  });
});
