/* Composition root: builds the context, the HTTP server and (optionally) the engine. */
import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fstatic from '@fastify/static';
import { defaultConfig } from '@agents/domain';
import type { Ctx, Jobs, LlmClient } from './context.js';
import { makeOrgHolder } from './context.js';
import { createDb, migrate } from './db/db.js';
import { Bus } from './core/bus.js';
import { Vault } from './core/vault.js';
import { AppError } from './core/errors.js';
import type { Env } from './env.js';
import { metricsRefresher } from './services/metrics.js';
import { bootstrap } from './services/ops.js';
import { Engine, noJobs } from './engine/engine.js';
import { authGuard, ownerExists, registerAuth, setOwnerPassword } from './http/auth.js';
import { registerRoutes } from './http/routes.js';

export interface Built { app: FastifyInstance; ctx: Ctx; engine: Engine | null; close(): Promise<void> }

export async function build(env: Env, opts: { llm?: LlmClient; jobs?: Jobs; logger?: boolean } = {}): Promise<Built> {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: env.LOG_LEVEL, redact: ['req.headers.authorization', 'req.headers.cookie'] },
    trustProxy: env.TRUST_PROXY, bodyLimit: 2 * 1024 * 1024
  });
  const bus = new Bus();
  const db = createDb(env.DATABASE_URL, ev => bus.publish(ev), e => app.log.error({ err: e }, 'db'));
  await migrate(db, m => app.log.info(m));

  const holder = makeOrgHolder(defaultConfig());
  let engine: Engine | null = null;
  const jobsProxy: Jobs = {
    enqueueTask: id => (opts.jobs ?? engine ?? noJobs).enqueueTask(id),
    abortTask: id => (opts.jobs ?? engine ?? noJobs).abortTask(id),
    abortAll: () => (opts.jobs ?? engine ?? noJobs).abortAll()
  };
  // eslint-disable-next-line prefer-const
  let ctx: Ctx;
  const refresh = metricsRefresher(() => ctx);
  ctx = {
    env, db, bus, vault: new Vault(env.MASTER_KEY), log: app.log, jobs: jobsProxy,
    org: holder.org, setConfig: holder.set, refreshMetrics: refresh, llm: opts.llm
  };

  await bootstrap(ctx);
  if (env.OWNER_PASSWORD && !(await ownerExists(ctx))) { await setOwnerPassword(ctx, env.OWNER_PASSWORD); app.log.info('✓ ضُبطت كلمة مرور المالك من OWNER_PASSWORD'); }

  await app.register(cookie);
  await app.register(rateLimit, { max: 600, timeWindow: '1 minute' });
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff').header('referrer-policy', 'no-referrer').header('x-frame-options', 'DENY')
      .header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    return payload;
  });
  // mutations must be JSON: blocks cross-site form posts (CSRF) on top of SameSite=Strict cookies
  app.addHook('preHandler', async req => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.url.startsWith('/api/') && req.headers['content-length'] !== '0'
      && req.body !== undefined && !String(req.headers['content-type'] || '').startsWith('application/json')) throw new AppError('نوع المحتوى يجب أن يكون JSON', 415);
  });
  app.addHook('preHandler', authGuard(ctx));
  app.setErrorHandler((e: Error & { statusCode?: number; validation?: unknown }, req, reply) => {
    if (e instanceof AppError) return reply.status(e.status).send({ error: e.message });
    if (e.statusCode === 429) return reply.status(429).send({ error: 'محاولات كثيرة؛ حاول لاحقًا' });
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ error: e.message });
    req.log.error({ err: e }, 'unhandled');
    return reply.status(500).send({ error: 'خطأ داخلي في الخادم' });
  });

  registerAuth(app, ctx);
  registerRoutes(app, ctx);

  const web = env.WEB_DIST && path.resolve(env.WEB_DIST);
  if (web && fs.existsSync(path.join(web, 'index.html'))) {
    await app.register(fstatic, { root: web, prefix: '/', wildcard: false, maxAge: '1h', setHeaders: (reply, p) => { if (p.endsWith('index.html')) reply.header('cache-control', 'no-cache'); } });
    app.setNotFoundHandler((req, reply) => (req.url.startsWith('/api/') ? reply.status(404).send({ error: 'مسار غير موجود' }) : reply.sendFile('index.html')));
  } else {
    app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: 'مسار غير موجود' }));
  }

  if (!env.ENGINE_DISABLED && !opts.jobs) {
    engine = new Engine(() => ctx);
    await engine.start(env.DATABASE_URL, env.MAX_CONCURRENT);
  }

  return {
    app, ctx, engine,
    async close() { await engine?.stop(); await app.close(); await db.close(); }
  };
}
