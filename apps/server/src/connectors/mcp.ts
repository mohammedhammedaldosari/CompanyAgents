/* MCP client (Streamable HTTP). The server — not the model — talks to MCP servers, so every tool call an agent makes
   passes through the permission gate and the audit log (see agents/tools.ts). */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';

/** A static bearer token (API key) or an OAuth provider (tokens refreshed by the SDK). */
export type McpAuth = string | null | OAuthClientProvider;

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  destructive: boolean;
}

export interface McpSession {
  serverName: string;
  tools: McpToolInfo[];
  call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ text: string; isError: boolean }>;
  close(): Promise<void>;
}

const TIMEOUT = 30_000;

export async function openMcp(url: string, authz: McpAuth, signal?: AbortSignal): Promise<McpSession> {
  const transport = new StreamableHTTPClientTransport(new URL(url), authz && typeof authz === 'object'
    ? { authProvider: authz }
    : { requestInit: { headers: authz ? { Authorization: `Bearer ${authz}` } : {} } });
  const client = new Client({ name: 'agents-company', version: '0.1.0' });
  await client.connect(transport, { timeout: TIMEOUT, signal });
  const listed = await client.listTools(undefined, { timeout: TIMEOUT, signal });
  const tools: McpToolInfo[] = listed.tools.map(t => ({
    name: t.name,
    description: (t.description || '').slice(0, 1000),
    inputSchema: (t.inputSchema as Record<string, unknown>) || { type: 'object', properties: {} },
    // MCP annotations are hints from the server; anything not explicitly read-only is treated as a write
    readOnly: t.annotations?.readOnlyHint === true,
    destructive: t.annotations?.destructiveHint !== false && t.annotations?.readOnlyHint !== true
  }));
  const info = client.getServerVersion();
  return {
    serverName: info?.name || new URL(url).hostname,
    tools,
    async call(name, args, sig) {
      const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000, signal: sig });
      const content = Array.isArray(r.content) ? r.content : [];
      const text = content.map((c: { type: string; text?: string }) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
      return { text: text.slice(0, 50_000), isError: !!r.isError };
    },
    close: () => client.close()
  };
}

/** Connectivity test used by the admin console: initialize + tools/list. */
export async function testMcp(url: string, token: McpAuth): Promise<{ ok: boolean; latency: number; note?: string; error?: string; tools?: number }> {
  const t0 = Date.now(); const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const s = await openMcp(url, token, ctrl.signal);
    const latency = Date.now() - t0;
    await s.close().catch(() => {});
    return { ok: true, latency, tools: s.tools.length, note: `نجح الاتصال بخادم MCP «${s.serverName}» · ${s.tools.length} أداة · ${latency} مللي ثانية` };
  } catch (e) {
    const msg = (e as Error).message || String(e);
    const auth = /401|403|unauthori[sz]ed|forbidden/i.test(msg);
    return { ok: false, latency: Date.now() - t0, error: ctrl.signal.aborted ? 'انتهت المهلة (15 ثانية)' : auth ? 'رفض الخادم التفويض — تحقق من رمز الوصول' : `تعذّر الاتصال: ${msg.slice(0, 200)}` };
  } finally { clearTimeout(to); }
}
