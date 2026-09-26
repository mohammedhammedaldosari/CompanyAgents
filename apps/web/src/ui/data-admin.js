/* Admin additions for the live platform: owner data (files, bank statements, manual card metrics),
   the tool-call audit trail (spec §20), and account security. Extends the ported admin console. */
import { DEPT, H, META, OPS, ACTION_LABEL } from '../core/runtime.ts';
import { ADM_TABS } from './admin.js';
import { $, E, UI, call } from './ui.js';
import { store } from './scene.js';

ADM_TABS.push(['data', 'البيانات والملفات'], ['calls', 'سجل الأدوات'], ['account', 'الحساب']);

const KIND_LABEL = { upload: 'ملف عام', bank: 'كشف بنك', rates: 'أسعار شحن' };
const CALL_LABEL = { executed: 'نُفّذ', pending_approval: 'بانتظار الموافقة', approved: 'نُفّذ بعد الموافقة', rejected: 'مرفوض', error: 'خطأ', denied: 'ممنوع', skipped: 'لم يُنفّذ' };
const CALL_CLS = { executed: '', approved: 'up', pending_approval: 'warn', rejected: 'bad', error: 'bad', denied: 'bad', skipped: 'muted' };
const kb = n => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} ك.ب` : `${(n / 1048576).toFixed(1)} م.ب`);

const X = { files: null, calls: null, loading: false, callQ: '', busy: false };

async function load(kind) {
  if (X.loading) return; X.loading = true;
  try {
    if (kind === 'data') X.files = await call('listFiles') || [];
    if (kind === 'calls') X.calls = await call('toolCalls', 200) || [];
  } finally { X.loading = false; UI.renderAdmin(true); }
}

Object.assign(UI, {
  adm_data() {
    if (X.files == null) { load('data'); return '<div class="acard"><div class="muted">جارٍ التحميل…</div></div>'; }
    const base = store.base || {};
    const manual = OPS.filter(d => (d.metrics || []).some(m => typeof m[1] === 'number'));
    const metricRows = manual.map(d => {
      const v = base[d.id] || [0, 0];
      const cell = (i) => typeof d.metrics[i][1] === 'number'
        ? `<label class="fld" style="margin:0;flex:1"><span class="h4">${E(d.metrics[i][0])}</span><input class="inp mono" type="number" step="any" id="mt-${d.id}-${i}" value="${d.id === 'finance' && i === 1 ? Math.round(v[i] / 100) : v[i]}"></label>`
        : `<div class="fld" style="margin:0;flex:1"><span class="h4">${E(d.metrics[i][0])}</span><div class="tm">يُحسب تلقائيًا</div></div>`;
      return `<div class="row" style="align-items:flex-end;gap:10px;padding:8px 0;border-bottom:1px solid var(--line)"><span style="min-width:150px;font-weight:700"><span class="dot" style="background:${META[d.id].c};display:inline-block;width:8px;height:8px;border-radius:50%;margin-inline-end:6px"></span>${E(d.name)}</span>${cell(0)}${cell(1)}<button class="pill xs" data-x="metric" data-d="${d.id}">حفظ</button></div>`;
    }).join('');
    const files = X.files.map(f => `<div class="lrow"><span class="chip">${KIND_LABEL[f.kind] || f.kind}</span><div style="flex:1;min-width:0"><div style="font-weight:700;font-size:12px">${E(f.name)}</div>
      <div class="tm">${kb(f.size)} · ${H.date(f.uploadedAt)} ${H.hm(f.uploadedAt)}${f.hasText ? '' : ' · بلا نص مستخرج'}${f.note ? ' · ' + E(f.note) : ''}</div></div>
      <a class="pill xs" href="/api/files/${f.id}/download">تنزيل</a>${f.kind === 'bank' ? `<button class="pill xs" data-x="reimport" data-id="${f.id}">إعادة الاستيراد</button>` : ''}<button class="pill xs danger" data-x="delfile" data-id="${f.id}" data-n="${E(f.name)}">حذف</button></div>`).join('');
    return `<div class="acard"><div class="ah"><h3>رفع ملف</h3><span class="muted">حتى 10 م.ب · يقرؤه الوكلاء الذين يملكون الأداة المناسبة</span></div>
      <div class="row" style="gap:8px;align-items:flex-end"><label class="fld" style="margin:0"><span class="h4">النوع</span><select class="sel" id="up-kind">
        <option value="upload">ملف عام (ملفاتك المرفوعة)</option><option value="bank">كشف بنك CSV (يحدّث النقد والمصروفات)</option><option value="rates">جدول أسعار شحن (شركات الشحن)</option></select></label>
      <label class="fld" style="margin:0;flex:1"><span class="h4">ملاحظة</span><input class="inp" id="up-note" maxlength="500" placeholder="اختياري"></label>
      <button class="pill primary" data-x="pick" ${X.busy ? 'disabled' : ''}>${X.busy ? 'جارٍ الرفع…' : 'اختيار ملف'}</button><input type="file" id="up-file" hidden></div>
      <div class="tm" style="margin-top:8px">كشف البنك: صدّره من البنك بصيغة CSV. تُقرأ الأعمدة (التاريخ، البيان، مدين، دائن، المبلغ، الرصيد) بالعربية أو الإنجليزية، وتُتجاهل الحركات المكررة.</div></div>
    <div class="acard"><div class="ah"><h3>الملفات</h3><span class="muted">${X.files.length}</span><span class="sp"></span><button class="pill xs" data-x="refresh" data-k="data">تحديث</button></div>${files || '<div class="empty">لا ملفات بعد.</div>'}</div>
    <div class="acard"><div class="ah"><h3>مقاييس البطاقات اليدوية</h3><span class="muted">القيم التي لا تأتي من موصل تُدخل هنا وتظهر على بطاقات الأقسام</span></div>${metricRows}
      <div class="tm" style="margin-top:8px">«مصروفات الشهر» بالريال، وتُحدَّث تلقائيًا من كشوف البنك عند استيرادها.</div></div>`;
  },

  adm_calls() {
    if (X.calls == null) { load('calls'); return '<div class="acard"><div class="muted">جارٍ التحميل…</div></div>'; }
    const q = X.callQ.trim();
    const rows = X.calls.filter(c => !q || c.agent.includes(q) || c.tool.includes(q) || (c.connector || '').includes(q)).map(c => {
      const at = new Date(c.at).getTime();
      return `<div class="lrow"><span class="${CALL_CLS[c.status] || ''}" style="min-width:110px;font-weight:700;font-size:11.5px">${CALL_LABEL[c.status] || c.status}</span>
        <div style="flex:1;min-width:0"><div style="font-size:12px"><b>${E(c.agent)}</b> · <span class="mono" dir="ltr">${E(c.tool)}</span>${c.connector ? ' · ' + E(c.connector) : ''}${ACTION_LABEL[c.action] ? ' · ' + E(ACTION_LABEL[c.action]) : ''}${c.value != null ? ' · <span class="mono">' + E(c.value) + '</span>' : ''}</div>
        <div class="tm">${H.rel(at)} ${H.hm(at)} · ${E(DEPT[c.dept] ? DEPT[c.dept].name : c.dept)}${c.duration_ms != null ? ` · ${c.duration_ms} م.ث` : ''}${c.approved_by ? ' · وافق: ' + E(c.approved_by) : ''}${c.error ? ' · <span class="bad">' + E(c.error) + '</span>' : ''}</div></div>
        ${c.task_id && store.tasks.get(c.task_id) ? `<button class="pill xs" data-open="${c.task_id}">المهمة</button>` : ''}</div>`;
    }).join('');
    return `<div class="acard"><div class="ah"><h3>سجل استدعاءات الأدوات</h3><span class="muted">كل أداة استدعاها وكيل: ما نُفّذ، وما انتظر موافقتك، ومن وافق</span><span class="sp"></span>
      <input class="inp" id="calls-q" placeholder="تصفية بالوكيل أو الأداة…" value="${E(X.callQ)}" style="width:220px"><button class="pill xs" data-x="refresh" data-k="calls">تحديث</button></div>${rows || '<div class="empty">لا استدعاءات بعد.</div>'}</div>`;
  },

  adm_account() {
    return `<div class="acard"><div class="ah"><h3>كلمة مرور المالك</h3><span class="muted">تغييرها يُنهي الجلسات على كل الأجهزة الأخرى</span></div>
      <div class="row" style="gap:10px;align-items:flex-end"><label class="fld" style="margin:0"><span class="h4">الحالية</span><input class="inp mono" type="password" id="pw-cur" autocomplete="current-password" dir="ltr"></label>
      <label class="fld" style="margin:0"><span class="h4">الجديدة (12 حرفًا فأكثر)</span><input class="inp mono" type="password" id="pw-new" autocomplete="new-password" dir="ltr"></label>
      <button class="pill primary" data-x="pw">تغيير</button></div></div>
      <div class="acard"><div class="ah"><h3>رموز الاستقبال</h3></div><div class="tm">لأدوات الأتمتة (n8n / Make / Zapier) تُنشأ من الخادم: <span class="mono" dir="ltr">pnpm --filter @agents/server cli token:create n8n</span>، وتصل إلى <span class="mono" dir="ltr">/api/ingest/*</span> فقط.</div></div>`;
  }
});

async function upload(file) {
  if (file.size > 10 * 1024 * 1024) { UI.toast('حجم الملف أكبر من 10 م.ب'); return; }
  const kind = $('#up-kind').value, note = $('#up-note').value.trim();
  X.busy = true; UI.renderAdmin(true);
  const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = rej; r.readAsDataURL(file); });
  const out = await call('uploadFile', { name: file.name, mime: file.type || 'application/octet-stream', kind, note, dataBase64: b64 });
  X.busy = false;
  if (out) {
    const im = out.imported;
    UI.toast(im ? `استُورد الكشف: ${im.added} حركة جديدة من ${im.rows}${im.cash != null ? ' · النقد ' + H.sar(im.cash) : ''}` : `رُفع «${out.name}»`);
    X.files = null;
  }
  UI.renderAdmin(true);
}

const el = $('#admin');
el.addEventListener('click', async e => {
  const b = e.target.closest('[data-x]'); if (!b) return;
  const k = b.dataset.x;
  if (k === 'pick') return $('#up-file').click();
  if (k === 'refresh') { if (b.dataset.k === 'data') X.files = null; else X.calls = null; return UI.renderAdmin(true); }
  if (k === 'delfile') return UI.confirm(`حذف الملف «${b.dataset.n}»؟`, async () => { await call('deleteFile', b.dataset.id); X.files = null; UI.renderAdmin(true); UI.toast('حُذف الملف'); });
  if (k === 'reimport') { const r = await call('importBank', b.dataset.id); if (r) UI.toast(`${r.added} حركة جديدة من ${r.rows}`); return; }
  if (k === 'metric') {
    const d = b.dataset.d, cur = (store.base && store.base[d]) || [0, 0];
    const val = i => { const inp = $(`#mt-${d}-${i}`); if (!inp) return cur[i]; const n = parseFloat(inp.value); return d === 'finance' && i === 1 ? Math.round(n * 100) : n; };
    const v = [val(0), val(1)]; if (v.some(x => !Number.isFinite(x))) return UI.toast('أدخل أرقامًا صالحة');
    if (await call('setMetric', d, v) !== null) { store.base = { ...(store.base || {}), [d]: v }; UI.toast('حُفظت المقاييس'); }
    return;
  }
  if (k === 'pw') {
    const cur = $('#pw-cur').value, nx = $('#pw-new').value;
    if (!cur || !nx) return UI.toast('أدخل كلمتي المرور');
    const r = await call('changePassword', cur, nx);
    if (r !== null) { $('#pw-cur').value = ''; $('#pw-new').value = ''; UI.toast('تغيّرت كلمة المرور وأُنهيت الجلسات الأخرى'); }
  }
});
el.addEventListener('change', e => { if (e.target.id === 'up-file' && e.target.files && e.target.files[0]) { upload(e.target.files[0]); e.target.value = ''; } });
el.addEventListener('input', e => { if (e.target.id === 'calls-q') { X.callQ = e.target.value; UI.renderAdmin(true); } });

export { X as dataAdminState };
