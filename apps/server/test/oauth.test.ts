import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthMetadataRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { setupAuthServer } from '@modelcontextprotocol/sdk/examples/server/demoInMemoryOAuthProvider.js';
import { finish, makeApp, toolUse } from './helpers.js';
import * as tasks from '../src/services/tasks.js';
import { runTaskAgent } from '../src/agents/runtime.js';
import { getTask } from '../src/repo/rows.js';

type App = Awaited<ReturnType<typeof makeApp>>;
let A: App; let cookie = ''; let mcpSrv: http.Server; let mcpUrl = '';
const seen: string[] = [];

async function startOAuthMcp(): Promise<void> {
  const authPort = 18000 + Math.floor(Math.random() * 1000);
  const app = express(); app.use(express.json());
  mcpSrv = app.listen(0);
  await new Promise(r => mcpSrv.once('listening', r));
  mcpUrl = `http://localhost:${(mcpSrv.address() as AddressInfo).port}/mcp`;
  const meta = setupAuthServer({ authServerUrl: new URL(`http://localhost:${authPort}`), mcpServerUrl: new URL(mcpUrl), strictResource: false });
  await new Promise(r => setTimeout(r, 300));
  app.use(mcpAuthMetadataRouter({ oauthMetadata: meta, resourceServerUrl: new URL(mcpUrl), scopesSupported: ['mcp:tools'] }));
  const verifier = { verifyAccessToken: async (token: string) => {
    const r = await fetch(meta.introspection_endpoint!, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }) });
    if (!r.ok) throw new Error('invalid token');
    const d = await r.json() as { client_id: string; scope?: string; exp?: number };
    return { token, clientId: d.client_id, scopes: d.scope ? d.scope.split(' ') : [], expiresAt: d.exp };
  } };
  app.post('/mcp', requireBearerAuth({ verifier, requiredScopes: [], resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(mcpUrl)) }), async (req, res) => {
    const server = new McpServer({ name: 'oauth-notes', version: '1.0.0' });
    server.registerTool('search_pages', { description: 'Search pages', inputSchema: { q: z.string() }, annotations: { readOnlyHint: true } },
      async ({ q }) => { seen.push(q); return { content: [{ type: 'text', text: `صفحة واحدة عن ${q}` }] }; });
    const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(t);
    await t.handleRequest(req, res, req.body);
  });
}

beforeAll(async () => {
  A = await makeApp({ PUBLIC_URL: 'http://localhost:8080' });
  await startOAuthMcp();
  const r = await A.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'Correct-Horse-9-Battery' } });
  cookie = r.cookies.find(c => c.name === 'ac_session')!.value;
});
afterAll(async () => { await A?.close(); mcpSrv?.close(); });

describe('OAuth 2.1 for MCP connectors', () => {
  it('registers dynamically, sends the owner to authorize, completes on callback, and agents use the token', async () => {
    const start = await A.app.inject({ method: 'POST', url: '/api/connectors/notion/connect', cookies: { ac_session: cookie }, payload: { url: mcpUrl, auth: 'oauth' } });
    expect(start.statusCode).toBe(200);
    const authorizeUrl = start.json().authorizeUrl as string;
    expect(authorizeUrl).toContain('code_challenge=');
    expect(start.json().state).toBe('connecting');

    // the owner's browser: the demo authorization server approves and redirects back with code + state
    const redirect = await fetch(authorizeUrl, { redirect: 'manual' });
    const back = new URL(redirect.headers.get('location')!);
    expect(back.pathname).toBe('/api/oauth/callback');

    const cb = await A.app.inject({ method: 'GET', url: back.pathname + back.search }); // no session cookie (cross-site redirect)
    expect(cb.statusCode).toBe(200);
    expect(cb.body).toContain('تم ربط');
    const st = (await A.ctx.db.query(`select state, auth from connectors where tool = 'notion'`)).rows[0];
    expect(st).toEqual({ state: 'connected', auth: 'oauth' });

    // replaying the callback fails: state is single-use
    const replay = await A.app.inject({ method: 'GET', url: back.pathname + back.search });
    expect(replay.body).toContain('غير صالح');

    const t = await tasks.createTask(A.ctx, { title: 'تنظيم ملاحظات الأسبوع', dept: 'exec', mode: 'auto' });
    A.llm.turns.push(req => {
      expect((req.tools as { name: string }[]).map(x => x.name)).toContain('mcp_notion_search_pages');
      return toolUse('mcp_notion_search_pages', { q: 'الموردون' }).call(null, req);
    }, finish('نُظمت الملاحظات'));
    await runTaskAgent(A.ctx, t!.id, new AbortController().signal);
    expect((await getTask(A.ctx.db, t!.id)).status).toBe('done');
    expect(seen).toContain('الموردون');
  });

  it('rejects a forged callback', async () => {
    const r = await A.app.inject({ method: 'GET', url: '/api/oauth/callback?code=x&state=forged' });
    expect(r.body).toContain('غير صالح');
  });
});
