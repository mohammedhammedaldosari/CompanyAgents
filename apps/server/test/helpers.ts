import type Anthropic from '@anthropic-ai/sdk';
import pg from 'pg';
import { build, type Built } from '../src/app.js';
import { loadEnv } from '../src/env.js';
import type { Jobs, LlmClient } from '../src/context.js';

export const TEST_DB = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/agents_test';

export async function resetDb(): Promise<void> {
  const c = new pg.Client({ connectionString: TEST_DB });
  await c.connect();
  await c.query('drop schema if exists pgboss cascade; drop schema public cascade; create schema public;');
  await c.end();
}

export type Turn = (req: Anthropic.MessageCreateParamsNonStreaming) => { content: Anthropic.ContentBlock[]; stop_reason?: Anthropic.StopReason };

/** Scripted model: each call pops the next turn. Records every request for assertions. */
export class FakeLlm implements LlmClient {
  turns: Turn[] = []; requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  messages = {
    create: async (body: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> => {
      this.requests.push(structuredClone(body));
      const turn = this.turns.shift();
      if (!turn) throw new Error('FakeLlm: no scripted turn left');
      const r = turn(body);
      return { id: `msg_${this.requests.length}`, type: 'message', role: 'assistant', model: body.model, content: r.content,
        stop_reason: r.stop_reason ?? (r.content.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn'), stop_sequence: null,
        usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as unknown as Anthropic.Message;
    }
  };
}

let n = 0;
export const toolUse = (name: string, input: Record<string, unknown>): Turn => () =>
  ({ content: [{ type: 'tool_use', id: `tu_${++n}`, name, input } as Anthropic.ToolUseBlock] });
export const finish = (summary: string, document = `# ${summary}`): Turn => toolUse('submit_result', { summary, document });

export class RecordingJobs implements Jobs {
  queued: string[] = []; aborted: string[] = [];
  async enqueueTask(id: string) { this.queued.push(id); }
  abortTask(id: string) { this.aborted.push(id); }
  abortAll() { this.aborted.push('*'); }
}

export async function makeApp(extra: Record<string, string> = {}): Promise<Built & { llm: FakeLlm; jobs: RecordingJobs }> {
  await resetDb();
  const env = loadEnv({
    DATABASE_URL: TEST_DB, MASTER_KEY: 'test-master-key-0123456789', ANTHROPIC_API_KEY: 'test', LOG_LEVEL: 'silent',
    OWNER_PASSWORD: 'Correct-Horse-9-Battery', ENGINE_DISABLED: 'true', ...extra
  } as NodeJS.ProcessEnv);
  const llm = new FakeLlm(); const jobs = new RecordingJobs();
  const b = await build(env, { llm, jobs, logger: false });
  return Object.assign(b, { llm, jobs });
}

export const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
