/* OAuth 2.1 (authorization code + PKCE, dynamic client registration) for remote MCP servers, per the MCP authorization spec.
   Client registration, tokens and the PKCE verifier live encrypted in the vault; refresh is handled by the SDK transport. */
import crypto from 'node:crypto';
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Ctx } from '../context.js';

const key = (tool: string, part: 'client' | 'tokens' | 'verifier') => `oauth:${tool}:${part}`;

export const redirectUrl = (ctx: Ctx): string => `${(ctx.env.PUBLIC_URL || `http://localhost:${ctx.env.PORT}`).replace(/\/$/, '')}/api/oauth/callback`;

export class VaultOAuthProvider implements OAuthClientProvider {
  /** set when the flow needs the owner's browser */
  authorizationUrl: URL | null = null;
  constructor(private ctx: Ctx, private tool: string, private stateValue?: string) {}

  get redirectUrl(): string { return redirectUrl(this.ctx); }
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: 'شركة الوكلاء', redirect_uris: [this.redirectUrl], grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'], token_endpoint_auth_method: 'none' };
  }
  state(): string { return this.stateValue ?? ''; }
  private async read<T>(part: 'client' | 'tokens' | 'verifier'): Promise<T | undefined> {
    const v = await this.ctx.vault.get(this.ctx.db, key(this.tool, part)); return v ? JSON.parse(v) as T : undefined;
  }
  private write(part: 'client' | 'tokens' | 'verifier', v: unknown): Promise<void> { return this.ctx.vault.set(this.ctx.db, key(this.tool, part), JSON.stringify(v)); }
  clientInformation() { return this.read<OAuthClientInformationMixed>('client'); }
  saveClientInformation(c: OAuthClientInformationMixed) { return this.write('client', c); }
  tokens() { return this.read<OAuthTokens>('tokens'); }
  saveTokens(t: OAuthTokens) { return this.write('tokens', t); }
  redirectToAuthorization(url: URL) { this.authorizationUrl = url; }
  saveCodeVerifier(v: string) { return this.write('verifier', v); }
  async codeVerifier() { const v = await this.read<string>('verifier'); if (!v) throw new Error('انتهت جلسة التفويض؛ أعد الربط'); return v; }
  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    const parts = scope === 'all' ? ['client', 'tokens', 'verifier'] as const : scope === 'discovery' ? [] : [scope];
    for (const p of parts) await this.ctx.vault.delete(this.ctx.db, key(this.tool, p));
  }
}

export async function hasOAuthTokens(ctx: Ctx, tool: string): Promise<boolean> { return ctx.vault.has(ctx.db, key(tool, 'tokens')); }

export async function clearOAuth(ctx: Ctx, tool: string): Promise<void> {
  for (const p of ['client', 'tokens', 'verifier'] as const) await ctx.vault.delete(ctx.db, key(tool, p));
}

/** Starts the flow. Returns the URL the owner must open, or null when stored tokens are still valid. */
export async function startOAuth(ctx: Ctx, tool: string, serverUrl: string): Promise<string | null> {
  const state = crypto.randomBytes(24).toString('base64url');
  await ctx.db.query(`delete from oauth_states where created_at < now() - interval '15 minutes'`);
  await ctx.db.query('insert into oauth_states (state, tool) values ($1,$2)', [state, tool]);
  const p = new VaultOAuthProvider(ctx, tool, state);
  const r = await auth(p, { serverUrl });
  return r === 'REDIRECT' ? p.authorizationUrl!.toString() : null;
}

/** Completes the flow from the callback; the state is single-use and expires after 15 minutes. */
export async function finishOAuth(ctx: Ctx, state: string, code: string, serverUrlOf: (tool: string) => Promise<string>): Promise<string> {
  const r = await ctx.db.query(`delete from oauth_states where state = $1 and created_at > now() - interval '15 minutes' returning tool`, [state]);
  const tool = r.rows[0]?.tool as string | undefined;
  if (!tool) throw new Error('طلب تفويض غير صالح أو منتهي؛ أعد الربط من لوحة الإدارة');
  const res = await auth(new VaultOAuthProvider(ctx, tool), { serverUrl: await serverUrlOf(tool), authorizationCode: code });
  if (res !== 'AUTHORIZED') throw new Error('لم يكتمل التفويض');
  return tool;
}
