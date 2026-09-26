/* Ported from the Claude Design prototype (g-admin.js); logic kept intact, wired as an ES module. */
import { ACTION_LABEL, AGENT_DEPT, CONFIG, CONN_LABEL, DEFAULT_INSTR, DEPT, DEPTS, FREQ_LABEL, H, MAX_AGENTS, META, METHOD, MODEL_COST, MODEL_LABEL, ON_CAP_LABEL, OPS, POLICIES, STAGE, STATUS_LABEL, TOOL, TOOLS, clone, diffConfig, margin, toolIcon, validateConfig } from '../core/runtime.js';
import { policyOf, prodById, store, tasksArr } from './scene.js';
import { $, E, UI, call, prefs, savePrefs, toLocalInput } from './ui.js';

/* ============ admin console (owner) ============ */
const DRAFT_KEY='agents-company-v4-draft';
const OPEN_ST=['scheduled','progress','waiting','backlog'];
const SAR_ACTIONS=['purchase_order','payment'],PCT_ACTIONS=['price_change','ad_budget'];
const ADM_TABS=[['structure','الهيكل والوكلاء'],['tasks','المهام'],['routines','الروتينات'],['policies','الصلاحيات'],['connectors','الموصلات'],['settings','الإعدادات'],['usage','التكلفة والاستهلاك'],['audit','السجل والإصدارات']];
const KNOWN_MCP={notion:'https://mcp.notion.com/mcp'};
const agentOptions=sel=>DEPTS.map(d=>`<optgroup label="${E(d.name)}">${d.agents.map(a=>`<option value="${E(a)}"${a===sel?' selected':''}>${E(a)}</option>`).join('')}</optgroup>`).join('');
const segA=(act,opts,cur,attrs)=>`<div class="seg">${opts.map(([v,l])=>`<button type="button" data-ad="${act}" data-v="${v}"${attrs||''} class="${String(cur)===String(v)?'on':''}">${l}</button>`).join('')}</div>`;
const pb=(act,label,id,cls)=>`<button class="pill xs${cls?' '+cls:''}" data-ad="${act}" data-id="${id}">${label}</button>`;
const polUnit=a=>(POLICIES.find(p=>p.action===a)||{}).unit;

Object.assign(UI,{
 adm:{tab:prefs.admTab||'structure',dept:'exec',agent:null,tq:'',td:'',ta:'',ts:'open',tn:80,rq:'',cq:'',cf:'all',open:{},aa:'',lastR:0},
 draft:null,draftBase:null,

 /* ---- draft ---- */
 loadDraft(){try{const d=JSON.parse(localStorage.getItem(DRAFT_KEY));if(d&&store.config&&d.base===store.config.version){this.draft=d.config;this.draftBase=d.base;}else localStorage.removeItem(DRAFT_KEY);}catch(e){}},
 D(){if(this.draft&&this.draftBase!==store.config.version){this.clearDraft();this.toast('نُشر إصدار أحدث؛ أُلغيت المسودة السابقة');}
  if(!this.draft){this.draft=clone(store.config);this.draftBase=store.config.version;}return this.draft;},
 saveDraft(){if(!this.draft)return;if(!this.draftChanges().length){this.clearDraft();return;}try{localStorage.setItem(DRAFT_KEY,JSON.stringify({base:this.draftBase,config:this.draft}));}catch(e){}},
 clearDraft(){this.draft=null;this.draftBase=null;try{localStorage.removeItem(DRAFT_KEY);}catch(e){}},
 draftChanges(){return this.draft&&store.config&&this.draftBase===store.config.version?diffConfig(store.config,this.draft):[];},
 draftTabs(){const s=new Set();if(!this.draftChanges().length)return s;const a=store.config,b=this.draft,J=JSON.stringify;
  if(J(a.depts)!==J(b.depts)||J(a.agents)!==J(b.agents)||b.reassign)s.add('structure');if(J(a.policies)!==J(b.policies)||J(a.overrides||[])!==J(b.overrides||[]))s.add('policies');
  if(J(a.settings)!==J(b.settings))s.add('settings');if(J(a.budget)!==J(b.budget))s.add('usage');return s;},

 /* ---- render ---- */
 renderAdmin(force){const el=$('#admin');if(!store.config)return;const now=Date.now();
  if(!force){if(this._admDown||now-this.adm.lastR<2500)return;const a=document.activeElement;if(a&&el.contains(a)&&/INPUT|TEXTAREA|SELECT/.test(a.tagName))return;}
  this.adm.lastR=now;const html=this.admHtml();if(el._h===html)return;
  const a=document.activeElement,fid=a&&el.contains(a)&&a.id?a.id:null;let pos=null;try{pos=fid?a.selectionStart:null;}catch(e){}
  const body=el.querySelector('.acontent'),st=body?body.scrollTop:0;el.innerHTML=html;el._h=html;
  const nb=el.querySelector('.acontent');if(nb)nb.scrollTop=this._resetScroll?0:st;this._resetScroll=false;
  if(fid){const n=document.getElementById(fid);if(n){n.focus();if(pos!=null)try{n.setSelectionRange(pos,pos);}catch(e){}}}},
 admHeadHtml(){const C=store.config,ch=this.draftChanges();
  return `<h2>لوحة الإدارة</h2><span class="muted">الإصدار ${C.version} · نُشر ${H.ago(C.publishedAt)}</span><span class="sp"></span>
   ${ch.length?`<span class="chip warnc">${ch.length} ${ch.length===1?'تغيير غير منشور':'تغييرات غير منشورة'}</span><button class="pill" data-ad="discard">تجاهل المسودة</button><button class="pill approve" data-ad="review">مراجعة ونشر</button>`:'<span class="chip">لا تغييرات غير منشورة</span>'}
   <button class="pill" data-close-layer>إغلاق</button>`;},
 admNavHtml(){const C=store.config,T=this.adm.tab,dt=this.draftTabs();const cs=Object.values(store.connectors),U=store.usage;
  const ct={structure:C.agents.length,tasks:tasksArr().filter(t=>OPEN_ST.includes(t.status)).length,routines:store.routines.length,
   connectors:cs.filter(c=>c.state==='connected').length+'/'+cs.length,usage:(U?Math.round(U.total/C.budget.monthlyCap*100):0)+'%',audit:'v'+C.version};
  return ADM_TABS.map(([k,l])=>`<button class="nv${T===k?' on':''}" data-ad="tab" data-v="${k}">${dt.has(k)?'<span class="ddot"></span>':''}${l}<span class="ct">${ct[k]!=null?ct[k]:''}</span></button>`).join('')+
   `<div class="anote">الهيكل والصلاحيات والإعدادات والميزانية تُحفظ كمسودة حتى تنشرها.<br>المهام والروتينات والموصلات تُطبَّق فورًا.<br>كل تغيير يُسجَّل في السجل.</div>`;},
 admHtml(){const T=this.adm.tab;const body=(this['adm_'+T]||this.adm_structure).call(this);
  return `<div class="lhead" id="admhead">${this.admHeadHtml()}</div><div class="adm"><nav class="anav" id="admnav" aria-label="أقسام الإدارة">${this.admNavHtml()}</nav><div class="acontent">${body}</div></div>`;},
 admHead(){const h=$('#admhead'),n=$('#admnav');if(!h)return;h.innerHTML=this.admHeadHtml();n.innerHTML=this.admNavHtml();$('#admin')._h='';$('#policybtn').classList.toggle('b-wait',this.draftChanges().length>0);},

 /* ---- 1. structure & agents ---- */
 adm_structure(){const D=this.D(),A=this.adm;const dd=D.depts.find(d=>d.id===A.dept)||D.depts[0];const locked=dd.id==='core',ac=META[dd.id].c;
  const pub=Object.fromEntries(store.config.agents.map(a=>[a.id,a.name]));const openBy={};tasksArr().forEach(t=>{if(OPEN_ST.includes(t.status))openBy[t.agent]=(openBy[t.agent]||0)+1;});
  const ags=D.agents.filter(a=>a.dept===dd.id).sort((a,b)=>(b.mgr?1:0)-(a.mgr?1:0));
  const list=D.depts.map(d=>`<button class="dlist${d.id===dd.id?' on':''}" data-ad="dept" data-v="${d.id}" style="--ac:${META[d.id].c}"><span class="dot"></span><span class="nm">${E(d.name)}</span>${d.enabled===false?'<span class="cst st-disabled">معطّل</span>':''}<span class="mono muted">${D.agents.filter(a=>a.dept===d.id).length}</span></button>`).join('');
  const rows=ags.map(a=>{const nm=pub[a.id];return `<div class="arow${A.agent===a.id?' on':''}"><span class="av" style="--ac:${ac}">${E(H.initials(a.name)||'؟')}</span>
   <div class="tx"><div class="tt">${a.mgr?'<span class="warn">★</span> ':''}${E(a.name||'بلا مسمى')}${a.status==='paused'?' <span class="muted">· متوقف</span>':''}${!nm?' <span class="chip">جديد</span>':''}</div>
   <div class="tm">${E(a.role||'—')}</div><div class="tm">${MODEL_LABEL[a.model]} · ${a.tools.length} أدوات · مهام مفتوحة ${nm?openBy[nm]||0:0}</div></div>
   <div class="tbtns" style="margin:0;flex:none">${pb('editagent',A.agent===a.id?'إغلاق الملف':'تعديل',a.id)}${!a.mgr&&!locked?pb('mkmgr','تعيين مديرًا',a.id)+pb('delagent','حذف',a.id,'danger'):''}</div></div>`;}).join('');
  const ed=ags.find(a=>a.id===A.agent);
  return `<div class="split"><div style="display:flex;flex-direction:column;gap:6px"><div class="h4">الأقسام</div>${list}<div class="tm" style="margin-top:6px">عدد الأقسام ثابت في هذا الإصدار: ثمانية أقسام والمركز.</div></div>
  <div style="display:flex;flex-direction:column;gap:14px;min-width:0">
   <div class="acard" style="--ac:${ac}"><div class="ah"><span class="dot"></span><h3>${E(dd.name||'—')}</h3>${locked?'<span class="muted">المركز ثابت: وكيل واحد يحفظ المعرفة</span>':''}</div>
    <div class="fgrid"><label class="fld"><span class="h4">اسم القسم</span><input class="inp" id="df-name" data-df="name" value="${E(dd.name)}" maxlength="40"${locked?' disabled':''}></label>
     <div class="fld"><span class="h4">الحالة</span>${dd.id==='exec'||locked?`<span class="tm">مفعّل دائمًا${dd.id==='exec'?' — يوجّه كل المهام':''}</span>`:segA('denable',[['on','مفعّل'],['off','معطّل مؤقتًا']],dd.enabled===false?'off':'on')}
      ${dd.enabled===false?'<span class="tm">القسم المعطّل لا يبدأ مهامًا جديدة، وتتوقف روتيناته، ولا تُوجَّه إليه المهام التلقائية.</span>':''}</div></div>
    <div class="fld"><span class="h4">أدوات القسم · ${dd.tools.length}</span><div class="toolpick">${TOOLS.map(t=>`<button type="button" class="tchip${dd.tools.includes(t.id)?' on':''}" data-ad="dtool" data-v="${t.id}"${locked?' disabled':''}><span class="ti">${toolIcon(t)}</span>${E(t.name)}</button>`).join('')}</div></div></div>
   <div class="acard"><div class="ah"><h3>الوكلاء</h3><span class="mono muted">${ags.length}/${locked?1:MAX_AGENTS}</span><span class="sp"></span>${locked?'':`<button class="pill sm primary" data-ad="addagent"${ags.length>=MAX_AGENTS?' disabled':''}>إضافة وكيل</button>`}</div>${rows}</div>
   ${ed?this.agentEditor(ed,dd,D,pub,openBy):''}</div></div>`;},
 agentEditor(a,dd,D,pub,openBy){const locked=dd.id==='core',nm=pub[a.id],U=store.usage&&nm?store.usage.byAgent[nm]:null;
  const dup=D.agents.some(x=>x.id!==a.id&&x.name.trim()===a.name.trim());
  const deptOpts=D.depts.filter(d=>d.id!=='core').map(d=>{const full=d.id!==a.dept&&D.agents.filter(x=>x.dept===d.id).length>=MAX_AGENTS;return `<option value="${d.id}"${d.id===a.dept?' selected':''}${full?' disabled':''}>${E(d.name)}${full?' (مكتمل)':''}</option>`;}).join('');
  return `<div class="acard" style="border-color:rgba(143,211,255,.5)"><div class="ah"><h3>ملف الوكيل</h3><span class="muted">${E(a.name)}</span><span class="sp"></span><button class="pill xs" data-ad="closeagent">إغلاق</button></div>
   <div class="fgrid"><label class="fld"><span class="h4">المسمى</span><input class="inp" id="af-name" data-af="name" value="${E(a.name)}" maxlength="40">${dup?'<span class="ferr">المسمى مستخدم لوكيل آخر</span>':''}</label>
    <label class="fld"><span class="h4">القسم</span><select class="sel" id="af-dept" data-af="dept"${a.mgr||locked?' disabled':''}>${locked?`<option>${E(dd.name)}</option>`:deptOpts}</select>${a.mgr&&!locked?'<span class="tm">عيّن مديرًا آخر قبل نقل المدير.</span>':''}</label></div>
   <label class="fld"><span class="h4">الدور</span><input class="inp" id="af-role" data-af="role" value="${E(a.role||'')}" maxlength="160"></label>
   <label class="fld"><span class="h4">التعليمات الدائمة</span><textarea class="inp code" id="af-instr" data-af="instructions" rows="6">${E(a.instructions||'')}</textarea><span class="tm">يقرؤها الوكيل قبل كل مهمة. لا تضع فيها مفاتيح أو كلمات مرور.</span></label>
   <div class="fgrid"><div class="fld"><span class="h4">النموذج الافتراضي</span>${segA('amodel',[['HAIKU','هايكو'],['SONNET','سونيت'],['OPUS','أوبس']],a.model)}</div>
    <div class="fld"><span class="h4">الحالة</span>${locked?'<span class="tm">يعمل دائمًا</span>':segA('astatus',[['active','نشط'],['paused','متوقف']],a.status)}</div></div>
   <div class="fld"><span class="h4">الأدوات المسموحة · من أدوات القسم</span><div class="toolpick">${dd.tools.map(id=>TOOL[id]).filter(Boolean).map(t=>`<button type="button" class="tchip${a.tools.includes(t.id)?' on':''}" data-ad="atool" data-v="${t.id}"><span class="ti">${toolIcon(t)}</span>${E(t.name)}</button>`).join('')||'<span class="tm">لا أدوات في القسم.</span>'}</div></div>
   <dl class="kv"><dt>مهام مفتوحة</dt><dd class="mono">${nm?openBy[nm]||0:0}</dd><dt>منجز هذا الشهر</dt><dd class="mono">${U?U.tasks:0}</dd><dt>تكلفة الشهر</dt><dd>${H.sar2(U?U.cost:0)}</dd></dl></div>`;},
 openDelAgent(id){const D=this.D(),a=D.agents.find(x=>x.id===id);if(!a)return;const pubName=(store.config.agents.find(x=>x.id===id)||{}).name;
  const n=pubName?tasksArr().filter(t=>t.agent===pubName&&OPEN_ST.includes(t.status)).length:0;
  const others=D.agents.filter(x=>x.id!==id&&x.dept!=='core');const def=D.agents.find(x=>x.dept===a.dept&&x.mgr)||others[0];
  this.openModal(`<h2>حذف «${E(a.name)}»</h2><div class="sub">يُحذف الوكيل عند نشر الإصدار التالي. سجل مهامه المنجزة يبقى كما هو.</div>
   ${n?`<div class="fld"><span class="h4">إسناد مهامه المفتوحة (${n}) إلى</span><select class="sel" id="del-to">${others.map(x=>`<option value="${x.id}"${def&&x.id===def.id?' selected':''}>${E(x.name)} · ${E((D.depts.find(d=>d.id===x.dept)||{}).name||'')}</option>`).join('')}</select></div>`:'<div class="tm" style="margin-top:10px">لا مهام مفتوحة لهذا الوكيل.</div>'}
   <div class="acts"><button class="pill danger" data-primary id="del-ok">حذف من المسودة</button><button class="pill" data-m="close">إلغاء</button></div>`,{kind:'del'});
  $('#del-ok').addEventListener('click',()=>{const to=$('#del-to')?$('#del-to').value:(def&&def.id);D.agents=D.agents.filter(x=>x.id!==id);if(pubName){D.reassign=D.reassign||{};D.reassign[id]=to;}
   D.overrides=(D.overrides||[]).filter(o=>!(o.scope==='agent'&&o.target===id));if(this.adm.agent===id)this.adm.agent=null;this.saveDraft();this.closeModal();this.renderAdmin(true);this.render();this.toast('حُذف من المسودة؛ انشر لتطبيق الحذف');});},

 /* ---- 2. tasks ---- */
 adm_tasks(){const A=this.adm;const all=tasksArr().filter(t=>t.status!=='cancelled');const cnt={open:0};
  all.forEach(t=>{cnt[t.status]=(cnt[t.status]||0)+1;if(OPEN_ST.includes(t.status))cnt.open++;});
  let T=all.filter(t=>A.ts==='open'?OPEN_ST.includes(t.status):t.status===A.ts);if(A.td)T=T.filter(t=>t.dept===A.td);if(A.ta)T=T.filter(t=>t.agent===A.ta);
  const q=A.tq.trim();if(q)T=T.filter(t=>t.title.includes(q)||t.agent.includes(q));
  const ord={waiting:0,progress:1,scheduled:2,backlog:3,done:4};T.sort((a,b)=>ord[a.status]-ord[b.status]||(a.status==='done'?b.doneAt-a.doneAt:(a.at||9e15)-(b.at||9e15)));
  const badge=t=>t.status==='progress'?`<span class="tb p">${Math.round(t.progress)}%</span>`:t.status==='waiting'?'<span class="tb w">انتظار</span>':t.status==='done'?'<span class="tb d">منجز</span>':t.status==='backlog'?'<span class="tb b">مؤجل</span>':'<span class="tb b">مجدول</span>';
  const when=t=>t.status==='done'?`${H.rel(t.doneAt)} ${H.hm(t.doneAt)}`:t.at?`${H.rel(t.at)} ${H.hm(t.at)}`:'—';
  const rows=T.slice(0,A.tn).map(t=>{const p=t.productId&&prodById(t.productId),op=OPEN_ST.includes(t.status);return `<tr><td><button class="lnk" data-open="${t.id}">${E(t.title)}</button>${p?`<div class="tm">المنتج: <a data-prod="${p.id}">${E(p.name)}</a></div>`:''}</td>
   <td><span class="ddt" style="--ac:${META[t.dept].c}"></span>${E(DEPT[t.dept].name)}<div class="tm">${E(t.agent)}</div></td><td>${badge(t)}</td><td class="mono" style="font-size:11px">${when(t)}</td><td>${MODEL_LABEL[t.model]||''}</td>
   <td><div class="tbtns" style="margin:0;justify-content:flex-end">${op?pb('tedit','تعديل',t.id)+pb('tcancel','إلغاء',t.id,'danger'):`<button class="pill xs" data-open="${t.id}">عرض</button>`}</div></td></tr>`;}).join('');
  return `<div class="acard"><div class="ah"><h3>المهام</h3><span class="muted">${T.length} نتيجة</span></div>
   <div class="row"><input class="inp" id="adm-tq" placeholder="ابحث بالعنوان أو الوكيل…" value="${E(A.tq)}" style="flex:1;min-width:180px">
    <select class="sel" id="adm-td"><option value="">كل الأقسام</option>${DEPTS.map(d=>`<option value="${d.id}"${A.td===d.id?' selected':''}>${E(d.name)}</option>`).join('')}</select>
    <select class="sel" id="adm-ta"><option value="">كل الوكلاء</option>${agentOptions(A.ta)}</select></div>
   <div class="row">${[['open','المفتوحة'],['waiting','بانتظار الموافقة'],['progress','قيد التنفيذ'],['scheduled','مجدولة'],['backlog','مؤجلة'],['done','منجزة']].map(([k,l])=>`<button class="chip${A.ts===k?' on':''}" data-ad="ts" data-v="${k}">${l} <b>${cnt[k]||0}</b></button>`).join('')}</div>
   <table class="atable"><thead><tr><th>المهمة</th><th>القسم · الوكيل</th><th>الحالة</th><th>الموعد</th><th>النموذج</th><th></th></tr></thead><tbody>${rows||'<tr><td colspan="6"><div class="empty">لا مهام مطابقة.</div></td></tr>'}</tbody></table>
   ${T.length>A.tn?`<button class="pill sm more" data-ad="tmore">عرض ${Math.min(80,T.length-A.tn)} أخرى من ${T.length}</button>`:''}</div>
  <div class="acard"><div class="ah"><h3>إعادة إسناد جماعي</h3><span class="muted">ينقل كل المهام المفتوحة من وكيل إلى آخر</span></div>
   <div class="row"><span class="lbl">من</span><select class="sel" id="bfrom">${agentOptions(A.ta||DEPT.amazon.agents[1])}</select><span class="lbl">إلى</span><select class="sel" id="bto">${agentOptions(DEPT.amazon.agents[0])}</select><button class="pill sm primary" data-ad="bulk">إسناد المهام المفتوحة</button></div></div>`;},
 openTaskEdit(id){const t=store.tasks.get(id);if(!t)return;const unit=a=>SAR_ACTIONS.includes(a)?'ر.س':PCT_ACTIONS.includes(a)?'%':'';
  const v0=t.value==null?'':SAR_ACTIONS.includes(t.action)?t.value/100:t.value,canTime=t.status==='scheduled'||t.status==='backlog';
  this.openModal(`<h2>تعديل مهمة</h2><div class="sub">${STATUS_LABEL[t.status]} · ${E(DEPT[t.dept].name)}${t.status==='progress'?' · التعديل لا يوقف التنفيذ':''}</div>
   <div class="fld"><span class="h4">العنوان</span><input class="inp" id="te-title" value="${E(t.title)}" maxlength="140"></div>
   <div class="fgrid" style="margin-top:10px"><div class="fld" style="margin:0"><span class="h4">الوكيل المسؤول</span><select class="sel" id="te-agent">${agentOptions(t.agent)}</select></div>
    <div class="fld" style="margin:0"><span class="h4">النموذج</span>${segA('temodel',[['HAIKU','هايكو'],['SONNET','سونيت'],['OPUS','أوبس']],t.model)}</div></div>
   <div class="fgrid" style="margin-top:10px"><div class="fld" style="margin:0"><span class="h4">نوع الفعل</span><select class="sel" id="te-action">${POLICIES.map(p=>`<option value="${p.action}"${p.action===t.action?' selected':''}>${E(p.label)}</option>`).join('')}</select></div>
    <div class="fld" style="margin:0"><span class="h4">القيمة <span id="te-unit" class="muted">${unit(t.action)}</span></span><input class="inp mono" type="number" id="te-value" value="${v0}" step="any"></div></div>
   <div class="fgrid" style="margin-top:10px"><div class="fld" style="margin:0"><span class="h4">المنتج</span><select class="sel" id="te-prod"><option value="">بلا</option>${store.products.map(p=>`<option value="${p.id}"${p.id===t.productId?' selected':''}>${E(p.name)}</option>`).join('')}</select></div>
    ${canTime?`<div class="fld" style="margin:0"><span class="h4">الموعد</span><input type="datetime-local" class="inp" id="te-at" value="${t.at?toLocalInput(new Date(t.at)):''}"></div>`:''}</div>
   <div class="tm" style="margin-top:10px">تُعاد مراجعة حاجة المهمة للموافقة حسب الصلاحيات بعد الحفظ.</div>
   <div class="acts"><button class="pill primary" data-primary id="te-save">حفظ</button><button class="pill" data-m="close">إلغاء</button></div>`,{kind:'te'});
  const box=$('#modal .box');box.addEventListener('click',e=>{const b=e.target.closest('[data-ad="temodel"]');if(b)box.querySelectorAll('[data-ad="temodel"]').forEach(x=>x.classList.toggle('on',x===b));});
  $('#te-action').addEventListener('change',e=>{$('#te-unit').textContent=unit(e.target.value);});
  $('#te-save').addEventListener('click',async()=>{const act=$('#te-action').value,raw=$('#te-value').value;
   const p={title:$('#te-title').value,agent:$('#te-agent').value,model:(box.querySelector('[data-ad="temodel"].on')||{dataset:{}}).dataset.v,action:act,productId:$('#te-prod').value||null,
    value:raw===''?null:SAR_ACTIONS.includes(act)?Math.round(parseFloat(raw)*100):parseFloat(raw)};
   if($('#te-at')&&$('#te-at').value)p.at=new Date($('#te-at').value).getTime();
   const r=await call('updateTask',id,p);if(r){this.closeModal();this.toast('حُفظت المهمة');this.renderAdmin(true);}});},

 /* ---- 3. routines ---- */
 adm_routines(){const q=this.adm.rq.trim(),now=Date.now(),all=tasksArr();let R=store.routines.slice();if(q)R=R.filter(r=>r.title.includes(q)||r.agent.includes(q));
  const next=r=>{if(r.paused)return '<span class="warn">متوقف</span>';if(DEPT[r.dept]&&DEPT[r.dept].enabled===false)return '<span class="muted">القسم معطّل</span>';
   const n=all.filter(t=>t.routine===r.id&&t.status==='scheduled'&&t.at>now).sort((a,b)=>a.at-b.at)[0];return n?`${H.rel(n.at)} ${H.hm(n.at)}`:'—';};
  const last=r=>{const d=all.filter(t=>t.routine===r.id&&t.status==='done').sort((a,b)=>b.doneAt-a.doneAt)[0];return d?H.ago(d.doneAt):'—';};
  const rows=R.map(r=>{const p=policyOf(r.action);return `<tr><td><b>${E(r.title)}</b>${p&&p.mode!=='auto'?'<div class="tm warn">قد يحتاج موافقتك</div>':''}</td>
   <td><span class="ddt" style="--ac:${META[r.dept].c}"></span>${E(DEPT[r.dept].name)}<div class="tm">${E(r.agent)}</div></td><td>${FREQ_LABEL(r)}</td><td class="mono">${r.time}</td><td>${E(ACTION_LABEL[r.action]||'')}</td>
   <td>${next(r)}<div class="tm">آخر تشغيل ${last(r)}</div></td>
   <td><div class="tbtns" style="margin:0;justify-content:flex-end">${pb('redit','تعديل',r.id)}${pb('rrun','تشغيل الآن',r.id)}${pb('rtoggle',r.paused?'استئناف':'إيقاف',r.id)}${pb('rdel','حذف',r.id,'danger')}</div></td></tr>`;}).join('');
  return `<div class="acard"><div class="ah"><h3>الروتينات</h3><span class="muted">${store.routines.length} روتينًا · ${store.routines.filter(r=>r.paused).length} متوقف</span><span class="sp"></span>
    <input class="inp" id="adm-rq" placeholder="ابحث…" value="${E(this.adm.rq)}" style="width:200px"><button class="pill sm primary" data-ad="rnew">روتين جديد</button></div>
   <table class="atable"><thead><tr><th>الروتين</th><th>القسم · الوكيل</th><th>التكرار</th><th>الوقت</th><th>الفعل</th><th>التشغيل التالي</th><th></th></tr></thead><tbody>${rows||'<tr><td colspan="7"><div class="empty">لا روتينات مطابقة.</div></td></tr>'}</tbody></table></div>`;},
 openRoutineEdit(id){const r=id?store.routines.find(x=>x.id===id):null;const v=r||{title:'',agent:DEPT.exec.agents[0],freq:'workdays',time:'09:00',action:'report',dow:new Date().getDay()};
  this.openModal(`<h2>${r?'تعديل روتين':'روتين جديد'}</h2><div class="sub">تُعاد جدولة التشغيلات القادمة فور الحفظ.</div>
   <div class="fld"><span class="h4">العنوان</span><input class="inp" id="re-title" value="${E(v.title)}" maxlength="120"></div>
   <div class="fgrid" style="margin-top:10px"><div class="fld" style="margin:0"><span class="h4">الوكيل المسؤول</span><select class="sel" id="re-agent">${agentOptions(v.agent)}</select></div>
    <div class="fld" style="margin:0"><span class="h4">نوع الفعل</span><select class="sel" id="re-action">${POLICIES.map(p=>`<option value="${p.action}"${p.action===v.action?' selected':''}>${E(p.label)}</option>`).join('')}</select></div></div>
   <div class="fgrid" style="margin-top:10px"><div class="fld" style="margin:0"><span class="h4">التكرار</span><select class="sel" id="re-freq">${[['daily','كل يوم'],['workdays','أيام العمل'],['weekly','كل أسبوع'],['monthly1','أول كل شهر']].map(([k,l])=>`<option value="${k}"${k===v.freq?' selected':''}>${l}</option>`).join('')}</select></div>
    <div class="fld" style="margin:0" id="re-dowf"${v.freq==='weekly'?'':' hidden'}><span class="h4">اليوم</span><select class="sel" id="re-dow">${H.DAYS.map((d,i)=>`<option value="${i}"${i===(v.dow||0)?' selected':''}>${d}</option>`).join('')}</select></div>
    <div class="fld" style="margin:0"><span class="h4">الوقت</span><input type="time" class="inp mono" id="re-time" value="${v.time}"></div></div>
   <div class="acts"><button class="pill primary" data-primary id="re-save">${r?'حفظ':'إنشاء'}</button><button class="pill" data-m="close">إلغاء</button></div>`,{kind:'re'});
  $('#re-freq').addEventListener('change',e=>{$('#re-dowf').hidden=e.target.value!=='weekly';});
  $('#re-save').addEventListener('click',async()=>{const title=$('#re-title').value.trim();if(!title){this.toast('اكتب عنوان الروتين');return;}const agent=$('#re-agent').value;
   const p={title,agent,dept:AGENT_DEPT[agent],freq:$('#re-freq').value,dow:+$('#re-dow').value,time:$('#re-time').value||'09:00',action:$('#re-action').value};
   const res=r?await call('updateRoutine',r.id,p):await call('createRoutine',p);if(res!==null){this.closeModal();this.toast(r?'حُفظ الروتين وأُعيدت جدولته':'أُنشئ الروتين');this.renderAdmin(true);}});},

 /* ---- 4. policies (draft) ---- */
 adm_policies(){const D=this.D(),P=D.policies,O=D.overrides=D.overrides||[];
  const modes=p=>p.unit?[['auto','تلقائي'],['limit','بحد'],['always','دائمًا بموافقتي']]:[['auto','تلقائي'],['always','دائمًا بموافقتي']];
  const lim=(p,attr,i)=>p.mode==='limit'?`<div class="row" style="flex-wrap:nowrap"><input class="inp mono" type="number" min="0" step="any" id="${attr}-${i}" data-${attr}="${i}" value="${p.limit!=null?p.limit:''}" style="width:100px"><span class="muted">${p.unit==='SAR'?'ر.س':'%'}</span></div>`:'<span class="muted">—</span>';
  const g=P.map((p,i)=>`<tr><td><b>${E(p.label)}</b></td><td>${p.locked?'<span class="warn">دائمًا بموافقتي 🔒</span>':segA('pmode',modes(p),p.mode,` data-i="${i}"`)}</td><td>${p.locked?'<span class="tm">الوكلاء يجهّزون الدفعات ولا ينفذونها</span>':lim(p,'pl',i)}</td></tr>`).join('');
  const tgt=(o,i)=>o.scope==='dept'?`<select class="sel" data-ov="target" data-i="${i}">${D.depts.filter(d=>d.id!=='core').map(d=>`<option value="${d.id}"${o.target===d.id?' selected':''}>${E(d.name)}</option>`).join('')}</select>`
   :`<select class="sel" data-ov="target" data-i="${i}">${D.depts.map(d=>`<optgroup label="${E(d.name)}">${D.agents.filter(a=>a.dept===d.id).map(a=>`<option value="${a.id}"${o.target===a.id?' selected':''}>${E(a.name)}</option>`).join('')}</optgroup>`).join('')}</select>`;
  const ov=O.map((o,i)=>{const p=Object.assign({},o,{unit:polUnit(o.action)});return `<tr><td><select class="sel" data-ov="scope" data-i="${i}"><option value="dept"${o.scope==='dept'?' selected':''}>قسم</option><option value="agent"${o.scope==='agent'?' selected':''}>وكيل</option></select></td>
   <td>${tgt(o,i)}</td><td><select class="sel" data-ov="action" data-i="${i}">${POLICIES.filter(x=>!x.locked).map(x=>`<option value="${x.action}"${x.action===o.action?' selected':''}>${E(x.label)}</option>`).join('')}</select></td>
   <td>${segA('ovmode',modes(p),o.mode,` data-i="${i}"`)}</td><td>${lim(p,'ovl',i)}</td><td>${pb('ovdel','حذف','','danger').replace('data-id=""',`data-i="${i}"`)}</td></tr>`;}).join('');
  return `<div class="acard"><div class="ah"><h3>القواعد العامة</h3><span class="muted">متى يحتاج الفعل موافقتك</span></div>
   <table class="atable"><thead><tr><th>الفعل</th><th>الوضع</th><th>الحد</th></tr></thead><tbody>${g}</tbody></table></div>
  <div class="acard"><div class="ah"><h3>استثناءات لقسم أو وكيل</h3><span class="sp"></span><button class="pill sm" data-ad="ovadd">إضافة استثناء</button></div>
   <div class="tm">الأولوية: استثناء الوكيل، ثم استثناء القسم، ثم القاعدة العامة. الدفعات المالية لا تقبل استثناء.</div>
   ${O.length?`<table class="atable"><thead><tr><th>النطاق</th><th>الجهة</th><th>الفعل</th><th>الوضع</th><th>الحد</th><th></th></tr></thead><tbody>${ov}</tbody></table>`:'<div class="empty">لا استثناءات. كل الأقسام تتبع القواعد العامة.</div>'}</div>`;},

 /* ---- 5. connectors ---- */
 adm_connectors(){const A=this.adm,CS=store.connectors,st=id=>(CS[id]||{}).state||'simulated';const counts={all:TOOLS.length};TOOLS.forEach(t=>{const s=st(t.id);counts[s]=(counts[s]||0)+1;});
  let list=TOOLS.slice();if(A.cf!=='all')list=list.filter(t=>st(t.id)===A.cf);const q=A.cq.trim();if(q)list=list.filter(t=>t.name.includes(q)||(t.dom||'').includes(q));
  const card=t=>{const c=CS[t.id]||{},s=st(t.id),u=OPS.filter(d=>d.tools.includes(t.id)).map(d=>d.name),ro=t.m==='import'||t.m==='manual',open=A.open[t.id],B=[];
   if(s==='disabled')B.push(pb('cenable','تفعيل',t.id));
   else if(s!=='connecting'){if(s==='connected')B.push(pb('ctest','اختبار',t.id),pb('csync','مزامنة',t.id),pb('cconn','إعادة الربط',t.id),pb('cdis','فصل',t.id,'danger'));else B.push(pb('cconn',ro?'تفعيل الاستيراد':'ربط',t.id,'primary'),pb('ctest','اختبار',t.id));B.push(pb('cdisable','تعطيل',t.id));}
   if(t.custom)B.push(pb('cremove','حذف',t.id,'danger'));B.push(pb('clog',open?'إخفاء السجل':'السجل',t.id));
   return `<div class="ccard"><div class="cico">${toolIcon(t)}</div><div style="min-width:0;display:flex;flex-direction:column;gap:4px">
    <div class="row" style="gap:8px"><b style="font-size:13px">${E(t.name)}</b><span class="cst st-${s}">${CONN_LABEL[s]||s}</span><span class="chip">${METHOD[t.m]}</span>${t.custom?'<span class="chip">مخصص</span>':''}</div>
    <div class="tm mono" dir="ltr" style="text-align:right">${E(t.dom||'—')}${c.url?' · '+E(c.url):''}</div>
    <div class="tm">تستخدمه: ${u.length?E(u.join('، ')):'لا أقسام'} · المرحلة ${t.phase}${c.lastSync?' · آخر مزامنة '+H.ago(c.lastSync):''}${c.latency?' · '+c.latency+' مللي ثانية':''}${c.hasSecret?' · مفتاح ••••'+E(c.last4):''}</div>
    ${c.lastError?`<div class="tm bad">${E(c.lastError)}</div>`:''}
    ${open?`<div class="clog">${(c.log||[]).map(l=>`<div><span class="${l.level}">●</span> ${H.hm(l.at)} ${E(l.text)}</div>`).join('')||'<div>لا سجل بعد.</div>'}</div>`:''}</div>
    <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end">${ro?'<span class="tm">قراءة فقط</span>':segA('cscope',[['read','قراءة'],['write','قراءة وكتابة']],c.scopes,` data-id="${t.id}"`)}<div class="tbtns" style="margin:0;justify-content:flex-end">${B.join('')}</div></div></div>`;};
  const grp=(title,arr)=>arr.length?`<div class="acard"><div class="ah"><h3>${title}</h3><span class="mono muted">${arr.length}</span></div>${arr.map(card).join('')}</div>`:'';
  return `${CONFIG.mode==='sim'?'<div class="banner">وضع المحاكاة: الربط هنا تجريبي ولا تُرسل بيانات لأي خدمة، ولا يُحفظ أي مفتاح. في الوضع المتصل يتم التفويض والحفظ في الخادم فقط، ولا تصل المفاتيح للمتصفح.</div>':''}
   <div class="row"><input class="inp" id="adm-cq" placeholder="ابحث بالاسم أو النطاق…" value="${E(A.cq)}" style="width:220px">
    ${[['all','الكل'],['connected','متصل'],['needs_auth','يحتاج تفويضًا'],['simulated','محاكاة'],['disabled','معطّل']].map(([k,l])=>`<button class="chip${A.cf===k?' on':''}" data-ad="cf" data-v="${k}">${l} <b>${counts[k]||0}</b></button>`).join('')}
    <span class="sp"></span><button class="pill sm primary" data-ad="cadd">إضافة موصل</button></div>
   ${grp('الأساسية · المرحلة 2',list.filter(t=>t.core))}${grp('الإضافية · المرحلة 3',list.filter(t=>!t.core&&!t.custom))}${grp('موصلات مخصصة',list.filter(t=>t.custom))}
   ${list.length?'':'<div class="empty">لا موصلات مطابقة.</div>'}`;},
 openConnect(id){const t=TOOL[id],c=store.connectors[id]||{};const mcp=t.m==='mcp',ro=t.m==='import'||t.m==='manual';let auth=CONFIG.mode==='live'?'key':(c.auth&&c.auth!=='none'?c.auth:(mcp?'oauth':'key'));
  const html=()=>`<h2>${ro?'تفعيل':'ربط'} ${E(t.name)}</h2><div class="sub">${METHOD[t.m]} · المرحلة ${t.phase}${t.dom?' · <span class="mono" dir="ltr">'+E(t.dom)+'</span>':''}</div>
   ${CONFIG.mode==='sim'?'<div class="banner" style="margin-top:12px">محاكاة: لن يُرسل شيء لأي خدمة، ولن يُحفظ المفتاح؛ تُعرض آخر 4 خانات فقط.</div>':'<div class="banner" style="margin-top:12px">يُشفَّر المفتاح في خزنة الخادم ولا يعود للمتصفح. بعد الربط يُجرى اختبار اتصال حقيقي. التفويض عبر OAuth يأتي في تحديث لاحق.</div>'}
   ${ro?'<div class="tm" style="margin-top:12px">هذه الأداة تعمل بالاستيراد أو الإدخال اليدوي. التفعيل يجعلها متاحة للوكلاء بصلاحية قراءة.</div>':`
   ${mcp?`<div class="fld"><span class="h4">رابط خادم MCP</span><input class="inp mono" id="cn-url" dir="ltr" placeholder="https://…/mcp" value="${E(c.url||KNOWN_MCP[id]||'')}"></div>`:''}
   <div class="fld"><span class="h4">طريقة التفويض</span>${segA('cnauth',[['oauth','تفويض OAuth'],['key','مفتاح API']],auth)}</div>
   ${auth==='key'?`<div class="fld"><span class="h4">${id==='sellercentral'?'رمز التحديث من مركز البائع (Refresh token)':mcp?'رمز الوصول (Bearer token)':'المفتاح'}</span><input class="inp mono" id="cn-secret" type="password" autocomplete="off" dir="ltr" placeholder="${c.hasSecret?'•••• '+E(c.last4)+' — اتركه فارغًا للإبقاء':'الصق المفتاح هنا'}"></div>`:'<div class="tm" style="margin-top:8px">ستفتح نافذة تسجيل الدخول لدى الخدمة، ثم تعود إلى هنا تلقائيًا.</div>'}
   <div class="fld"><span class="h4">صلاحيات الوكلاء على هذه الأداة</span>${segA('cnscope',[['read','قراءة فقط'],['write','قراءة وكتابة']],c.scopes||'write')}</div>`}
   <div class="acts"><button class="pill primary" data-primary id="cn-ok">${ro?'تفعيل':'ربط'}</button><button class="pill" data-m="close">إلغاء</button></div>`;
  this.openModal(html(),{kind:'cn'});let scopes=c.scopes||'write';
  const bind=()=>{const box=$('#modal .box');box.querySelectorAll('[data-ad="cnauth"]').forEach(b=>b.addEventListener('click',()=>{auth=b.dataset.v;const u=$('#cn-url')?$('#cn-url').value:null;box.innerHTML=html();if(u!=null&&$('#cn-url'))$('#cn-url').value=u;bind();}));
   box.querySelectorAll('[data-ad="cnscope"]').forEach(b=>b.addEventListener('click',()=>{scopes=b.dataset.v;box.querySelectorAll('[data-ad="cnscope"]').forEach(x=>x.classList.toggle('on',x===b));}));
   $('#cn-ok').addEventListener('click',async e=>{const ok=e.currentTarget;const p=ro?{auth:'none',scopes:'read'}:{url:$('#cn-url')?$('#cn-url').value.trim():undefined,auth,scopes};
    const sec=$('#cn-secret');if(sec&&sec.value.trim()){p.secret=sec.value.trim();sec.value='';}if(!ro&&auth==='key'&&!p.secret&&!c.hasSecret){this.toast('الصق المفتاح أو اختر تفويض OAuth');return;}
    ok.disabled=true;ok.textContent='جارٍ الربط…';const r=await call('connectorAction',id,'connect',p);if(r){this.closeModal();this.toast(`${ro?'فُعّل':'رُبط'} ${t.name}`);this.renderAdmin(true);}else{ok.disabled=false;ok.textContent='ربط';}});};
  bind();},
 openAddConnector(){this.openModal(`<h2>إضافة موصل</h2><div class="sub">لخدمة غير موجودة في القائمة. يظهر للأقسام التي تختارها ويحتاج ربطًا بعد الإضافة.</div>
   <div class="fgrid" style="margin-top:12px"><div class="fld" style="margin:0"><span class="h4">الاسم</span><input class="inp" id="ac-name" maxlength="40"></div>
    <div class="fld" style="margin:0"><span class="h4">النطاق</span><input class="inp mono" id="ac-dom" dir="ltr" placeholder="example.com"></div></div>
   <div class="fgrid" style="margin-top:10px"><div class="fld" style="margin:0"><span class="h4">طريقة الربط</span><select class="sel" id="ac-m">${Object.entries(METHOD).map(([k,l])=>`<option value="${k}">${l}</option>`).join('')}</select></div>
    <div class="fld" style="margin:0"><span class="h4">رابط خادم MCP (اختياري)</span><input class="inp mono" id="ac-url" dir="ltr" placeholder="https://…/mcp"></div></div>
   <div class="fld"><span class="h4">الأقسام التي تستخدمه</span><div class="toolpick" id="ac-depts">${OPS.map(d=>`<button type="button" class="tchip" data-d="${d.id}" style="padding:3px 10px">${E(d.name)}</button>`).join('')}</div></div>
   <div class="acts"><button class="pill primary" data-primary id="ac-ok">إضافة</button><button class="pill" data-m="close">إلغاء</button></div>`,{kind:'ac'});
  $('#ac-depts').addEventListener('click',e=>{const b=e.target.closest('[data-d]');if(b)b.classList.toggle('on');});
  $('#ac-ok').addEventListener('click',async()=>{const depts=[...document.querySelectorAll('#ac-depts .on')].map(b=>b.dataset.d);
   const t=await call('addConnector',{name:$('#ac-name').value,domain:$('#ac-dom').value,method:$('#ac-m').value,url:$('#ac-url').value.trim(),depts});
   if(t){if(this.draft){this.draft.customTools=clone(store.config.customTools);depts.forEach(d=>{const x=this.draft.depts.find(y=>y.id===d);if(x&&!x.tools.includes(t.id))x.tools.push(t.id);});this.saveDraft();}
    this.closeModal();this.toast('أُضيف الموصل؛ اربطه ليصبح متاحًا');this.renderAdmin(true);}});},

 /* ---- 6. settings (draft) ---- */
 adm_settings(){const S=this.D().settings;const num=(k,label,unit,min,max)=>`<label class="fld"><span class="h4">${label}</span><div class="row" style="flex-wrap:nowrap"><input class="inp mono" type="number" id="sf-${k}" data-sf="${k}" value="${S[k]}" min="${min}" max="${max}" style="width:110px"><span class="muted">${unit}</span></div></label>`;
  const stg=k=>`<label class="fld"><span class="h4">حد مرحلة ${STAGE[k].name}</span><div class="row" style="flex-wrap:nowrap"><input class="inp mono" type="number" id="sl-${k}" data-sl="${k}" value="${(S.stageLimits||{})[k]}" min="1" max="365" style="width:110px"><span class="muted">يومًا</span></div></label>`;
  const models=[['HAIKU','هايكو'],['SONNET','سونيت'],['OPUS','أوبس']];
  return `<div class="acard"><div class="ah"><h3>التشغيل</h3></div><div class="fgrid">
    <label class="fld"><span class="h4">وقت الإيجاز الصباحي</span><input type="time" class="inp mono" id="sf-briefTime" data-sf="briefTime" value="${S.briefTime}" style="width:130px"></label>
    <div class="fld"><span class="h4">نموذج الوكلاء الجدد</span>${segA('smodel',models,S.defaultModel,' data-k="defaultModel"')}</div>
    <div class="fld"><span class="h4">نموذج المدراء الجدد</span>${segA('smodel',models,S.managerModel,' data-k="managerModel"')}</div></div></div>
   <div class="acard"><div class="ah"><h3>المخزون والتنبيهات</h3></div><div class="fgrid">
    ${num('lowStockDays','حد المخزون الحرج','يومًا',1,90)}${num('warnStockDays','حد تحذير المخزون','يومًا',2,180)}${num('acosWarn','حد نسبة الإعلان للمبيعات','%',1,99)}${num('alertRetentionDays','الاحتفاظ بالتنبيهات المتجاهلة','أيام',1,90)}</div></div>
   <div class="acard"><div class="ah"><h3>مراحل المنتجات</h3><span class="muted">بعد تجاوز الحد يُعلَّم المنتج متعثرًا وينبّه المسؤول</span></div><div class="fgrid">${stg('research')}${stg('sourcing')}${stg('shipping')}</div></div>
   <div class="acard"><div class="ah"><h3>الإقليم</h3><span class="muted">ثابت في هذا الإصدار</span></div>
    <dl class="kv"><dt>المنطقة الزمنية</dt><dd>الرياض (UTC+3)</dd><dt>العملة</dt><dd>الريال السعودي · تُحفظ المبالغ بالهللة</dd><dt>اللغة والاتجاه</dt><dd>العربية · من اليمين لليسار</dd><dt>أول أيام الأسبوع</dt><dd>الأحد</dd></dl></div>
   <div class="acard"><div class="ah"><h3>البيانات</h3><span class="muted">${CONFIG.mode==='sim'?'محفوظة في هذا المتصفح':'محفوظة في الخادم'}</span></div>
    <div class="row"><button class="pill sm" data-ad="export">تصدير نسخة احتياطية</button><button class="pill sm" data-ad="import">استيراد نسخة (لقاعدة جديدة)</button><input type="file" id="imp-file" accept=".json,application/json" hidden><span class="sp"></span></div></div>`;},
 importFile(file){const rd=new FileReader();rd.onload=()=>{let o;try{o=JSON.parse(rd.result);}catch(e){return this.toast('الملف ليس JSON صالحًا');}
  this.confirm('استيراد النسخة يستبدل كل بيانات الشركة الحالية. متابعة؟',async()=>{this.clearDraft();const r=await call('importState',o);if(r!==null)this.toast('استُوردت النسخة');this.renderAdmin(true);});};rd.readAsText(file);},

 /* ---- 7. usage & budget ---- */
 adm_usage(){const U=store.usage||{total:0,tokens:0,tasks:0,byAgent:{},byDept:{},byModel:{},daily:{}},pub=store.config.budget,B=this.D().budget,now=new Date();
  const dom=now.getDate()-1+(Date.now()-H.dayStart(Date.now()))/H.DAY,dim=new Date(now.getFullYear(),now.getMonth()+1,0).getDate(),proj=dom>0?U.total/dom*dim:0,pct=U.total/pub.monthlyCap*100;
  const col=pct>=100?'var(--alert)':pct>=pub.warnAt?'var(--wait)':'var(--ok)';
  const days=[];for(let i=13;i>=0;i--){const d=H.addDays(H.dayStart(Date.now()),-i);days.push({d,v:U.daily[H.dayKey(d)]||0});}const mx=Math.max(1,...days.map(x=>x.v));
  const dp=DEPTS.map(d=>({d,v:U.byDept[d.id]||0})).sort((a,b)=>b.v-a.v),dmax=Math.max(1,...dp.map(x=>x.v));
  const mm=[['HAIKU','هايكو'],['SONNET','سونيت'],['OPUS','أوبس']].map(([k,l])=>({k,l,v:(U.byModel||{})[k]||0})),mt=Math.max(1,mm.reduce((s,x)=>s+x.v,0));
  const top=Object.entries(U.byAgent).sort((a,b)=>b[1].cost-a[1].cost).slice(0,10);
  return `<div class="acard"><div class="ah"><h3>استهلاك ${H.MONTHS[now.getMonth()]}</h3><span class="sp"></span><span class="muted">عند بلوغ السقف: ${ON_CAP_LABEL[pub.onCap]}</span></div>
    <div class="row" style="align-items:baseline;gap:10px"><span class="mono" style="font-size:30px;font-weight:600">${H.sar2(U.total)}</span><span class="muted">من ${H.sar(pub.monthlyCap)} · ${H.p1(pct)}%</span></div>
    <div class="ubar"><i style="width:${Math.min(100,pct).toFixed(1)}%;background:${col}"></i><span class="mk" style="inset-inline-start:${pub.warnAt}%" title="التنبيه عند ${pub.warnAt}%"></span></div>
    <dl class="kv"><dt>المهام المحتسبة</dt><dd class="mono">${H.num(U.tasks)}</dd><dt>الرموز</dt><dd class="mono">${H.num(U.tokens)}</dd><dt>المتوقع لنهاية الشهر</dt><dd class="${proj>pub.monthlyCap?'bad':''}">${H.sar2(proj)}</dd><dt>الشهر الماضي</dt><dd>${U.lastMonthTotal?H.sar2(U.lastMonthTotal):'—'}</dd></dl></div>
   <div class="acard"><div class="ah"><h3>الميزانية</h3><span class="muted">تُطبَّق بعد النشر</span></div><div class="fgrid">
    <label class="fld"><span class="h4">السقف الشهري</span><div class="row" style="flex-wrap:nowrap"><input class="inp mono" type="number" min="1" id="bf-cap" data-bf="monthlyCap" value="${B.monthlyCap/100}" style="width:130px"><span class="muted">ر.س</span></div></label>
    <label class="fld"><span class="h4">التنبيه عند</span><div class="row" style="flex-wrap:nowrap"><input class="inp mono" type="number" min="1" max="99" id="bf-warn" data-bf="warnAt" value="${B.warnAt}" style="width:90px"><span class="muted">% من السقف</span></div></label>
    <div class="fld"><span class="h4">عند بلوغ السقف</span>${segA('oncap',Object.entries(ON_CAP_LABEL),B.onCap)}</div></div></div>
   <div class="acard"><div class="ah"><h3>آخر 14 يومًا</h3></div><div class="spark">${days.map((x,i)=>`<div class="${i===13?'now':''}" style="height:${Math.max(2,x.v/mx*100).toFixed(1)}%" title="${H.date(x.d)} · ${H.sar2(x.v)}"></div>`).join('')}</div>
    <div class="sparkl">${days.map(x=>`<span>${new Date(x.d).getDate()}</span>`).join('')}</div></div>
   <div class="fgrid" style="grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:14px">
    <div class="acard"><div class="ah"><h3>حسب القسم</h3></div>${dp.map(x=>`<div class="hbar" style="--ac:${META[x.d.id].c}"><span>${E(x.d.name)}</span><div class="t"><i style="width:${(x.v/dmax*100).toFixed(1)}%"></i></div><span class="mono" style="text-align:end">${H.sar2(x.v)}</span></div>`).join('')}</div>
    <div class="acard"><div class="ah"><h3>حسب النموذج</h3></div>${mm.map(x=>`<div class="hbar" style="--ac:var(--sky)"><span>${x.l} · ${MODEL_COST[x.k]} ر.س لكل مليون رمز</span><div class="t"><i style="width:${(x.v/mt*100).toFixed(1)}%"></i></div><span class="mono" style="text-align:end">${H.p1(x.v/mt*100)}%</span></div>`).join('')}
     <div class="tm">الأسعار تقديرية لغرض المتابعة، وتُستبدل بفواتير المزوّد في الوضع المتصل.</div></div></div>
   <div class="acard"><div class="ah"><h3>أعلى الوكلاء تكلفة</h3></div><table class="atable"><thead><tr><th>الوكيل</th><th>القسم</th><th>المهام</th><th>الرموز</th><th>التكلفة</th></tr></thead>
    <tbody>${top.map(([n,g])=>`<tr><td><b>${E(n)}</b></td><td><span class="ddt" style="--ac:${META[g.dept]?META[g.dept].c:'#888'}"></span>${E(DEPT[g.dept]?DEPT[g.dept].name:'')}</td><td class="mono">${g.tasks}</td><td class="mono">${H.num(g.tokens)}</td><td class="mono">${H.sar2(g.cost)}</td></tr>`).join('')||'<tr><td colspan="5"><div class="empty">لا استهلاك بعد هذا الشهر.</div></td></tr>'}</tbody></table></div>`;},

 /* ---- 8. audit & versions ---- */
 adm_audit(){const C=store.config,A=this.adm;const vers=[{version:C.version,publishedAt:C.publishedAt,note:C.note,changes:C.changes||[],current:true}].concat(store.configHistory);
  const vrow=v=>{const open=A.open['v'+v.version];return `<div class="lrow"><span class="cst ${v.current?'st-connected':'st-simulated'}">v${v.version}</span><div style="flex:1;min-width:0"><div style="font-weight:700;font-size:12px">${E(v.note||'بلا وصف')}</div>
   <div class="tm">${H.date(v.publishedAt)} ${H.hm(v.publishedAt)} · ${v.changes.length} تغييرات${v.current?' · الإصدار الحالي':''}</div>${open?`<ol class="difflist">${v.changes.map(c=>`<li>${E(c)}</li>`).join('')}</ol>`:''}</div>
   <div class="tbtns" style="margin:0;flex:none">${v.changes.length?`<button class="pill xs" data-ad="vopen" data-v="${v.version}">${open?'إخفاء':'التغييرات'}</button>`:''}${!v.current?`<button class="pill xs" data-ad="vrevert" data-v="${v.version}">التراجع إلى هذا الإصدار</button>`:''}</div></div>`;};
  const areas=[...new Set(store.audit.map(e=>e.area))];const L=store.audit.filter(e=>!A.aa||e.area===A.aa).slice(0,150);
  return `<div class="acard"><div class="ah"><h3>الإصدارات</h3><span class="muted">آخر ${vers.length} إصدارات · التراجع يُنشر كإصدار جديد</span></div>${vers.map(vrow).join('')}</div>
   <div class="acard"><div class="ah"><h3>سجل التدقيق</h3><span class="muted">${store.audit.length} حدثًا</span></div>
    <div class="row">${areas.map(a=>`<button class="chip${A.aa===a?' on':''}" data-ad="aa" data-v="${E(a)}">${E(a)}</button>`).join('')}</div>
    <table class="atable"><thead><tr><th>الوقت</th><th>المجال</th><th>الإجراء</th><th>التفاصيل</th><th>بواسطة</th></tr></thead><tbody>${L.map(e=>`<tr><td class="mono" style="font-size:11px;white-space:nowrap">${new Date(e.at).getDate()} ${H.MONTHS[new Date(e.at).getMonth()]} · ${H.hm(e.at)}</td><td><span class="chip">${E(e.area)}</span></td><td><b>${E(e.action)}</b></td>
     <td>${E(e.target||'')}${Array.isArray(e.detail)?`<div class="tm">${e.detail.slice(0,3).map(E).join('<br>')}${e.detail.length>3?'<br>و'+(e.detail.length-3)+' أخرى':''}</div>`:e.detail?`<div class="tm">${E(e.detail)}</div>`:''}</td><td class="muted">${E(e.actor)}</td></tr>`).join('')||'<tr><td colspan="5"><div class="empty">لا أحداث.</div></td></tr>'}</tbody></table></div>`;},

 /* ---- publish ---- */
 openPublish(){const ch=this.draftChanges();if(!ch.length){this.toast('لا تغييرات للنشر');return;}const D=clone(this.draft);D.agents.forEach(a=>a.name=a.name.trim());D.depts.forEach(d=>d.name=d.name.trim());
  const errs=validateConfig(D),gone=store.config.agents.filter(a=>!D.agents.some(x=>x.id===a.id)).map(a=>a.name),moved=tasksArr().filter(t=>gone.includes(t.agent)&&OPEN_ST.includes(t.status)).length;
  const renamed=store.config.agents.filter(a=>{const n=D.agents.find(x=>x.id===a.id);return n&&n.name!==a.name;}).length,nv=store.config.version+1;
  this.openModal(`<h2>مراجعة ونشر الإصدار ${nv}</h2><div class="sub">${ch.length} تغييرات على الإصدار ${store.config.version}. تُطبَّق فور النشر، ويمكن التراجع من السجل.</div>
   <ol class="difflist">${ch.map(c=>`<li>${E(c)}</li>`).join('')}</ol>
   ${moved||renamed?`<div class="why">${moved?`سيُعاد إسناد ${moved} مهمة مفتوحة. `:''}${renamed?'سيُحدَّث المسمى في المهام والروتينات والتنبيهات.':''}</div>`:''}
   ${errs.length?`<div class="errs">لا يمكن النشر قبل إصلاح:<br>${errs.map(E).join('<br>')}</div>`:''}
   <div class="fld"><span class="h4">وصف الإصدار (اختياري)</span><input class="inp" id="pub-note" maxlength="120" placeholder="مثال: إعادة توزيع فريق أمازون"></div>
   <div class="acts"><button class="pill approve" data-primary id="pub-ok"${errs.length?' disabled':''}>نشر الإصدار ${nv}</button><button class="pill" data-m="close">متابعة التعديل</button></div>`,{kind:'pub'});
  const ok=$('#pub-ok');ok.addEventListener('click',async()=>{if(ok.disabled)return;ok.disabled=true;ok.textContent='جارٍ النشر…';const r=await call('publishConfig',this.draft,$('#pub-note').value);
   if(r){this.clearDraft();this.closeModal();this.toast(`نُشر الإصدار ${r.version}${r.moved?` · أُعيد إسناد ${r.moved} مهمة`:''}`);this.renderAdmin(true);this.render();}else{ok.disabled=false;ok.textContent=`نشر الإصدار ${nv}`;}});},

 /* ---- events ---- */
 async admAction(act,v,b){const A=this.adm,id=b.dataset.id,i=b.dataset.i!=null?+b.dataset.i:null;let D=null;const cur=()=>(D=this.D());
  switch(act){
   case 'tab':A.tab=v;prefs.admTab=v;savePrefs();this._resetScroll=true;break;
   case 'discard':return this.confirm('تجاهل كل التغييرات غير المنشورة؟',()=>{this.clearDraft();this.renderAdmin(true);this.render();this.toast('أُلغيت المسودة');});
   case 'review':return this.openPublish();
   case 'dept':A.dept=v;A.agent=null;this._resetScroll=true;break;
   case 'denable':cur().depts.find(x=>x.id===A.dept).enabled=v==='on';break;
   case 'dtool':{const d=cur().depts.find(x=>x.id===A.dept);if(d.id==='core')return;const has=d.tools.includes(v);d.tools=has?d.tools.filter(x=>x!==v):d.tools.concat(v);
    D.agents.filter(a=>a.dept===d.id).forEach(a=>{a.tools=has?a.tools.filter(x=>x!==v):a.tools.includes(v)?a.tools:a.tools.concat(v);});break;}
   case 'addagent':{const d=cur().depts.find(x=>x.id===A.dept);if(D.agents.filter(a=>a.dept===d.id).length>=MAX_AGENTS)return this.toast('الحد الأقصى '+MAX_AGENTS+' وكلاء في القسم');
    let n='وكيل جديد',k=2;while(D.agents.some(a=>a.name===n))n='وكيل جديد '+(k++);const nid='ag'+Date.now().toString(36);
    D.agents.push({id:nid,name:n,dept:d.id,mgr:false,role:'',instructions:DEFAULT_INSTR,model:D.settings.defaultModel||'SONNET',tools:d.tools.slice(),status:'active'});A.agent=nid;
    this.saveDraft();this.renderAdmin(true);this.render();const inp=$('#af-name');if(inp){inp.focus();inp.select();}return;}
   case 'editagent':A.agent=A.agent===id?null:id;break;
   case 'closeagent':A.agent=null;break;
   case 'mkmgr':{const a=cur().agents.find(x=>x.id===id);D.agents.forEach(x=>{if(x.dept===a.dept)x.mgr=false;});a.mgr=true;if(D.settings.managerModel)a.model=D.settings.managerModel;break;}
   case 'delagent':return this.openDelAgent(id);
   case 'atool':{const a=cur().agents.find(x=>x.id===A.agent);if(!a)return;a.tools=a.tools.includes(v)?a.tools.filter(x=>x!==v):a.tools.concat(v);break;}
   case 'amodel':case 'astatus':{const a=cur().agents.find(x=>x.id===A.agent);if(a)a[act==='amodel'?'model':'status']=v;break;}
   case 'ts':A.ts=v;A.tn=80;break;
   case 'tmore':A.tn+=80;break;
   case 'tedit':return this.openTaskEdit(id);
   case 'tcancel':return this.confirm('إلغاء المهمة «'+((store.tasks.get(id)||{}).title||'')+'»؟',async()=>{await call('cancelTask',id);this.toast('أُلغيت المهمة');this.renderAdmin(true);});
   case 'bulk':{const n=await call('reassignOpen',$('#bfrom').value,$('#bto').value);if(n!=null)this.toast(`أُعيد إسناد ${n} مهمة`);break;}
   case 'rnew':return this.openRoutineEdit(null);
   case 'redit':return this.openRoutineEdit(id);
   case 'rrun':await call('runRoutine',id);this.toast('بدأ تشغيل الروتين');break;
   case 'rtoggle':{const r=store.routines.find(x=>x.id===id);if(r){const was=r.paused;await call('updateRoutine',id,{paused:!was});this.toast(was?'استُؤنف الروتين':'أُوقف الروتين');}break;}
   case 'rdel':{const r=store.routines.find(x=>x.id===id);return this.confirm(`حذف الروتين «${r?r.title:''}» وإلغاء تشغيلاته المجدولة؟`,async()=>{await call('deleteRoutine',id);this.toast('حُذف الروتين');this.renderAdmin(true);});}
   case 'pmode':{const p=cur().policies[i];if(p.locked)return;p.mode=v;if(v==='limit'&&p.limit==null)p.limit=p.unit==='SAR'?1000:5;break;}
   case 'ovadd':(cur().overrides=D.overrides||[]).push({id:'o'+Date.now().toString(36),scope:'dept',target:'amazon',action:'price_change',mode:'limit',limit:10});break;
   case 'ovdel':cur().overrides.splice(i,1);break;
   case 'ovmode':{const o=cur().overrides[i];o.mode=v;if(v==='limit'&&o.limit==null)o.limit=polUnit(o.action)==='SAR'?1000:5;break;}
   case 'cf':A.cf=v;break;
   case 'clog':A.open[id]=!A.open[id];break;
   case 'cconn':return this.openConnect(id);
   case 'ctest':{this.toast('جارٍ اختبار الاتصال…');const r=await call('connectorAction',id,'test');if(r)this.toast(r.lastError?'فشل الاختبار: '+r.lastError:'نجح الاختبار · '+r.latency+' مللي ثانية');break;}
   case 'csync':await call('connectorAction',id,'sync');this.toast('تمت المزامنة');break;
   case 'cdis':return this.confirm(`فصل «${TOOL[id].name}» وحذف تفويضه؟ لن يستخدمه الوكلاء حتى تعيد ربطه.`,async()=>{await call('connectorAction',id,'disconnect');this.toast('فُصل الموصل');this.renderAdmin(true);});
   case 'cdisable':await call('connectorAction',id,'disable');this.toast('عُطّل الموصل؛ لن يستخدمه الوكلاء');break;
   case 'cenable':await call('connectorAction',id,'enable');this.toast('فُعّل الموصل');break;
   case 'cscope':await call('connectorAction',id,'scopes',{scopes:v});break;
   case 'cadd':return this.openAddConnector();
   case 'cremove':return this.confirm(`حذف الموصل «${TOOL[id].name}» من كل الأقسام والوكلاء؟`,async()=>{await call('removeConnector',id);
    if(this.draft){this.draft.customTools=(this.draft.customTools||[]).filter(x=>x.id!==id);this.draft.depts.forEach(d=>d.tools=d.tools.filter(x=>x!==id));this.draft.agents.forEach(a=>a.tools=a.tools.filter(x=>x!==id));this.saveDraft();}
    this.toast('حُذف الموصل');this.renderAdmin(true);});
   case 'smodel':cur().settings[b.dataset.k]=v;break;
   case 'oncap':cur().budget.onCap=v;break;
   case 'export':return this.exportData();
   case 'import':return $('#imp-file')&&$('#imp-file').click();
   case 'reset':return this.confirm('إعادة ضبط الشركة تحذف كل البيانات المحلية وتولّد بداية جديدة. متابعة؟',async()=>{this.clearDraft();await call('reset');this.toast('أُعيد ضبط الشركة');this.renderAdmin(true);});
   case 'vopen':A.open['v'+v]=!A.open['v'+v];break;
   case 'vrevert':return this.confirm(`التراجع إلى الإصدار ${v}؟ يُنشر كإصدار جديد، وتُسند مهام الوكلاء غير الموجودين فيه إلى مدراء أقسامهم.`,async()=>{this.clearDraft();const r=await call('revertConfig',+v);if(r)this.toast('نُشر الإصدار '+r.version+' (تراجع)');this.renderAdmin(true);this.render();});
   case 'aa':A.aa=A.aa===v?'':v;break;
   default:return;}
  if(D)this.saveDraft();this.renderAdmin(true);this.render();},
 admInput(t,ch){const A=this.adm,ds=t.dataset;
  if(t.id==='imp-file'){if(ch&&t.files&&t.files[0])this.importFile(t.files[0]);t.value&&ch&&(t.value='');return;}
  if(t.id==='adm-tq'){A.tq=t.value;A.tn=80;return this.renderAdmin(true);}
  if(t.id==='adm-rq'){A.rq=t.value;return this.renderAdmin(true);}
  if(t.id==='adm-cq'){A.cq=t.value;return this.renderAdmin(true);}
  if(t.id==='adm-td'||t.id==='adm-ta'){if(ch){A[t.id.slice(4)]=t.value;A.tn=80;this.renderAdmin(true);}return;}
  let D;
  if(ds.df!=null){D=this.D();D.depts.find(x=>x.id===A.dept)[ds.df]=t.value;}
  else if(ds.af!=null){D=this.D();const a=D.agents.find(x=>x.id===A.agent);if(!a)return;
   if(ds.af==='dept'){if(!ch)return;if(D.agents.filter(x=>x.dept===t.value).length>=MAX_AGENTS){this.toast('القسم مكتمل');return this.renderAdmin(true);}
    const nd=D.depts.find(x=>x.id===t.value);a.dept=t.value;a.tools=a.tools.filter(x=>nd.tools.includes(x));if(!a.tools.length)a.tools=nd.tools.slice();A.dept=t.value;this.saveDraft();this.renderAdmin(true);return this.render();}
   a[ds.af]=t.value;}
  else if(ds.pl!=null){D=this.D();D.policies[+ds.pl].limit=parseFloat(t.value);}
  else if(ds.ovl!=null){D=this.D();D.overrides[+ds.ovl].limit=parseFloat(t.value);}
  else if(ds.ov!=null){if(!ch)return;D=this.D();const o=D.overrides[+ds.i];o[ds.ov]=t.value;
   if(ds.ov==='scope')o.target=o.scope==='dept'?'amazon':(D.agents.find(a=>a.dept==='amazon'&&!a.mgr)||D.agents[0]).id;
   if(ds.ov==='action'&&!polUnit(o.action)&&o.mode==='limit')o.mode='always';this.saveDraft();this.renderAdmin(true);return this.render();}
  else if(ds.sf!=null){D=this.D();D.settings[ds.sf]=ds.sf==='briefTime'?t.value:parseFloat(t.value);}
  else if(ds.sl!=null){D=this.D();D.settings.stageLimits=Object.assign({},D.settings.stageLimits,{[ds.sl]:parseInt(t.value,10)});}
  else if(ds.bf!=null){D=this.D();D.budget[ds.bf]=ds.bf==='monthlyCap'?Math.round(parseFloat(t.value)*100):parseFloat(t.value);}
  else return;
  this.saveDraft();this.admHead();}
});
function wireAdmin(){const el=$('#admin');
 el.addEventListener('mousedown',()=>{UI._admDown=true;});document.addEventListener('mouseup',()=>setTimeout(()=>{UI._admDown=false;},0));
 el.addEventListener('click',e=>{const b=e.target.closest('[data-ad]');if(!b||b.disabled||!el.contains(b))return;UI.admAction(b.dataset.ad,b.dataset.v,b);});
 el.addEventListener('input',e=>UI.admInput(e.target,false));
 el.addEventListener('change',e=>UI.admInput(e.target,true));}

export { DRAFT_KEY, OPEN_ST, SAR_ACTIONS, ADM_TABS, KNOWN_MCP, agentOptions, segA, pb, polUnit, wireAdmin };
