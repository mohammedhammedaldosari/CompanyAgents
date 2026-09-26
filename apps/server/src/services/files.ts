/* Owner files (spec §19 «ملفاتك المرفوعة» · «كشوف البنوك» · «شركات الشحن»): upload, read by agents, and bank statement import.
   Files are stored in PostgreSQL (one store to back up). Text-like files keep an extracted text copy for the agents. */
import crypto from 'node:crypto';
import { H } from '@agents/domain';
import type { Ctx } from '../context.js';
import type { Queryable } from '../db/db.js';
import { bad, notFound } from '../core/errors.js';
import { newId } from '../core/ids.js';
import { parseCsv, parseDay, parseMoney } from '../core/csv.js';
import { audit, emitKpi, patchCompany } from './common.js';

export type FileKind = 'upload' | 'bank' | 'rates';
export const MAX_FILE = 10 * 1024 * 1024;
/** Which catalog tool gives an agent access to each kind of file. */
export const KIND_TOOL: Record<FileKind, string> = { upload: 'files', bank: 'bank', rates: 'forwarders' };
const TEXT_MIME = /^(text\/|application\/(json|csv|xml|x-ndjson))/;
const TEXT_EXT = /\.(csv|tsv|txt|md|json|xml)$/i;

export interface FileMeta { id: string; name: string; mime: string; kind: FileKind; size: number; note: string; uploadedAt: number; hasText: boolean }

const meta = (r: { id: string; name: string; mime: string; kind: FileKind; size: number; note: string; uploaded_at: Date; has_text: boolean }): FileMeta =>
  ({ id: r.id, name: r.name, mime: r.mime, kind: r.kind, size: r.size, note: r.note, uploadedAt: r.uploaded_at.getTime(), hasText: r.has_text });

export async function listFiles(db: Queryable, kinds?: FileKind[]): Promise<FileMeta[]> {
  const r = await db.query(`select id, name, mime, kind, size, note, uploaded_at, text_content is not null as has_text from files
    ${kinds ? 'where kind = any($1)' : ''} order by uploaded_at desc limit 200`, kinds ? [kinds] : []);
  return r.rows.map(meta);
}

export async function uploadFile(ctx: Ctx, i: { name: string; mime?: string; dataBase64: string; kind?: FileKind; note?: string }): Promise<FileMeta & { imported?: BankImport }> {
  const name = String(i.name || '').trim().slice(0, 200).replace(/[/\\]/g, '_');
  if (!name) throw bad('اسم الملف مطلوب');
  const kind: FileKind = i.kind && i.kind in KIND_TOOL ? i.kind : 'upload';
  const data = Buffer.from(String(i.dataBase64 || ''), 'base64');
  if (!data.length) throw bad('الملف فارغ');
  if (data.length > MAX_FILE) throw bad('حجم الملف أكبر من 10 ميجابايت');
  const mime = String(i.mime || 'application/octet-stream').slice(0, 100);
  const isText = TEXT_MIME.test(mime) || TEXT_EXT.test(name);
  const text = isText ? data.toString('utf8').replace(/^\uFEFF/, '') : null;
  if (kind === 'bank' && !text) throw bad('كشف البنك يجب أن يكون ملف CSV (صدّره من البنك أو من Excel بصيغة CSV)');
  const id = newId('f');
  const sha = crypto.createHash('sha256').update(data).digest('hex');
  await ctx.db.tx(async tx => {
    await tx.query(`insert into files (id, name, mime, kind, size, sha256, data, text_content, note) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, name, mime, kind, data.length, sha, data, text, String(i.note || '').slice(0, 500)]);
    await audit(tx, 'الملفات', 'رفع ملف', name, kind === 'upload' ? null : kind === 'bank' ? 'كشف بنك' : 'أسعار شحن');
  });
  const out = (await listFiles(ctx.db)).find(f => f.id === id)!;
  if (kind === 'bank') return { ...out, imported: await importBankStatement(ctx, id) };
  if (kind === 'rates') await touchConnector(ctx, 'forwarders', `استيراد جدول أسعار: ${name}`);
  else await touchConnector(ctx, 'files', `رُفع ملف: ${name}`);
  return out;
}

export async function deleteFile(ctx: Ctx, id: string): Promise<void> {
  await ctx.db.tx(async tx => {
    const r = await tx.query('delete from files where id = $1 returning name', [id]);
    if (!r.rowCount) throw notFound('الملف غير موجود');
    await audit(tx, 'الملفات', 'حذف ملف', r.rows[0].name);
  });
}

export async function downloadFile(db: Queryable, id: string): Promise<{ name: string; mime: string; data: Buffer }> {
  const r = await db.query('select name, mime, data from files where id = $1', [id]);
  if (!r.rows[0]) throw notFound('الملف غير موجود');
  return r.rows[0];
}

/** Text of a file for an agent, bounded; binary files are described, not dumped. */
export async function fileText(db: Queryable, id: string, maxChars = 40_000): Promise<{ name: string; kind: FileKind; text: string } | null> {
  const r = await db.query('select name, kind, mime, size, text_content from files where id = $1', [id]);
  const f = r.rows[0]; if (!f) return null;
  if (f.text_content == null) return { name: f.name, kind: f.kind, text: `(ملف ${f.mime} بحجم ${Math.round(f.size / 1024)} ك.ب — لا يوجد نص مستخرج؛ اطلب من المالك نسخة CSV أو نصية)` };
  const t = f.text_content as string;
  return { name: f.name, kind: f.kind, text: t.length > maxChars ? `${t.slice(0, maxChars)}\n…(اقتُطع ${t.length - maxChars} حرفًا)` : t };
}

async function touchConnector(ctx: Ctx, tool: string, text: string): Promise<void> {
  await ctx.db.tx(async tx => {
    const r = await tx.query('select log from connectors where tool = $1', [tool]);
    const log = [{ at: Date.now(), level: 'ok', text }, ...(r.rows[0]?.log || [])].slice(0, 12);
    await tx.query('update connectors set last_sync = now(), log = $2 where tool = $1', [tool, JSON.stringify(log)]);
    const { connectorMap } = await import('./connectors.js');
    tx.emit({ type: 'connectors', connectors: await connectorMap(ctx, tx) });
  });
}

/* ---------- bank statements ---------- */

export interface BankImport { rows: number; added: number; skipped: number; cash: number | null; monthExpenses: number }

const HEAD = {
  date: /^(date|value date|posting date|transaction date|التاريخ|تاريخ العملية|تاريخ القيد|تاريخ الحركة)$/i,
  desc: /^(description|details|narrative|الوصف|البيان|التفاصيل|تفاصيل العملية)$/i,
  amount: /^(amount|المبلغ|قيمة العملية)$/i,
  debit: /^(debit|withdrawal|withdrawals|مدين|سحب|المدين|السحوبات)$/i,
  credit: /^(credit|deposit|deposits|دائن|إيداع|الدائن|الإيداعات)$/i,
  balance: /^(balance|running balance|الرصيد|الرصيد الجاري)$/i
};

/** Imports a CSV statement: dedupes lines, sets cash to the latest balance, and month expenses to this month's debits. */
export async function importBankStatement(ctx: Ctx, fileId: string): Promise<BankImport> {
  const f = await fileText(ctx.db, fileId, Number.MAX_SAFE_INTEGER);
  if (!f) throw notFound('الملف غير موجود');
  const rows = parseCsv(f.text);
  const hi = rows.findIndex(r => r.some(c => HEAD.date.test(c)));
  if (hi < 0) throw bad('لم أجد عمود التاريخ في الكشف (Date / التاريخ)');
  const head = rows[hi]!; const col = (re: RegExp) => head.findIndex(c => re.test(c));
  const c = { date: col(HEAD.date), desc: col(HEAD.desc), amount: col(HEAD.amount), debit: col(HEAD.debit), credit: col(HEAD.credit), balance: col(HEAD.balance) };
  if (c.amount < 0 && c.debit < 0 && c.credit < 0) throw bad('لم أجد أعمدة المبالغ (Amount أو Debit/Credit)');
  const lines = rows.slice(hi + 1).map((r, i) => {
    const day = parseDay(r[c.date] ?? ''); if (!day) return null;
    let amount = c.amount >= 0 ? parseMoney(r[c.amount] ?? '') : null;
    if (amount == null) { const d = parseMoney(r[c.debit] ?? '') ?? 0, cr = parseMoney(r[c.credit] ?? '') ?? 0; amount = Math.abs(cr) - Math.abs(d); }
    const balance = c.balance >= 0 ? parseMoney(r[c.balance] ?? '') : null;
    const description = (c.desc >= 0 ? r[c.desc] : '') ?? '';
    return { day, amount, balance, description: description.slice(0, 300), idx: i };
  }).filter((x): x is NonNullable<typeof x> => !!x);
  if (!lines.length) throw bad('لا توجد حركات صالحة في الكشف');

  let added = 0;
  const month = H.monthKey(Date.now());
  const res = await ctx.db.tx(async tx => {
    for (const l of lines) {
      const fp = crypto.createHash('sha256').update(`${l.day}|${l.amount}|${l.balance ?? ''}|${l.description}`).digest('hex');
      const r = await tx.query(`insert into bank_transactions (file_id, day, description, amount, balance, fingerprint) values ($1,$2,$3,$4,$5,$6) on conflict (fingerprint) do nothing`,
        [fileId, l.day, l.description, l.amount, l.balance, fp]);
      added += r.rowCount ?? 0;
    }
    // cash: the latest known balance; otherwise the previous cash moved by the newly added lines
    const lastBal = (await tx.query(`select balance from bank_transactions where balance is not null order by day desc, id desc limit 1`)).rows[0]?.balance;
    let cash: number | null = null;
    if (lastBal != null) cash = Number(lastBal);
    else if (added) {
      const s = Number((await tx.query(`select coalesce(sum(amount),0)::bigint s from bank_transactions where file_id = $1`, [fileId])).rows[0].s);
      cash = Number((await tx.query('select cash from company_state')).rows[0].cash) + s;
    }
    if (cash != null) await patchCompany(tx, { cash });
    const exp = -Number((await tx.query(`select coalesce(sum(amount),0)::bigint s from bank_transactions where amount < 0 and to_char(day,'YYYY-MM') = $1`, [month])).rows[0].s);
    // «مصروفات الشهر» (finance metric 2) comes from the bank once statements exist
    await tx.query(`insert into metrics_base (dept, v1) values ('finance', $1) on conflict (dept) do update set v1 = excluded.v1`, [exp]);
    await emitKpi(tx);
    await audit(tx, 'الملفات', 'استيراد كشف بنك', f.name, `${lines.length} حركة · ${added} جديدة`);
    return { cash, exp };
  });
  await touchConnector(ctx, 'bank', `استيراد ${f.name}: ${added} حركة جديدة`);
  ctx.refreshMetrics();
  return { rows: lines.length, added, skipped: lines.length - added, cash: res.cash, monthExpenses: res.exp };
}
