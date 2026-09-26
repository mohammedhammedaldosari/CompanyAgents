/* Tools an agent may call. Three kinds:
   - read:   no side effects outside the platform (KPI, products, tasks, the brain, calculator, read-only MCP tools)
   - action: external effect — ALWAYS evaluated by the permission gate on the server before execution (spec §20)
   - finish: submit_result ends the run
   The model never talks to an external system directly; MCP servers are called by this server. */
import type Anthropic from '@anthropic-ai/sdk';
import { H, POLICIES_REF, type ActionType, type DeptId } from '@agents/domain';
import type { Ctx } from '../context.js';
import { listProducts, listTasks, getProduct } from '../repo/rows.js';
import { act, bumpNotes, kpi } from '../services/common.js';
import { applyPriceChange, setStage } from '../services/effects.js';
import { productBrief, kpiBrief } from './prompts.js';
import { calculate } from './calc.js';
import type { McpSession } from '../connectors/mcp.js';

export interface RunEnv {
  ctx: Ctx;
  taskId: string | null;
  agent: string;
  dept: DeptId;
  signal: AbortSignal;
}

export interface AgentTool {
  name: string;
  description: string;
  input_schema: Anthropic.Tool['input_schema'];
  kind: 'read' | 'action' | 'finish';
  action?: ActionType;
  connector?: string | null;
  /** policy value: percent for price/budget, halalas for money */
  valueFrom?(input: Record<string, unknown>): number | undefined;
  /** human-readable draft shown to the owner when approval is needed */
  draft?(input: Record<string, unknown>, env: RunEnv): Promise<string> | string;
  run(input: Record<string, unknown>, env: RunEnv): Promise<string>;
}

const obj = (properties: Record<string, unknown>, required: string[] = []): Anthropic.Tool['input_schema'] =>
  ({ type: 'object', properties, required, additionalProperties: false }) as Anthropic.Tool['input_schema'];
const str = (description: string) => ({ type: 'string', description });
const numb = (description: string) => ({ type: 'number', description });
const S = (v: unknown) => String(v ?? '').trim();
const N = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : undefined; };
const json = (v: unknown) => JSON.stringify(v, null, 1);

/* ---------- read tools ---------- */

const readTools: AgentTool[] = [
  {
    name: 'company_kpi', kind: 'read', description: 'مؤشرات الشركة لليوم وأمس: المبيعات والطلبات والربح والإنفاق الإعلاني والنقد المتاح (بالريال).',
    input_schema: obj({}),
    run: async (_i, e) => json(kpiBrief(await kpi(e.ctx.db)))
  },
  {
    name: 'list_products', kind: 'read', description: 'قائمة منتجات الشركة مع المرحلة والسعر والتكلفة والهامش والمخزون وأيام التغطية. يمكن التصفية بالمرحلة.',
    input_schema: obj({ stage: { type: 'string', enum: ['research', 'sourcing', 'shipping', 'live', 'paused'], description: 'مرحلة المنتج (اختياري)' } }),
    run: async (i, e) => {
      const P = await listProducts(e.ctx.db, i.stage ? 'stage = $1' : 'true', i.stage ? [S(i.stage)] : []);
      return P.length ? json(P.map(productBrief)) : 'لا توجد منتجات مسجلة بعد.';
    }
  },
  {
    name: 'get_product', kind: 'read', description: 'تفاصيل منتج واحد بالمعرّف أو الرمز (SKU).',
    input_schema: obj({ id: str('معرّف المنتج أو رمزه SKU') }, ['id']),
    run: async (i, e) => {
      const r = await e.ctx.db.query('select id from products where id = $1 or sku = $1', [S(i.id)]);
      if (!r.rows[0]) return 'لا يوجد منتج بهذا المعرّف.';
      return json(productBrief(await getProduct(e.ctx.db, r.rows[0].id)));
    }
  },
  {
    name: 'list_tasks', kind: 'read', description: 'مهام الشركة الأخيرة (للاطلاع على العمل الجاري أو المنجز). يمكن التصفية بالقسم والحالة.',
    input_schema: obj({
      dept: { type: 'string', enum: ['exec', 'research', 'amazon', 'supply', 'marketing', 'finance', 'tech', 'personal', 'core'] },
      status: { type: 'string', enum: ['scheduled', 'progress', 'waiting', 'done', 'backlog'] },
      limit: numb('الحد الأقصى (افتراضي 20)')
    }),
    run: async (i, e) => {
      const w: string[] = [], p: unknown[] = [];
      if (i.dept) { p.push(S(i.dept)); w.push(`dept = $${p.length}`); }
      if (i.status) { p.push(S(i.status)); w.push(`status = $${p.length}`); }
      const lim = Math.min(50, Math.max(1, N(i.limit) ?? 20));
      const T = await listTasks(e.ctx.db, `${w.length ? w.join(' and ') : 'true'} order by coalesce(done_at, at, created_at) desc limit ${lim}`, p);
      return json(T.map(t => ({ العنوان: t.title, القسم: t.dept, الوكيل: t.agent, الحالة: t.status, الموعد: t.at ? H.date(t.at) + ' ' + H.hm(t.at) : null,
        النتيجة: t.result?.summary ?? null })));
    }
  },
  {
    name: 'brain_search', kind: 'read', description: 'ابحث في العقل (قاعدة معرفة الشركة) عن ملاحظات مرتبطة بكلمات.',
    input_schema: obj({ query: str('كلمات البحث') }, ['query']),
    run: async (i, e) => {
      const q = S(i.query).slice(0, 200);
      const r = await e.ctx.db.query(`select slug, title, left(body, 300) as excerpt, updated_at from notes
        where title ilike '%' || $1 || '%' or body ilike '%' || $1 || '%' or $1 = any(tags) order by updated_at desc limit 8`, [q]);
      await e.ctx.db.tx(async tx => act(tx, e.dept, e.agent, 'read', `قرأ ${r.rows[0]?.title ?? q}`, { brain: true }));
      return r.rows.length ? json(r.rows.map(x => ({ المعرف: x.slug, العنوان: x.title, مقتطف: x.excerpt }))) : 'لا ملاحظات مطابقة في العقل.';
    }
  },
  {
    name: 'brain_read', kind: 'read', description: 'اقرأ ملاحظة كاملة من العقل بمعرّفها.',
    input_schema: obj({ slug: str('معرّف الملاحظة') }, ['slug']),
    run: async (i, e) => {
      const r = await e.ctx.db.query('select title, body, tags, updated_at from notes where slug = $1', [S(i.slug)]);
      if (!r.rows[0]) return 'الملاحظة غير موجودة.';
      await e.ctx.db.tx(async tx => act(tx, e.dept, e.agent, 'read', `قرأ ${r.rows[0].title}`, { brain: true }));
      return `# ${r.rows[0].title}\n${r.rows[0].body}`;
    }
  },
  {
    name: 'brain_write', kind: 'read', description: 'احفظ أو حدّث ملاحظة في العقل (معرفة داخلية للشركة). استخدم نفس العنوان لتحديث ملاحظة قائمة.',
    input_schema: obj({ title: str('عنوان قصير'), body: str('المحتوى بصيغة Markdown'), tags: { type: 'array', items: { type: 'string' } } }, ['title', 'body']),
    run: async (i, e) => {
      const title = S(i.title).slice(0, 120); const slug = H.slug(title) || `note-${Date.now()}`;
      const tags = Array.isArray(i.tags) ? i.tags.map(S).filter(Boolean).slice(0, 10) : [];
      await e.ctx.db.tx(async tx => {
        const r = await tx.query(`insert into notes (id, slug, title, body, tags, created_by) values ($1,$2,$3,$4,$5,$6)
          on conflict (slug) do update set body = excluded.body, tags = excluded.tags, updated_at = now() returning (xmax = 0) as inserted`,
        [`n_${slug}`, slug, title, S(i.body).slice(0, 20000), tags, e.agent]);
        if (r.rows[0].inserted) await bumpNotes(tx);
        await act(tx, e.dept, e.agent, 'write', `كتب ${title}`, { brain: true });
      });
      return `حُفظت الملاحظة «${title}» (المعرف: ${slug}).`;
    }
  },
  {
    name: 'calculate', kind: 'read', description: 'حاسبة دقيقة للتعابير الحسابية (+ − × ÷ ^ % وأقواس). استخدمها لكل حساب مالي.',
    input_schema: obj({ expression: str('التعبير، مثل (79-21-79*0.18)/79*100') }, ['expression']),
    run: async i => { try { return String(calculate(S(i.expression))); } catch (err) { return `خطأ: ${(err as Error).message}`; } }
  }
];

/* ---------- gated action tools ---------- */

const productName = async (e: RunEnv, id: unknown) => {
  const r = await e.ctx.db.query('select name, sku, price, cost from products where id = $1 or sku = $1', [S(id)]);
  return r.rows[0] as { name: string; sku: string; price: number; cost: number } | undefined;
};
const resolveProductId = async (e: RunEnv, id: unknown): Promise<string | null> =>
  (await e.ctx.db.query('select id from products where id = $1 or sku = $1', [S(id)])).rows[0]?.id ?? null;
const sign = (n: number) => `${n > 0 ? '+' : ''}${n}%`;
const header = (title: string, e: RunEnv) => [title, `أعدّه: ${e.agent} · ${e.ctx.org().dept(e.dept).name}`, '────────────'];

export const ACTION_TOOLS: Record<ActionType, AgentTool | undefined> = {
  read: undefined, report: undefined, internal: undefined,
  price_change: {
    name: 'propose_price_change', kind: 'action', action: 'price_change', connector: 'sellercentral',
    description: 'تغيير سعر بيع منتج بنسبة مئوية. يخضع لصلاحيات الشركة وقد ينتظر موافقة المالك.',
    input_schema: obj({ product_id: str('معرّف المنتج أو SKU'), percent: numb('نسبة التغيير، موجبة للرفع وسالبة للخفض'), reason: str('المبرر بالأرقام') }, ['product_id', 'percent', 'reason']),
    valueFrom: i => N(i.percent),
    draft: async (i, e) => {
      const p = await productName(e, i.product_id); const v = N(i.percent) ?? 0;
      if (!p) return [...header('تغيير سعر', e), `المنتج: ${S(i.product_id)} (غير موجود)`].join('\n');
      const nw = Math.round((p.price * (1 + v / 100)) / 100) * 100;
      const m1 = p.price ? ((p.price - p.cost) / p.price) * 100 : 0, m2 = nw ? ((nw - p.cost) / nw) * 100 : 0;
      return [...header('تغيير سعر', e), `المنتج: ${p.name} (${p.sku})`, `السعر الحالي: ${H.sar(p.price)}`, `السعر المقترح: ${H.sar(nw)} (${sign(v)})`,
        `الهامش قبل: ${H.p1(m1)}%`, `الهامش بعد: ${H.p1(m2)}%`, `السبب: ${S(i.reason)}`].join('\n');
    },
    run: async (i, e) => {
      const id = await resolveProductId(e, i.product_id); if (!id) return 'فشل: المنتج غير موجود.';
      const r = await e.ctx.db.tx(tx => applyPriceChange(tx, id, N(i.percent) ?? 0));
      return `سُجّل السعر الجديد لـ${r.product.name}: ${H.sarN(r.old)} ← ${H.sarN(r.next)} ر.س في المنصة. التحديث في مركز البائع يتطلب موصل كتابة لم يُفعّل بعد؛ اذكر ذلك للمالك.`;
    }
  },
  ad_budget: {
    name: 'change_ad_budget', kind: 'action', action: 'ad_budget', connector: 'amazonads',
    description: 'تغيير الميزانية اليومية لحملة إعلانية بنسبة مئوية. يخضع لصلاحيات الشركة.',
    input_schema: obj({ campaign: str('اسم الحملة'), percent: numb('نسبة التغيير'), reason: str('المبرر') }, ['campaign', 'percent', 'reason']),
    valueFrom: i => N(i.percent),
    draft: (i, e) => [...header('تغيير ميزانية حملة', e), `الحملة: ${S(i.campaign)}`, `التغيير: ${sign(N(i.percent) ?? 0)}`, `المبرر: ${S(i.reason)}`].join('\n'),
    run: async i => `اعتُمد تغيير ميزانية «${S(i.campaign)}» بنسبة ${sign(N(i.percent) ?? 0)}. التطبيق في إعلانات أمازون يتطلب ربط الموصل؛ اذكر ذلك للمالك.`
  },
  listing_edit: {
    name: 'edit_listing', kind: 'action', action: 'listing_edit', connector: 'sellercentral',
    description: 'تعديل قائمة منتج على أمازون (العنوان، النقاط، الكلمات المفتاحية). يحتاج موافقة المالك حسب الصلاحيات.',
    input_schema: obj({ product_id: str('معرّف المنتج أو SKU'), title: str('العنوان الجديد'), bullets: { type: 'array', items: { type: 'string' } },
      keywords: { type: 'array', items: { type: 'string' } }, reason: str('المبرر') }, ['product_id', 'reason']),
    draft: async (i, e) => {
      const p = await productName(e, i.product_id);
      return [...header('تعديل قائمة', e), `القائمة: ${p?.name ?? S(i.product_id)}`, i.title ? `العنوان المقترح: ${S(i.title)}` : '',
        ...(Array.isArray(i.bullets) ? ['النقاط:', ...i.bullets.map(b => `• ${S(b)}`)] : []),
        Array.isArray(i.keywords) ? `الكلمات المفتاحية: ${i.keywords.map(S).join('، ')}` : '', `المبرر: ${S(i.reason)}`].filter(Boolean).join('\n');
    },
    run: async (i, e) => { const p = await productName(e, i.product_id); return `اعتُمد تعديل قائمة ${p?.name ?? 'المنتج'}. التطبيق في مركز البائع يتطلب موصل كتابة؛ النص محفوظ في المستند.`; }
  },
  supplier_msg: {
    name: 'message_supplier', kind: 'action', action: 'supplier_msg', connector: 'gmail',
    description: 'رسالة لمورد (عرض سعر، عينات، تفاوض). تحتاج موافقة المالك حسب الصلاحيات.',
    input_schema: obj({ supplier: str('اسم المورد أو بريده'), subject: str('الموضوع'), body: str('نص الرسالة كاملًا') }, ['supplier', 'subject', 'body']),
    draft: (i, e) => [...header('رسالة لمورد', e), `إلى: ${S(i.supplier)}`, `الموضوع: ${S(i.subject)}`, '', S(i.body)].join('\n'),
    run: async i => `اعتُمدت الرسالة إلى ${S(i.supplier)} وحُفظ نصها. الإرسال الآلي يتم عبر موصل البريد عند ربطه بصلاحية كتابة.`
  },
  external_email: {
    name: 'send_external_email', kind: 'action', action: 'external_email', connector: 'gmail',
    description: 'بريد لجهة خارجية. يحتاج موافقة المالك حسب الصلاحيات.',
    input_schema: obj({ to: str('المستلم'), subject: str('الموضوع'), body: str('النص كاملًا') }, ['to', 'subject', 'body']),
    draft: (i, e) => [...header('بريد لجهة خارجية', e), `إلى: ${S(i.to)}`, `الموضوع: ${S(i.subject)}`, '', S(i.body)].join('\n'),
    run: async i => `اعتُمد البريد إلى ${S(i.to)} وحُفظ نصه. الإرسال الآلي يتم عبر موصل البريد عند ربطه بصلاحية كتابة.`
  },
  purchase_order: {
    name: 'issue_purchase_order', kind: 'action', action: 'purchase_order', connector: null,
    description: 'إصدار أمر شراء من مورد. يحتاج موافقة المالك.',
    input_schema: obj({ supplier: str('المورد'), product_id: str('معرّف المنتج أو SKU (اختياري)'), quantity: numb('الكمية'), unit_price_sar: numb('سعر الوحدة بالريال'),
      terms: str('شروط الدفع والشحن') }, ['supplier', 'quantity', 'unit_price_sar', 'terms']),
    valueFrom: i => Math.round((N(i.quantity) ?? 0) * (N(i.unit_price_sar) ?? 0) * 100),
    draft: async (i, e) => {
      const p = i.product_id ? await productName(e, i.product_id) : undefined; const total = Math.round((N(i.quantity) ?? 0) * (N(i.unit_price_sar) ?? 0) * 100);
      return [...header('أمر شراء', e), `المورد: ${S(i.supplier)}`, `المنتج: ${p?.name ?? '—'}`, `الكمية: ${H.num(N(i.quantity) ?? 0)}`,
        `سعر الوحدة: ${H.sar2((N(i.unit_price_sar) ?? 0) * 100)}`, `القيمة: ${H.sar(total)}`, `الشروط: ${S(i.terms)}`].join('\n');
    },
    run: async (i, e) => {
      const id = i.product_id ? await resolveProductId(e, i.product_id) : null;
      if (id) await e.ctx.db.tx(async tx => { const p = await getProduct(tx, id); if (p.stage === 'sourcing') await setStage(e.ctx, tx, p, 'shipping', e.agent); });
      return `صدر أمر الشراء لدى ${S(i.supplier)} بقيمة ${H.sar(Math.round((N(i.quantity) ?? 0) * (N(i.unit_price_sar) ?? 0) * 100))}. أرسله للمورد عبر البريد.`;
    }
  },
  payment: {
    name: 'prepare_payment', kind: 'action', action: 'payment', connector: null,
    description: 'تجهيز تعليمات دفعة مالية. لا يُنفذ أي تحويل أبدًا؛ المالك ينفذه بنفسه في البنك.',
    input_schema: obj({ beneficiary: str('المستفيد'), amount_sar: numb('المبلغ بالريال'), reference: str('المرجع (رقم أمر الشراء أو الفاتورة)'), purpose: str('الغرض') },
      ['beneficiary', 'amount_sar', 'reference', 'purpose']),
    valueFrom: i => Math.round((N(i.amount_sar) ?? 0) * 100),
    draft: (i, e) => [...header('تعليمات دفع', e), `المستفيد: ${S(i.beneficiary)}`, `المبلغ: ${H.sar(Math.round((N(i.amount_sar) ?? 0) * 100))}`,
      `المرجع: ${S(i.reference)}`, `الغرض: ${S(i.purpose)}`, 'تنبيه: الوكيل لا ينفذ التحويل؛ التنفيذ منك في البنك.'].join('\n'),
    run: async i => `جُهّزت تعليمات دفع ${H.sar(Math.round((N(i.amount_sar) ?? 0) * 100))} إلى ${S(i.beneficiary)}، وتنتظر تنفيذ المالك في البنك. لم يُحوَّل أي مبلغ.`
  }
};

/** Departments that may use each action tool besides the task's own action. */
const ACTION_DEPTS: Partial<Record<ActionType, DeptId[]>> = {
  price_change: ['amazon'], listing_edit: ['amazon'], ad_budget: ['marketing'], supplier_msg: ['supply'],
  external_email: ['exec', 'supply', 'marketing'], purchase_order: ['supply'], payment: ['finance']
};

export const FINISH_TOOL: AgentTool = {
  name: 'submit_result', kind: 'finish',
  description: 'أنهِ المهمة: ملخص من سطر أو سطرين، ومستند كامل بصيغة Markdown بالنتيجة والأرقام ومصادرها.',
  input_schema: obj({ summary: str('ملخص لا يتجاوز 30 كلمة'), document: str('المستند الكامل بصيغة Markdown') }, ['summary', 'document']),
  run: async () => 'تم.'
};

/* ---------- MCP tools (each call still passes the gate) ---------- */

/** Default action type for a connector's write tools. Unknown connectors are treated as external email (always approval). */
const CONNECTOR_ACTION: Record<string, ActionType> = {
  gmail: 'external_email', gcal: 'internal', gdrive: 'internal', gsheets: 'internal', notion: 'internal', gtasks: 'internal',
  helium10: 'read', sellercentral: 'listing_edit', amazonads: 'ad_budget', alibaba: 'supplier_msg', canva: 'internal', figma: 'internal',
  replit: 'internal', base44: 'internal', github: 'internal', vercel: 'internal', postgres: 'internal'
};

export function mcpTools(connector: string, session: McpSession, scopes: 'read' | 'write'): AgentTool[] {
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');
  return session.tools
    .filter(t => t.readOnly || scopes === 'write') // read-only connectors never expose write tools
    .map(t => ({
      name: `mcp_${safe(connector)}_${safe(t.name)}`.slice(0, 64),
      description: `[${connector}] ${t.description || t.name}${t.readOnly ? '' : ' (فعل كتابة يخضع لصلاحيات الشركة)'}`.slice(0, 1024),
      input_schema: { type: 'object', ...(t.inputSchema as object) } as Anthropic.Tool['input_schema'],
      kind: t.readOnly ? 'read' as const : 'action' as const,
      action: t.readOnly ? undefined : (CONNECTOR_ACTION[connector] ?? 'external_email'),
      connector,
      draft: (i: Record<string, unknown>, e: RunEnv) => [...header(`استدعاء ${t.name} عبر ${connector}`, e), '```json', json(i), '```'].join('\n'),
      run: async (i: Record<string, unknown>, e: RunEnv) => {
        const r = await session.call(t.name, i, e.signal);
        return (r.isError ? 'خطأ من الخادم: ' : '') + `<external_data source="${connector}">\n${r.text}\n</external_data>`;
      }
    }));
}

/** Built-in tool set for an agent: read tools, the action tools its department may use (plus the task's own action), and submit_result. */
export function builtinTools(dept: DeptId, taskAction: ActionType | null, withFinish = true): AgentTool[] {
  const actions = (Object.keys(ACTION_TOOLS) as ActionType[])
    .filter(a => ACTION_TOOLS[a] && (a === taskAction || ACTION_DEPTS[a]?.includes(dept)))
    .map(a => ACTION_TOOLS[a]!);
  return [...readTools, ...actions, ...(withFinish ? [FINISH_TOOL] : [])];
}

export const READ_TOOLS = readTools;
export const policyLabel = (a: ActionType) => POLICIES_REF.find(p => p.action === a)?.label ?? a;
