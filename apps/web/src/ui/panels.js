/* Ported from the Claude Design prototype (f-panels.js); logic kept intact, wired as an ES module. */
import { ACTION_LABEL, CONFIG, CONN_LABEL, DEPT, DEPTS, FREQ_LABEL, H, LVL_LABEL, META, METHOD, MODEL_LABEL, OPS, SETTINGS, STAGE, STAGES, STATUS_LABEL, TOOL, cover, margin } from '../core/runtime.js';
import { adapter, auth } from '../core/adapter.js';
import { Overlay, Scene, Viz, activeAlerts, applySnapshot, approvalReason, onEvent, policyOf, prodById, store, tasksArr, valueDesc } from './scene.js';
import { $, E, UI, call, prefs, savePrefs } from './ui.js';
import { wireAdmin } from './admin.js';

/* ============ modals ============ */
Object.assign(UI,{
 openModal(html,opts){const m=$('#modal');m.innerHTML=`<div class="box">${html}</div>`;m.classList.add('open');this.modal=Object.assign({},opts||{});
  const p=m.querySelector('[data-primary]')||m.querySelector('.acts .pill');if(p)setTimeout(()=>p.focus(),30);},
 closeModal(){$('#modal').classList.remove('open');$('#modal').innerHTML='';this.modal=null;},
 setModal(html){const b=$('#modal .box');if(b&&b._h!==html){const st=b.scrollTop;b.innerHTML=html;b._h=html;b.scrollTop=st;}},

 taskHtml(t){const D=DEPT[t.dept],p=t.productId&&prodById(t.productId);
  const acts=[];if(t.status==='waiting'){acts.push(`<button class="pill approve" data-primary data-m="approve">${t.action==='payment'?'موافقة على التجهيز':'موافقة وتنفيذ'}</button>`,`<button class="pill" data-m="sendback">إعادة للتعديل</button>`,`<button class="pill danger" data-m="reject">رفض</button>`);}
  else if(t.status!=='done'&&t.status!=='cancelled')acts.push(`<button class="pill" data-m="${t.status==='progress'?'cancel':'run'}">${t.status==='progress'?'إلغاء':'تشغيل الآن'}</button>`);
  acts.push(`<button class="pill" data-m="cal">فتح في التقويم</button>`,`<button class="pill" data-m="close">إغلاق</button>`);
  return `<h2>${E(t.title)}</h2><div class="sub">${E(t.agent)} · ${E(D.name)} · ${STATUS_LABEL[t.status]}${t.status==='progress'?' · '+Math.round(t.progress)+'%':''}</div>
  <dl class="kv"><dt>نوع الفعل</dt><dd>${E(ACTION_LABEL[t.action]||t.action)}${t.value!=null?' · '+E(valueDesc(t)):''}</dd><dt>النموذج</dt><dd>${MODEL_LABEL[t.model]||t.model}</dd>
   ${t.at?`<dt>الموعد</dt><dd>${H.rel(t.at)} ${H.hm(t.at)} · ${H.date(t.at)}</dd>`:''}${t.doneAt&&t.status==='done'?`<dt>أُنجزت</dt><dd>${H.rel(t.doneAt)} ${H.hm(t.doneAt)}</dd>`:''}
   ${p?`<dt>المنتج</dt><dd><a data-prod="${p.id}">${E(p.name)}</a></dd>`:''}${t.source?`<dt>المصدر</dt><dd>${E(t.source)}</dd>`:''}${t.viaExec?'<dt>التوجيه</dt><dd>عبر المدير التنفيذي</dd>':''}${t.team?'<dt>الفريق</dt><dd>مدير القسم مع فريقه</dd>':''}</dl>
  ${t.status==='waiting'?`<div class="why">${E(approvalReason(t))}</div>`:''}
  ${t.artifact&&t.status==='waiting'?`<div class="sec"><div class="h4">المسودة · ${E(t.artifact.name)}</div><pre class="file">${E(t.artifact.body)}</pre></div>`:''}
  ${t.result?`<div class="sec"><div class="h4">النتيجة</div><div>${E(t.result.summary)}</div>${t.result.file?`<div class="h4" style="margin-top:10px">${E(t.result.file.name)}</div><pre class="file">${E(t.result.file.body)}</pre>`:''}</div>`:''}
  <div class="acts">${acts.join('')}</div>`;},
 openTask(id){const t=store.tasks.get(id);if(!t)return;this.openModal(this.taskHtml(t),{kind:'task',id,refresh:()=>{const x=store.tasks.get(id);if(x)this.setModal(this.taskHtml(x));}});},
 async modalAction(a){const M=this.modal;if(!M)return;if(a==='close')return this.closeModal();
  if(M.kind==='task'){const id=M.id,t=store.tasks.get(id);
   if(a==='approve'){await call('approve',id);this.toast(t.action==='payment'?'جُهّزت الدفعة وتنتظر التنفيذ منك في البنك':'نُفّذت بعد موافقتك');}
   if(a==='sendback'){await call('sendBack',id);this.toast('أُعيدت للتعديل');}if(a==='reject'){await call('reject',id);this.toast('رُفضت');this.closeModal();}
   if(a==='cancel'){await call('cancelTask',id);this.toast('أُلغيت');}if(a==='run'){await call('runNow',id);}
   if(a==='cal'){this.closeModal();this.taskAction(id,'cal');}}},

 openBrain(){const html=()=>{const ev=store.events.filter(e=>e.kind==='read'||e.kind==='write').slice(-15).reverse();const g=tasksArr().find(t=>t.agent==='حارس المعرفة'&&t.status==='progress');
   return `<h2>العقل</h2><div class="sub">مركز المعرفة المشترك لكل الوكلاء</div>
   <dl class="kv"><dt>الملاحظات</dt><dd class="mono">${H.num(store.notes)}</dd><dt>المسؤول</dt><dd>حارس المعرفة${g?' · يعمل على «'+E(g.title)+'»':''}</dd><dt>المصدر الخارجي</dt><dd>قاعدة المعرفة (نسخة مقروءة)</dd></dl>
   <div class="sec"><div class="h4">آخر 15 قراءة وكتابة</div><div class="feed">${ev.length?ev.map(e=>`<div>${H.hm(e.t)} ${E(e.agent)} ${E(e.text)}</div>`).join(''):'<div>لا نشاط بعد.</div>'}</div></div>
   <div class="acts"><button class="pill" data-m="close" data-primary>إغلاق</button></div>`;};
  this.openModal(html(),{kind:'brain',refresh:()=>this.setModal(html())});},

 briefArrived(b){const dk=H.dayKey(b.at);if(!b.read&&dk===H.dayKey(Date.now())&&prefs.briefOpened!==dk&&store.ready){prefs.briefOpened=dk;savePrefs();setTimeout(()=>this.openBrief(b.id),400);}},
 openBrief(id){const b=id?store.briefs.find(x=>x.id===id):store.briefs[0];if(!b){this.toast('لم يصدر إيجاز بعد؛ يصدر بعد الساعة 08:00');return;}
  this.openModal(`<h2>الإيجاز الصباحي</h2><div class="sub">${H.DAYS[new Date(b.at).getDay()]} ${H.date(b.at)} · ${H.hm(b.at)} · المدير التنفيذي</div><div class="brief">${E(b.text)}</div>
  <div class="acts"><button class="pill primary" data-primary data-b="ap">فتح الموافقات</button><button class="pill" data-b="al">فتح التنبيهات</button><button class="pill" data-b="hist">الإيجازات السابقة</button><button class="pill" data-m="close">إغلاق</button></div>`,{kind:'brief'});
  if(!b.read)call('markBriefRead',b.id);},
 openBriefHistory(){this.openModal(`<h2>الإيجازات السابقة</h2><div class="sub">آخر ${store.briefs.length} إيجازًا</div><div class="sec">${store.briefs.map(b=>`<div class="lrow"><a data-brief="${b.id}">${H.DAYS[new Date(b.at).getDay()]} ${H.date(b.at)}</a><span class="sp" style="flex:1"></span>${b.read?'<span class="muted">مقروء</span>':'<span class="warn">جديد</span>'}</div>`).join('')||'<div class="empty">لا إيجازات.</div>'}</div><div class="acts"><button class="pill" data-m="close" data-primary>إغلاق</button></div>`,{kind:'bh'});},

 confirm(msg,fn){this.openModal(`<h2>تأكيد</h2><div class="sub" style="font-size:12.5px;margin-top:8px">${E(msg)}</div><div class="acts"><button class="pill danger" data-primary id="cfok">تأكيد</button><button class="pill" data-m="close">إلغاء</button></div>`,{kind:'cf'});
  $('#cfok').addEventListener('click',()=>{this.closeModal();fn();});},

 /* drops */
 openDrop(kind,btn){if(this.drop&&this.drop.kind===kind)return this.closeDrop();const d=$('#drop');const r=btn.getBoundingClientRect();d.style.top=(r.bottom+8)+'px';d.style.left=Math.max(10,r.left)+'px';
  this.drop={kind,refresh:()=>{const h=kind==='alerts'?this.alertsHtml():this.approvalsHtml();if(d._h!==h){d.innerHTML=h;d._h=h;}}};d.classList.add('open');d._h='';this.drop.refresh();},
 closeDrop(){$('#drop').classList.remove('open');this.drop=null;},
 alertsHtml(){const o={critical:0,warning:1,info:2};const A=activeAlerts().sort((a,b)=>o[a.level]-o[b.level]||b.at-a.at);
  return `<h3>التنبيهات</h3>${A.length?A.map(a=>`<div class="lrow"><span class="lvl ${a.level}">${LVL_LABEL[a.level]}</span><div style="flex:1;min-width:0"><div style="font-weight:700;font-size:12px;line-height:1.5">${E(a.title)}</div>
   <div class="tm">${E(a.agent)} · ${E(DEPT[a.dept].name)} · ${H.ago(a.at)}</div><div class="tbtns">${a.taskId&&store.tasks.get(a.taskId)?`<button class="pill xs" data-al="opentask" data-id="${a.id}">فتح المهمة</button>`:`<button class="pill xs" data-al="task" data-id="${a.id}">إنشاء مهمة</button>`}
   ${a.productId?`<button class="pill xs" data-al="prod" data-id="${a.id}">فتح المنتج</button>`:''}<button class="pill xs" data-al="dismiss" data-id="${a.id}">تجاهل</button></div></div></div>`).join(''):'<div class="empty">لا تنبيهات الآن.</div>'}`;},
 approvalsHtml(){const W=tasksArr().filter(t=>t.status==='waiting').sort((a,b)=>a.at-b.at);
  return `<h3>الموافقات</h3>${W.length?W.map(t=>`<button class="lrow" data-open="${t.id}" style="width:100%;text-align:start"><span class="lvl warning">!</span><div style="flex:1"><div style="font-weight:700;font-size:12px;line-height:1.5">${E(t.title)}</div><div class="tm">${E(t.agent)} · ${E(DEPT[t.dept].name)} · ${E(valueDesc(t))}</div></div></button>`).join(''):'<div class="empty">لا شيء بانتظار موافقتك.</div>'}`;},
 async alertAction(a,id){const al=store.alerts.find(x=>x.id===id);if(!al)return;
  if(a==='dismiss'){await call('dismissAlert',id);}
  if(a==='task'){const t=await call('taskFromAlert',id);if(t)this.toast('أُنشئت مهمة: '+t.title);}
  if(a==='opentask'){this.closeDrop();this.openTask(al.taskId);}
  if(a==='prod'){this.closeDrop();this.openProduct(al.productId);}},

 /* products */
 renderProducts(){const P=store.products,now=Date.now();const T=tasksArr(),A=activeAlerts();
  const card=p=>{const days=H.daysSince(p.stageSince),lim=STAGE[p.stage].limit,stuck=lim&&days>lim;const open=T.filter(t=>t.productId===p.id&&['scheduled','progress','waiting','backlog'].includes(t.status)).length,al=A.filter(a=>a.productId===p.id).length;
   let nums='';if(p.stage==='live'||p.stage==='paused'){const c=cover(p);nums=`<div class="pgrid"><div>السعر<b>${H.sarN(p.price)}</b></div><div>الهامش<b>${H.p1(margin(p))}%</b></div><div>المخزون<b>${p.stock} <span class="${c<SETTINGS.lowStockDays?'bad':c<SETTINGS.warnStockDays?'warn':''}" style="font-size:10.5px">· ${c>=999?'—':Math.floor(c)+' يومًا'}</span></b></div><div>مبيعات 7 أيام<b>${p.sales7d}</b></div></div>`;}
   else if(p.stage!=='research')nums=`<div class="pgrid"><div>التكلفة<b>${H.sarN(p.cost)}</b></div><div>السعر المستهدف<b>${H.sarN(p.price)}</b></div><div>الهامش المتوقع<b>${H.p1(margin(p))}%</b></div></div>`;
   return `<button class="pcard${stuck?' stuck':''}" data-prod="${p.id}"><div class="pn">${E(p.name)}</div><div class="ps">${E(p.sku)}${p.asin?' · '+E(p.asin):''}</div>
    <div class="tm ${stuck?'bad':''}">منذ ${days} يومًا${stuck?' · متعثر':''}</div>${nums}<div class="pind"><span>مهام مفتوحة ${open}</span><span>·</span><span>تنبيهات ${al}</span></div></button>`;};
  const html=`<div class="lhead"><h2>المنتجات</h2><div class="row">${STAGES.map(s=>`<span class="chip">${s.name} <b>${P.filter(p=>p.stage===s.id).length}</b></span>`).join('')}</div><span class="sp"></span><button class="pill primary" id="newprod">منتج جديد</button><button class="pill" data-close-layer>إغلاق</button></div>
   <div class="kan">${STAGES.map(s=>`<div class="kcol" style="--ac:${s.c}"><div class="kch"><span class="dot"></span>${s.name}<b>${P.filter(p=>p.stage===s.id).length}</b></div><div class="kl">${P.filter(p=>p.stage===s.id).map(card).join('')||'<div class="empty">لا منتجات.</div>'}</div></div>`).join('')}</div>`;
  const el=$('#products');if(el._h!==html){el.innerHTML=html;el._h=html;}},
 prodHtml(p){const T=tasksArr().filter(t=>t.productId===p.id&&t.status!=='cancelled').sort((a,b)=>(b.at||0)-(a.at||0)).slice(0,8),A=activeAlerts().filter(a=>a.productId===p.id);
  return `<h2>${E(p.name)}</h2><div class="sub mono" style="direction:ltr;text-align:right">${E(p.sku)}${p.asin?' · '+E(p.asin):''}</div><div class="sub">المرحلة: ${STAGE[p.stage].name} · منذ ${H.daysSince(p.stageSince)} يومًا</div>
  <dl class="kv"><dt>التكلفة</dt><dd>${H.sar(p.cost)}</dd><dt>السعر</dt><dd>${H.sar(p.price)}</dd><dt>الهامش</dt><dd>${H.p1(margin(p))}%</dd><dt>المخزون</dt><dd>${p.stock} قطعة${p.stage==='live'?' · '+(cover(p)>=999?'—':Math.floor(cover(p))+' يومًا'):''}</dd><dt>مبيعات 7 أيام</dt><dd>${p.sales7d}</dd></dl>
  <div class="sec"><div class="h4">المهام المرتبطة</div>${T.length?`<div style="display:flex;flex-direction:column;gap:6px">${T.map(t=>`<button class="lrow" data-open="${t.id}" style="width:100%;text-align:start;padding:6px 0"><span class="tb ${t.status==='done'?'d':t.status==='waiting'?'w':''}" style="min-width:auto">${STATUS_LABEL[t.status]}</span><span style="font-size:11.5px">${E(t.title)}</span></button>`).join('')}</div>`:'<div class="muted">لا مهام.</div>'}</div>
  ${A.length?`<div class="sec"><div class="h4">التنبيهات</div>${A.map(a=>`<div class="lrow" style="padding:6px 0"><span class="lvl ${a.level}">${LVL_LABEL[a.level]}</span><span style="font-size:11.5px">${E(a.title)}</span></div>`).join('')}</div>`:''}
  <div class="sec"><div class="h4">سجل المراحل</div>${(p.stages||[]).map(s=>`<div class="tm">${STAGE[s.stage].name} · ${H.date(s.at)}</div>`).join('')}</div>
  <div class="fld"><span class="h4">ملاحظة</span><textarea class="inp" id="pnote" style="height:60px;resize:vertical">${E(p.note||'')}</textarea></div>
  <div class="sec"><div class="h4">نقل إلى…</div><div class="row">${STAGES.filter(s=>s.id!==p.stage).map(s=>`<button class="pill xs" data-stage="${s.id}">${s.name}</button>`).join('')}</div></div>
  <div class="acts"><button class="pill primary" data-primary id="ptask">مهمة لهذا المنتج</button><button class="pill" data-m="close">إغلاق</button></div>`;},
 openProduct(id){const p=prodById(id);if(!p)return;this.openModal(this.prodHtml(p),{kind:'prod',id,refresh:()=>{const x=prodById(id);if(x)this.setModal(this.prodHtml(x));}});},
 openNewProduct(){this.openModal(`<h2>منتج جديد</h2><div class="sub">ينشئ تلقائيًا مهمة «دراسة أولية» لباحث المنتجات.</div>
  <div class="fld"><span class="h4">الاسم</span><input class="inp" id="np-name"></div><div class="fld"><span class="h4">الرمز</span><input class="inp mono" id="np-sku" dir="ltr" placeholder="XX-NEW-09"></div>
  <div class="fld"><span class="h4">المرحلة</span><select class="sel" id="np-stage">${STAGES.map(s=>`<option value="${s.id}">${s.name}</option>`).join('')}</select></div>
  <div class="row" style="margin-top:10px"><div class="fld" style="flex:1;margin:0"><span class="h4">التكلفة (ر.س)</span><input class="inp mono" type="number" id="np-cost" min="0"></div><div class="fld" style="flex:1;margin:0"><span class="h4">السعر المستهدف (ر.س)</span><input class="inp mono" type="number" id="np-price" min="0"></div></div>
  <div class="acts"><button class="pill primary" id="np-save">حفظ</button><button class="pill" data-m="close">إلغاء</button></div>`,{kind:'np'});setTimeout(()=>$('#np-name').focus(),40);
  $('#np-save').addEventListener('click',async()=>{const name=$('#np-name').value.trim();if(!name){this.toast('اكتب اسم المنتج');return;}
   await call('createProduct',{name,sku:$('#np-sku').value.trim(),stage:$('#np-stage').value,cost:parseFloat($('#np-cost').value)||0,price:parseFloat($('#np-price').value)||0});this.toast('أُضيف المنتج وبدأت دراسته');this.closeModal();});},

 /* calendar */
 renderCal(){const C=this.cal,now=Date.now(),cur=new Date(C.cursor);const T=tasksArr().filter(t=>t.status!=='cancelled'&&t.status!=='backlog'&&!C.hidden.has(t.dept)&&(C.done||t.status!=='done')&&(!C.onlyWait||t.status==='waiting'));
  const dayOf=t=>t.status==='done'?t.doneAt:t.at;const q=C.q.trim();const byDay=new Map();T.forEach(t=>{const d=dayOf(t);if(!d)return;const k=H.dayKey(d);(byDay.get(k)||byDay.set(k,[]).get(k)).push(t);});
  byDay.forEach(a=>a.sort((x,y)=>dayOf(x)-dayOf(y)));
  const chip=t=>{const ac=META[t.dept].c,sy=t.status==='done'?'✓':t.status==='waiting'?'!':t.status==='progress'?'◐':'○';const l2=t.status==='done'?'أُنجزت '+H.hm(t.doneAt):t.status==='waiting'?'بانتظار موافقتك':t.status==='progress'?'يعمل · '+Math.round(t.progress)+'%':H.hm(t.at);
   const dim=q&&!(t.title.includes(q)||t.agent.includes(q));return `<button class="cchip${t.status==='scheduled'?' sch':''}${t.status==='waiting'?' wt':''}${dim?' dim':''}" data-open="${t.id}" style="--ac:${ac}"><span class="sy">${sy}</span><span class="cx"><div class="c1">${E(t.title)}</div><div class="c2">${l2}</div></span><span class="av">${E(H.initials(t.agent))}</span></button>`;};
  let label,grid;
  if(C.view==='month'){const y=cur.getFullYear(),m=cur.getMonth(),first=new Date(y,m,1),off=first.getDay(),dim=new Date(y,m+1,0).getDate(),rows=Math.ceil((off+dim)/7);label=H.MONTHS[m]+' '+y;
   const cells=[];for(let i=0;i<rows*7;i++){const d=new Date(y,m,1-off+i),k=H.dayKey(d),L=byDay.get(k)||[],w=d.getDay();
    cells.push(`<div class="cell${w>=5?' we':''}${d.getMonth()!==m?' out':''}${k===H.dayKey(now)?' today':''}"><div class="dn">${d.getDate()}${d.getDate()===1?`<small>${H.MONTHS[d.getMonth()]}</small>`:''}</div>${L.slice(0,2).map(chip).join('')}${L.length>2?`<button class="moreb" data-wk="${d.getTime()}">${L.length-2} أخرى</button>`:''}</div>`);}
   grid=`<div class="mgrid">${H.DAYS.map(d=>`<div class="mh">${d}</div>`).join('')}${cells.join('')}</div>`;}
  else{const s=new Date(cur);s.setDate(s.getDate()-s.getDay());s.setHours(0,0,0,0);const e=new Date(s);e.setDate(e.getDate()+6);label=`${s.getDate()} ${H.MONTHS[s.getMonth()]} – ${e.getDate()} ${H.MONTHS[e.getMonth()]} ${e.getFullYear()}`;
   grid=`<div class="wgrid">${[0,1,2,3,4,5,6].map(i=>{const d=new Date(s);d.setDate(s.getDate()+i);const L=byDay.get(H.dayKey(d))||[];return `<div class="wcol${i>=5?' cell we':''}" style="${H.dayKey(d)===H.dayKey(now)?'border:2px solid #fff;box-shadow:0 0 18px rgba(143,211,255,.45)':''}"><div class="mh" style="text-align:start">${H.DAYS[i]} <span class="mono">${d.getDate()}</span></div>${L.map(chip).join('')||'<div class="muted" style="font-size:10.5px">لا مهام</div>'}</div>`;}).join('')}</div>`;}
  const R=store.routines,rq=q?R.filter(r=>r.title.includes(q)||r.agent.includes(q)):R;const all=tasksArr();
  const nextRun=r=>{if(r.paused)return 'متوقف';const n=all.filter(t=>t.routine===r.id&&t.status==='scheduled'&&t.at>now).sort((a,b)=>a.at-b.at)[0];if(!n)return '—';const mins=Math.round((n.at-now)/H.MIN);return mins<120?`التالي بعد ${mins} دقيقة`:`التالي ${H.rel(n.at)} ${H.hm(n.at)}`;};
  const rs=all.filter(t=>t.routine&&t.status!=='cancelled');
  const rpanel=C.routines?`<div class="rpanel"><input class="inp" id="calq" placeholder="ابحث في المهام والروتينات…" value="${E(C.q)}"><div class="tm">${rs.length} تشغيل روتيني · ${rs.filter(t=>t.status==='scheduled').length} مجدولة · ${rs.filter(t=>t.status==='done').length} منجزة</div>
   <div class="h4" style="margin-top:4px">الروتينات ${R.length}</div>${rq.map(r=>{const p=policyOf(r.action);return `<button class="rcard" data-rt="${r.id}" style="--ac:${META[r.dept].c}"><span class="r1">${E(r.title)}</span><span class="r2">${FREQ_LABEL(r)} · ${r.time} · ${E(r.agent)}</span><span class="r3">${nextRun(r)}${p&&p.mode!=='auto'?' · <span class="warn">قد يحتاج موافقتك</span>':''}</span></button>`;}).join('')}</div>`:'';
  const html=`<div class="lhead"><h2>التقويم</h2><div class="seg" id="calview"><button data-v="week" class="${C.view==='week'?'on':''}">أسبوع</button><button data-v="month" class="${C.view==='month'?'on':''}">شهر</button></div>
   <button class="pill sm" data-cal="prev" aria-label="السابق">▶</button><strong style="font:700 17px var(--serif);min-width:150px;text-align:center">${label}</strong><button class="pill sm" data-cal="next" aria-label="التالي">◀</button><button class="pill sm" data-cal="today">اليوم</button>
   <span class="kbd">← → تنقّل · W M العرض · T اليوم · Esc إغلاق</span><span class="sp"></span><button class="pill" data-close-layer>إغلاق</button></div>
   <div class="dchips">${DEPTS.map(d=>`<button class="dchip${C.hidden.has(d.id)?' offd':''}" data-cd="${d.id}" style="--ac:${META[d.id].c}">${E(d.name)}</button>`).join('')}
    <button class="chip${C.routines?' on':''}" data-cx="routines">⊙ الروتينات</button><button class="chip${C.done?' on':''}" data-cx="done">✓ المنجز</button><button class="chip${C.onlyWait?' on':''}" data-cx="wait">🔒 بانتظار الموافقة فقط</button></div>
   <div class="calbody"><div class="calmain">${grid}</div>${rpanel}</div>`;
  const el=$('#cal');if(el._h!==html){const f=document.activeElement&&document.activeElement.id==='calq',pos=f?document.activeElement.selectionStart:0;const cm=el.querySelector('.calmain'),st=cm?cm.scrollTop:0;el.innerHTML=html;el._h=html;
   const ncm=el.querySelector('.calmain');if(ncm)ncm.scrollTop=st;if(f){const i=$('#calq');i.focus();i.setSelectionRange(pos,pos);}}},
 calNav(dir){const C=this.cal,d=new Date(C.cursor);if(C.view==='month'){d.setDate(1);d.setMonth(d.getMonth()+dir);}else d.setDate(d.getDate()+7*dir);C.cursor=d.getTime();this.render();},
 setCalView(v){this.cal.view=v;prefs.calView=v;savePrefs();this.render();},
 routineHtml(r){return `<h2>${E(r.title)}</h2><div class="sub">${E(r.agent)} · ${E(DEPT[r.dept].name)}</div>
  <dl class="kv"><dt>التكرار</dt><dd>${FREQ_LABEL(r)}</dd><dt>الوقت</dt><dd class="mono">${r.time}</dd><dt>نوع الفعل</dt><dd>${E(ACTION_LABEL[r.action])}</dd><dt>الحالة</dt><dd>${r.paused?'<span class="warn">متوقف</span>':'يعمل'}</dd></dl>
  <div class="row" style="margin-top:12px"><span class="lbl">تعديل الوقت</span><input type="time" class="inp mono" id="rt-time" value="${r.time}"><button class="pill sm" id="rt-savetime">حفظ الوقت</button></div>
  <div class="acts"><button class="pill primary" data-primary data-r="toggle">${r.paused?'استئناف':'إيقاف'}</button><button class="pill" data-r="edit">تعديل كامل</button><button class="pill" data-r="run">تشغيل الآن</button><button class="pill danger" data-r="del">حذف</button><button class="pill" data-m="close">إغلاق</button></div>`;},
 openRoutine(id){const r=store.routines.find(x=>x.id===id);if(!r)return;this.openModal(this.routineHtml(r),{kind:'rt',id,refresh:()=>{const x=store.routines.find(y=>y.id===id);if(x)this.setModal(this.routineHtml(x));else this.closeModal();}});},
 async routineAction(a){const id=this.modal.id,r=store.routines.find(x=>x.id===id);if(!r)return;if(a==='edit'){this.closeModal();return this.openRoutineEdit(id);}
  if(a==='toggle'){await call('updateRoutine',id,{paused:!r.paused});this.toast(r.paused?'استُؤنف الروتين':'أُوقف الروتين');}
  if(a==='run'){await call('runRoutine',id);this.toast('بدأ تشغيل الروتين');}
  if(a==='del')this.confirm(`حذف الروتين «${r.title}» وإلغاء تشغيلاته المجدولة؟`,async()=>{await call('deleteRoutine',id);this.toast('حُذف الروتين');});
  if(a==='time'){const v=$('#rt-time').value;if(/^\d\d:\d\d$/.test(v)){await call('updateRoutine',id,{time:v});this.toast('حُفظ الوقت وأُعيدت الجدولة');}}}
});

/* ============ events wiring ============ */
function wire(){
 $('#engine').addEventListener('click',()=>call('setRunning',!store.running));
 $('#calbtn').addEventListener('click',()=>UI.openLayer('cal'));
 $('#prodbtn').addEventListener('click',()=>UI.openLayer('prod'));
 $('#alertbtn').addEventListener('click',e=>UI.openDrop('alerts',e.currentTarget));
 $('#apbtn').addEventListener('click',e=>UI.openDrop('approvals',e.currentTarget));
 $('#policybtn').addEventListener('click',()=>UI.openLayer('admin'));
 $('#briefbtn').addEventListener('click',()=>UI.openBrief());
 $('#back').addEventListener('click',()=>UI.overview());
 $('#zin').addEventListener('click',()=>Scene.zoomBy(1.25));$('#zout').addEventListener('click',()=>Scene.zoomBy(1/1.25));$('#zhome').addEventListener('click',()=>UI.overview());
 $('#kpis').addEventListener('click',e=>{const k=e.target.closest('.kpi');if(k)UI.focusDept(k.dataset.d);});
 $('#tools').addEventListener('click',e=>{const b=e.target.closest('.tool');if(!b)return;const t=TOOL[b.dataset.tool];if(!t)return;const c=store.connectors[t.id];
  const used=OPS.filter(d=>d.tools.includes(t.id)).map(d=>d.name).join('، ');const st=CONN_LABEL[c?c.state:'simulated']||'محاكاة';
  UI.toast(`${t.name}: ${st} — طريقة الربط: ${METHOD[t.m]} · تستخدمها: ${used}`);});
 document.addEventListener('click',e=>{const el=e.target;
  const pr=el.closest('[data-prod]');if(pr&&!el.closest('#drop')){e.stopPropagation();UI.openProduct(pr.dataset.prod);return;}
  const op=el.closest('[data-open]');if(op){UI.closeDrop();UI.openTask(op.dataset.open);return;}
  if(UI.drop&&!el.closest('#drop')&&!el.closest('#alertbtn')&&!el.closest('#apbtn'))UI.closeDrop();
  const al=el.closest('[data-al]');if(al){UI.alertAction(al.dataset.al,al.dataset.id);return;}
  if(el.closest('[data-close-layer]')){UI.closeLayers();UI.render();return;}});
 $('#modal').addEventListener('click',e=>{if(e.target.id==='modal')return UI.closeModal();const m=e.target.closest('[data-m]');if(m)return UI.modalAction(m.dataset.m);
  const b=e.target.closest('[data-b]');if(b){const k=b.dataset.b;UI.closeModal();if(k==='ap')UI.openDrop('approvals',$('#apbtn'));if(k==='al')UI.openDrop('alerts',$('#alertbtn'));if(k==='hist')UI.openBriefHistory();return;}
  const br=e.target.closest('[data-brief]');if(br)return UI.openBrief(br.dataset.brief);
  const r=e.target.closest('[data-r]');if(r)return UI.routineAction(r.dataset.r);if(e.target.id==='rt-savetime')return UI.routineAction('time');
  const sg=e.target.closest('[data-stage]');if(sg&&UI.modal&&UI.modal.kind==='prod'){call('updateProduct',UI.modal.id,{stage:sg.dataset.stage});UI.toast('نُقل المنتج إلى '+STAGE[sg.dataset.stage].name);return;}
  if(e.target.id==='ptask'&&UI.modal){const id=UI.modal.id;UI.closeModal();UI.closeLayers();UI.render();$('#c-prod').value=id;$('#c-text').focus();}});
 $('#modal').addEventListener('focusout',e=>{if(e.target.id==='pnote'&&UI.modal&&UI.modal.kind==='prod'){const p=prodById(UI.modal.id);if(p&&p.note!==e.target.value)call('updateProduct',p.id,{note:e.target.value}).then(()=>UI.toast('حُفظت الملاحظة'));}});
 $('#right').addEventListener('click',e=>{const f=e.target.closest('[data-f]');if(f){UI.filter=f.dataset.f;UI.showN=60;return UI.render();}
  if(e.target.id==='clrAgent'){UI.agentFilter=null;return UI.render();}if(e.target.id==='moreT'){UI.showN+=60;return UI.render();}
  const a=e.target.closest('[data-a]');const card=e.target.closest('.task');if(a&&card)return UI.taskAction(card.dataset.id,a.dataset.a);
  if(card&&!e.target.closest('a'))UI.openTask(card.dataset.id);});
 $('#right').addEventListener('keydown',e=>{if(e.key==='Enter'&&e.target.classList.contains('task'))UI.openTask(e.target.dataset.id);});
 $('#left').addEventListener('click',e=>{const ag=e.target.closest('[data-agent]');if(ag){UI.agentFilter=UI.agentFilter===ag.dataset.agent?null:ag.dataset.agent;return UI.render();}
  const q=e.target.closest('[data-q]');if(q)return UI.ask(q.dataset.q);if(e.target.id==='askbtn')UI.ask($('#askin').value.trim());});
 $('#left').addEventListener('keydown',e=>{if(e.target.id==='askin'&&e.key==='Enter'){e.preventDefault();UI.ask(e.target.value.trim());}});
 $('#products').addEventListener('click',e=>{if(e.target.id==='newprod')UI.openNewProduct();});
 $('#cal').addEventListener('click',e=>{const C=UI.cal;const v=e.target.closest('#calview button');if(v)return UI.setCalView(v.dataset.v);
  const n=e.target.closest('[data-cal]');if(n){const k=n.dataset.cal;if(k==='today'){C.cursor=Date.now();UI.render();}else UI.calNav(k==='next'?1:-1);return;}
  const cd=e.target.closest('[data-cd]');if(cd){const id=cd.dataset.cd;C.hidden.has(id)?C.hidden.delete(id):C.hidden.add(id);prefs.calHidden=[...C.hidden];savePrefs();return UI.render();}
  const cx=e.target.closest('[data-cx]');if(cx){const k=cx.dataset.cx;if(k==='routines')C.routines=!C.routines;if(k==='done')C.done=!C.done;if(k==='wait')C.onlyWait=!C.onlyWait;return UI.render();}
  const wk=e.target.closest('[data-wk]');if(wk){C.cursor=+wk.dataset.wk;return UI.setCalView('week');}
  const rt=e.target.closest('[data-rt]');if(rt)UI.openRoutine(rt.dataset.rt);});
 $('#cal').addEventListener('input',e=>{if(e.target.id==='calq'){UI.cal.q=e.target.value;UI.renderCal();}});
 wireAdmin();
 $('#foot').addEventListener('click',e=>{if(e.target.id==='logoutbtn'){auth.logout().finally(()=>location.reload());return;}if(e.target.id==='exportbtn')UI.exportData();});
 document.addEventListener('keydown',e=>{const inField=/INPUT|TEXTAREA|SELECT/.test((document.activeElement||{}).tagName||'');
  if(e.key==='Escape'){if(UI.modal)return UI.closeModal();if(UI.drop)return UI.closeDrop();if(UI.layer){UI.closeLayers();return UI.render();}if(UI.focus)return UI.overview();return;}
  if(inField||UI.modal||UI.layer!=='cal')return;const k=e.key.toLowerCase();
  if(e.key==='ArrowLeft')UI.calNav(1);else if(e.key==='ArrowRight')UI.calNav(-1);else if(k==='w')UI.setCalView('week');else if(k==='m')UI.setCalView('month');else if(k==='t'){UI.cal.cursor=Date.now();UI.render();}});
 setInterval(()=>{$('#clock').textContent=H.clock(Date.now());},1000);$('#clock').textContent=H.clock(Date.now());
 setInterval(()=>UI.schedule(),30000);
}

/* ============ boot ============ */
/** Owner sign-in (password → HttpOnly session cookie). The password never touches page storage. */
function showLogin(msg){return new Promise(res=>{const b=$('#boot');b.classList.remove('gone');
  b.innerHTML=`<form id="login" style="display:flex;flex-direction:column;gap:12px;width:340px;font:500 13px var(--sans);text-align:start">
   <div style="display:flex;align-items:center;gap:10px"><div class="mark" style="width:36px;height:36px;border-radius:11px;background:linear-gradient(145deg,#FFD27A,#FFB066);display:grid;place-items:center;color:#1d2052;font:700 22px/1 var(--serif)">و</div><div style="font:700 26px var(--serif);color:var(--ink)">شركة الوكلاء</div></div>
   <div class="muted">أدخل كلمة مرور المالك للدخول إلى المنصة.</div>${msg?'<div class="bad">'+E(msg)+'</div>':''}
   <input class="inp mono" id="lg-t" type="password" autocomplete="current-password" dir="ltr" required aria-label="كلمة مرور المالك" style="padding:10px 12px">
   <button class="pill primary" id="lg-go" style="justify-content:center;padding:9px 14px">دخول</button></form>`;
  $('#login').addEventListener('submit',async e=>{e.preventDefault();const btn=$('#lg-go');btn.disabled=true;const err=await auth.login($('#lg-t').value);
   if(err){btn.disabled=false;const f=$('#login');let m=f.querySelector('.bad');if(!m){m=document.createElement('div');m.className='bad';f.insertBefore(m,$('#lg-t'));}m.textContent=err;$('#lg-t').select();return;}
   b.textContent='جارٍ تجهيز الشركة…';res();});
  setTimeout(()=>{const i=$('#lg-t');if(i)i.focus();},50);});}
async function boot(){wire();UI.buildComposer();Viz.init();Overlay.init();
 window.addEventListener('agents:unauthorized',()=>{if(store.ready)location.reload();});
 window.addEventListener('message',e=>{if(e.origin===location.origin&&e.data&&e.data.type==='agents:oauth')UI.toast(e.data.ok?'اكتمل التفويض ونجح اختبار الموصل':'لم يكتمل التفويض؛ راجع سجل الموصل');});
 let me=null;
 for(;;){try{me=await auth.me();break;}catch(e){$('#boot').textContent='تعذّر الوصول للخادم، أُعيد المحاولة خلال 5 ثوانٍ';await new Promise(r=>setTimeout(r,5000));}}
 if(!me.ownerConfigured){$('#boot').textContent='لم تُضبط كلمة مرور المالك بعد. شغّل على الخادم: pnpm --filter @agents/server cli set-password';return;}
 if(!me.authenticated)await showLogin('');
 let snap=null;
 for(;;){try{snap=await adapter.load();break;}catch(e){if(e&&e.status===401){await showLogin('انتهت الجلسة؛ سجّل الدخول مجددًا');continue;}
  $('#boot').textContent='تعذّر الوصول للخادم، أُعيد المحاولة خلال 5 ثوانٍ';await new Promise(r=>setTimeout(r,5000));}}
 adapter.subscribe(onEvent);
 applySnapshot(snap);Overlay.rebuildTags();UI.loadDraft();
 try{Scene.init();}catch(e){console.error(e);UI.toast('تعذّر تشغيل العرض ثلاثي الأبعاد على هذا الجهاز');}
 UI.configChanged();UI.render();$('#boot').classList.add('gone');
 const b=store.briefs[0];if(b)UI.briefArrived(b);}
boot();

export { wire, showLogin, boot };
