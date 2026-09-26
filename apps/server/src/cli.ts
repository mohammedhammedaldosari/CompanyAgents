/* Admin CLI: migrate · set-password · token:create <name> · token:list · seed-demo */
import readline from 'node:readline/promises';
import { loadEnv } from './env.js';
import { build } from './app.js';
import { setOwnerPassword } from './http/auth.js';
import { randomToken, sha256 } from './core/password.js';
import { newId } from './core/ids.js';
import { seedDemo } from './services/ops.js';

const [cmd, ...args] = process.argv.slice(2);
process.env.ENGINE_DISABLED = 'true';
process.env.TZ ||= 'Asia/Riyadh';
const env = loadEnv();
const b = await build(env, { logger: false });
const out = (s: string) => process.stdout.write(s + '\n');
try {
  switch (cmd) {
    case 'migrate': out('✓ الترحيلات مطبّقة'); break;
    case 'set-password': {
      let pw = process.env.NEW_PASSWORD || '';
      if (!pw) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        pw = await rl.question('كلمة مرور المالك الجديدة: '); rl.close();
      }
      await setOwnerPassword(b.ctx, pw.trim());
      await b.ctx.db.query('delete from sessions');
      out('✓ ضُبطت كلمة المرور وأُنهيت كل الجلسات');
      break;
    }
    case 'token:create': {
      const name = args.join(' ') || 'تكامل';
      const tok = `ing_${randomToken()}`;
      await b.ctx.db.query(`insert into api_tokens (id, name, token_hash, scope) values ($1,$2,$3,'ingest')`, [newId('k'), name, sha256(tok)]);
      out(`✓ رمز استقبال «${name}» (يظهر مرة واحدة فقط):\n${tok}`);
      break;
    }
    case 'token:list': {
      const r = await b.ctx.db.query('select id, name, created_at, last_used_at from api_tokens order by created_at');
      r.rows.forEach(x => out(`${x.id}\t${x.name}\t${x.last_used_at ? 'آخر استخدام ' + x.last_used_at.toISOString() : 'لم يُستخدم'}`));
      break;
    }
    case 'token:revoke': await b.ctx.db.query('delete from api_tokens where id = $1', [args[0]]); out('✓ أُلغي الرمز'); break;
    case 'seed-demo': await seedDemo(b.ctx); out('✓ أُضيفت بيانات العرض (8 منتجات ومؤشرات أمس)'); break;
    default: out('الأوامر: migrate | set-password | token:create <الاسم> | token:list | token:revoke <id> | seed-demo'); process.exitCode = 1;
  }
} catch (e) { process.stderr.write(`✗ ${(e as Error).message}\n`); process.exitCode = 1; }
finally { await b.close(); }
