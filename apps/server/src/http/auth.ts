/* Single-owner authentication (spec §20): strong password, server-side sessions (only the SHA-256 of the token is stored),
   HttpOnly SameSite=Strict cookie, 30-day expiry. Integrations use separate scoped API tokens (ingest only). */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Ctx } from '../context.js';
import { hashPassword, passwordProblem, randomToken, sha256, verifyPassword } from '../core/password.js';
import { AppError, bad } from '../core/errors.js';

export const COOKIE = 'ac_session';

declare module 'fastify' {
  interface FastifyRequest { principal?: { kind: 'owner'; sessionId: string } | { kind: 'ingest'; tokenId: string } }
}

export async function setOwnerPassword(ctx: Ctx, pw: string): Promise<void> {
  const p = passwordProblem(pw); if (p) throw bad(p);
  const h = await hashPassword(pw);
  await ctx.db.query(`insert into owner_account (id, password_hash) values (1, $1) on conflict (id) do update set password_hash = excluded.password_hash, updated_at = now()`, [h]);
}

export async function ownerExists(ctx: Ctx): Promise<boolean> {
  return !!(await ctx.db.query('select 1 from owner_account where id = 1')).rowCount;
}

async function sessionFor(ctx: Ctx, token: string): Promise<string | null> {
  if (!token) return null;
  const id = sha256(token);
  const r = await ctx.db.query(`update sessions set last_seen_at = now() where id = $1 and expires_at > now() returning id`, [id]);
  return r.rowCount ? id : null;
}

async function ingestTokenFor(ctx: Ctx, token: string): Promise<string | null> {
  if (!token) return null;
  const r = await ctx.db.query(`update api_tokens set last_used_at = now() where token_hash = $1 and scope = 'ingest' returning id`, [sha256(token)]);
  return r.rows[0]?.id ?? null;
}

export function registerAuth(app: FastifyInstance, ctx: Ctx): void {
  const cookieOpts = { path: '/', httpOnly: true, sameSite: 'strict' as const, secure: ctx.env.COOKIE_SECURE, maxAge: ctx.env.SESSION_DAYS * 86400 };

  app.post('/api/auth/login', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const pw = String((req.body as { password?: string })?.password || '');
    const row = (await ctx.db.query<{ password_hash: string }>('select password_hash from owner_account where id = 1')).rows[0];
    if (!row) throw new AppError('لم تُضبط كلمة مرور المالك بعد. شغّل: pnpm --filter @agents/server cli set-password', 409);
    if (!pw || !(await verifyPassword(pw, row.password_hash))) {
      await new Promise(r => setTimeout(r, 400));
      throw new AppError('كلمة المرور غير صحيحة', 401);
    }
    const token = randomToken();
    await ctx.db.query(`insert into sessions (id, expires_at, ip, user_agent) values ($1, now() + make_interval(days => $2), $3, $4)`,
      [sha256(token), ctx.env.SESSION_DAYS, req.ip, String(req.headers['user-agent'] || '').slice(0, 300)]);
    reply.setCookie(COOKIE, token, cookieOpts);
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const t = req.cookies[COOKIE];
    if (t) await ctx.db.query('delete from sessions where id = $1', [sha256(t)]);
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async req => {
    const sid = await sessionFor(ctx, req.cookies[COOKIE] || '');
    return { authenticated: !!sid, ownerConfigured: await ownerExists(ctx) };
  });

  app.post('/api/auth/password', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const sid = await sessionFor(ctx, req.cookies[COOKIE] || '');
    if (!sid) throw new AppError('غير مصرّح', 401);
    const b = req.body as { current?: string; next?: string };
    const row = (await ctx.db.query<{ password_hash: string }>('select password_hash from owner_account where id = 1')).rows[0]!;
    if (!(await verifyPassword(String(b?.current || ''), row.password_hash))) throw new AppError('كلمة المرور الحالية غير صحيحة', 401);
    await setOwnerPassword(ctx, String(b?.next || ''));
    await ctx.db.query('delete from sessions where id <> $1', [sid]); // sign out every other device
    reply.status(204);
  });
}

/** preHandler for /api/*: owner session (cookie or Bearer), or an ingest token on /api/ingest/*. */
export function authGuard(ctx: Ctx) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const url = req.url.split('?')[0]!;
    if (!url.startsWith('/api/') || url.startsWith('/api/auth/') || url === '/api/health') return;
    const bearer = (req.headers.authorization || '').startsWith('Bearer ') ? req.headers.authorization!.slice(7) : '';
    const sid = await sessionFor(ctx, req.cookies[COOKIE] || bearer);
    if (sid) { req.principal = { kind: 'owner', sessionId: sid }; return; }
    if (url.startsWith('/api/ingest/')) {
      const tid = await ingestTokenFor(ctx, bearer);
      if (tid) { req.principal = { kind: 'ingest', tokenId: tid }; return; }
    }
    throw new AppError('غير مصرّح', 401);
  };
}
