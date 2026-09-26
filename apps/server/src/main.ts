import { loadEnv } from './env.js';
import { build } from './app.js';

const env = loadEnv();
process.env.TZ ||= 'Asia/Riyadh';
const b = await build(env);
if (!env.ANTHROPIC_API_KEY) b.app.log.warn('ANTHROPIC_API_KEY غير مضبوط: المهام ستفشل برسالة واضحة حتى تضبطه، والمحادثة تعمل من البيانات فقط');
await b.app.listen({ port: env.PORT, host: env.HOST });

let closing = false;
const shutdown = async (sig: string) => {
  if (closing) return; closing = true;
  b.app.log.info(`${sig}: إيقاف الخادم`);
  await b.close().catch(e => b.app.log.error(e));
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
