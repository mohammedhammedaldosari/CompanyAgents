import { z } from 'zod';

const bool = z.enum(['true', 'false', '1', '0', '']).optional().transform(v => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().default(8080),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL مطلوب'),
  /** 32-byte key (base64) or passphrase; encrypts connector secrets at rest */
  MASTER_KEY: z.string().min(16, 'MASTER_KEY مطلوب (openssl rand -base64 32)'),
  /** optional: sets the owner password on first boot if none exists */
  OWNER_PASSWORD: z.string().optional(),
  SESSION_DAYS: z.coerce.number().int().positive().default(30),
  COOKIE_SECURE: bool,
  TRUST_PROXY: bool,
  CORS_ORIGIN: z.string().optional().default(''),
  WEB_DIST: z.string().optional().default(''),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  ANTHROPIC_API_KEY: z.string().optional().default(''),
  MODEL_HAIKU: z.string().default('claude-haiku-4-5'),
  MODEL_SONNET: z.string().default('claude-sonnet-5'),
  MODEL_OPUS: z.string().default('claude-opus-5'),
  AGENT_MAX_TOKENS: z.coerce.number().int().positive().default(16000),
  AGENT_MAX_TURNS: z.coerce.number().int().positive().default(12),
  AGENT_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
  MAX_CONCURRENT: z.coerce.number().int().positive().default(3),
  /** USD→SAR rate used to convert model prices into halalas */
  USD_SAR: z.coerce.number().positive().default(3.75),

  SPAPI_CLIENT_ID: z.string().optional().default(''),
  SPAPI_CLIENT_SECRET: z.string().optional().default(''),
  SPAPI_REFRESH_TOKEN: z.string().optional().default(''),
  SPAPI_ENDPOINT: z.string().url().default('https://sellingpartnerapi-eu.amazon.com'),
  SPAPI_MARKETPLACE_ID: z.string().default('A17E79C6D8DWNP'),
  SPAPI_SYNC_MINUTES: z.coerce.number().int().min(5).default(15),

  /** disables the scheduler/executor (used by tests and one-off CLI commands) */
  ENGINE_DISABLED: bool
});

export type Env = z.infer<typeof schema>;

export function loadEnv(src: NodeJS.ProcessEnv = process.env): Env {
  const r = schema.safeParse(src);
  if (!r.success) {
    const msg = r.error.issues.map(i => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`إعدادات البيئة غير صالحة:\n${msg}`);
  }
  return r.data;
}
