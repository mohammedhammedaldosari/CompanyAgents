/* Ported from the Claude Design prototype (e-ui.js); logic kept intact, wired as an ES module. */
import { AGENT_META, CONFIG, CONN_LABEL, CORE_TOOLS, DEPT, DEPTS, H, LVL_LABEL, META, OPS, QUESTIONS, SETTINGS, STATUS_LABEL, TOOL, margin, toolIcon } from '../core/runtime.ts';
import { adapter, hooks } from '../core/adapter.ts';
import { Overlay, Scene, activeAlerts, busyAgents, deptStats, prodById, store, tasksArr } from './scene.js';

/* ============ UI ============ */
const $=s=>document.querySelector(s);
const PREF_KEY='agents-company-v4-ui';
const prefs=(()=>{try{return JSON.parse(localStorage.getItem(PREF_KEY))||{};}catch(e){return {};}})();
const savePrefs=()=>{try{localStorage.setItem(PREF_KEY,JSON.stringify(prefs));}catch(e){}};
const E=H.esc;
const call=async(fn,...a)=>{try{return await adapter[fn](...a);}catch(e){if(CONFIG.mode==='sim')UI.toast(e.message||'حدث خطأ');return null;}};

const UI={focus:null,layer:null,hot:null,filter:'all',agentFilter:null,showN:60,modal:null,drop:null,
 cal:{view:prefs.calView||'month',cursor:Date.now(),hidden:new Set(prefs.calHidden||[]),routines:false,done:true,onlyWait:false,q:''},
 _t:null,
 schedule(){if(this._t)return;this._t=setTimeout(()=>{this._t=null;this.render();},100);},
 toast(msg){const t=$('#toast');t.textContent=msg;t.classList.add('show');clearTimeout(this._tt);this._tt=setTimeout(()=>t.classList.remove('show'),2200);},
 hover(d){if(this.hot===d)return;this.hot=d;this.renderCards();},
 brainLine(s){this._bl=s;Overlay.brain(store.notes,s);},
 focusDept(d){if(!d||d==='core')return;this.closeLayers();this.focus=d;this.agentFilter=null;this.showN=60;$('#main').classList.add('focus');Scene.focusOn(d);
  const sel=$('#c-dept');if(sel)sel.value=d;call('greet',d);this._toolsKey='';this.render();},
 overview(){this.focus=null;this.agentFilter=null;$('#main').classList.remove('focus');Scene.overview();const sel=$('#c-dept');if(sel)sel.value='auto';this._toolsKey='';this.render();},
 closeLayers(){this.layer=null;['#cal','#products','#admin'].forEach(i=>$(i).classList.remove('open'));['#calbtn','#prodbtn','#policybtn'].forEach(b=>$(b).classList.remove('on'));},
 openLayer(n){const was=this.layer===n;this.closeLayers();if(was){this.render();return;}this.layer=n;const L={cal:['#cal','#calbtn'],prod:['#products','#prodbtn'],admin:['#admin','#policybtn']}[n];
  $(L[0]).classList.add('open');$(L[1]).classList.add('on');if(n==='admin'){this.adm.lastR=0;$('#admin')._h='';this.renderAdmin(true);}this.render();},
 configChanged(){if(!store.ready)return;const k=DEPTS.map(d=>d.id+':'+d.agents.join('|')).join(';');
  if(this._sceneKey!==k){const first=this._sceneKey==null;this._sceneKey=k;if(!first){try{Scene.rebuild();}catch(err){console.error(err);}Overlay.rebuildTags();}}
  this._toolsKey='';this._pk='';const sel=$('#c-dept');if(sel)sel.querySelectorAll('option').forEach(o=>{const d=DEPT[o.value];if(d){o.textContent=d.name;o.disabled=d.enabled===false;}});
  $('#left')._h='';if(this.layer==='admin')this.adm.lastR=0;this.schedule();},

 render(){if(!store.ready)return;this.renderHeader();this.renderPulse();this.renderCards();this.renderRight();if(this.focus)this.renderLeft();
  if(this.layer==='cal')this.renderCal();if(this.layer==='prod')this.renderProducts();if(this.layer==='admin')this.renderAdmin();
  Scene.setBusy(busyAgents());this.renderTags();Overlay.brain(store.notes,this._bl);
  if(this.modal&&this.modal.refresh&&!$('#modal').contains(document.activeElement&&/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)?document.activeElement:null))this.modal.refresh();
  if(this.drop&&this.drop.refresh)this.drop.refresh();this.renderFooter();},

 /* header */
 renderHeader(){const f=this.focus;const ids=(f?DEPT[f].tools:CORE_TOOLS).filter(id=>TOOL[id]);const cs=id=>(store.connectors[id]||{}).state||'simulated';const key=ids.map(id=>id+cs(id)).join();
  if(this._toolsKey!==key){this._toolsKey=key;$('#tools').innerHTML=ids.map(id=>{const t=TOOL[id],s=cs(id);return `<button class="tool${t.core?'':' sec'}" data-tool="${id}" title="${E(t.name)} · ${CONN_LABEL[s]||''}" aria-label="${E(t.name)}">${toolIcon(t)}${s!=='simulated'?`<i class="sd s-${s}"></i>`:''}</button>`;}).join('');}
  $('#policybtn').classList.toggle('b-wait',this.draftChanges().length>0);
  const eng=$('#engine');eng.classList.toggle('off',!store.running);eng.querySelector('.t').textContent=store.running?'يعمل في الخلفية على ✳':'متوقف · اضغط للاستئناف';
  const A=activeAlerts(),ab=$('#alertbtn');ab.querySelector('span').textContent=A.length;ab.classList.toggle('b-alert',A.some(a=>a.level==='critical'));ab.classList.toggle('b-wait',!A.some(a=>a.level==='critical')&&A.some(a=>a.level==='warning'));
  const W=tasksArr().filter(t=>t.status==='waiting').length,ap=$('#apbtn');ap.querySelector('span').textContent=W;ap.classList.toggle('b-wait',W>0);
  const b=store.briefs[0],bb=$('#briefbtn');const unread=b&&!b.read;if(!!bb.querySelector('.gd')!==!!unread)bb.innerHTML=(unread?'<span class="gd"></span>':'')+'الإيجاز الصباحي';},

 /* pulse bar */
 renderPulse(){const K=store.kpi;if(K.salesToday==null)return;const now=Date.now(),f=(now-H.dayStart(now))/H.DAY;
  const cmp=(v,y)=>{if(!y||y<100)return '<span class="muted">—</span>';const d=(v-y)/y*100;if(Math.abs(d)>999)return '<span class="muted">—</span>';return `<span class="${d>=0?'up':'down'}">${d>=0?'▲':'▼'} ${H.p1(Math.abs(d))}%</span>`;};
  const acos=K.salesToday?K.adSpendToday/K.salesToday*100:0;const exp=((store.metrics.finance||[0,2865000])[1]||2865000)/30;
  const cards=[
   ['sales','amazon','مبيعات اليوم',K.salesToday,`${cmp(K.salesToday,K.salesYesterday*f)} مقابل أمس · ${K.ordersToday} طلبًا`],
   ['profit','amazon','صافي الربح اليوم',K.profitToday,`${cmp(K.profitToday,K.profitYesterday*f)} · الهامش ${H.p1(K.salesToday?K.profitToday/K.salesToday*100:0)}%`],
   ['ads','marketing','الإنفاق الإعلاني',K.adSpendToday,`نسبة الإعلان للمبيعات <span class="${acos>SETTINGS.acosWarn?'bad':acos>SETTINGS.acosWarn*.8?'warn':''}">${H.p1(acos)}%</span>`],
   ['cash','finance','النقد المتاح',K.cash,`تكفي ${H.num(K.cash/exp)} يومًا`]];
  const root=$('#kpis');if(!root.children.length)root.innerHTML=cards.map(c=>`<button class="kpi" data-k="${c[0]}" data-d="${c[1]}"><div><div class="l">${c[2]}</div><div class="c"></div></div><div class="n"></div></button>`).join('');
  this._kv=this._kv||{};cards.forEach(c=>{const el=root.querySelector(`[data-k="${c[0]}"]`);const n=el.querySelector('.n');const txt=`${H.sarN(c[3])}<small>ر.س</small>`;
   if(n.innerHTML!==txt){n.innerHTML=txt;if(this._kv[c[0]]!=null){n.classList.add('flash');setTimeout(()=>n.classList.remove('flash'),400);}this._kv[c[0]]=c[3];}
   const cc=el.querySelector('.c');if(cc.innerHTML!==c[4])cc.innerHTML=c[4];});},

 /* dept cards on stage */
 renderCards(){const A=activeAlerts();OPS.forEach(d=>{const st=deptStats(d.id),m=store.metrics[d.id]||[0,0];
  const alert=A.some(a=>a.dept===d.id&&a.level==='critical')||st.late>0;
  const fmt=(i)=>{const v=m[i];if(d.id==='finance'&&i===1)return H.sarN(v);if(/%/.test(d.metrics[i][0]))return H.p1(v);return H.num(v);};
  Overlay.setCard(d.id,`<div class="h"><span class="dot"></span>${E(d.name)}${alert?'<span class="adot" title="تنبيه"></span>':''}</div>
   <div class="big">${d.agents.length}<small>وكلاء</small></div>
   <div class="ms"><div class="m"><b>${fmt(0)}</b><span>${E(d.metrics[0][0])}</span></div><div class="m"><b>${fmt(1)}</b><span>${E(d.metrics[1][0])}</span></div></div>
   <div class="ln">يعمل ${st.run} · التالي ${st.next} · منجز ${st.done}</div>${st.wait?`<div class="wt">بانتظار الموافقة · ${st.wait}</div>`:''}${d.enabled===false?'<div class="wt" style="background:rgba(255,255,255,.06);color:var(--ink2);border-color:var(--line2)">معطّل مؤقتًا</div>':''}`,this.hot===d.id);});},
 renderTags(){const b=busyAgents();DEPTS.forEach(d=>d.agents.forEach((a,i)=>{const n=b.get(a)||0;Overlay.setTag(a,`${i===0&&d.id!=='core'?'<span class="st">★</span>':''}${E(a)}${n?`<span class="g"></span><span class="mono">${n}</span>`:''}`);}));},

 /* right: composer + tasks */
 buildComposer(){$('#composer').innerHTML=`
  <div class="row"><select class="sel" id="c-dept" aria-label="القسم" style="flex:1.3"><option value="auto">تلقائي عبر المدير التنفيذي</option>${OPS.map(d=>`<option value="${d.id}">${E(d.name)}</option>`).join('')}</select>
   <select class="sel" id="c-prod" aria-label="المنتج" style="flex:1"></select></div>
  <textarea class="inp" id="c-text" placeholder="اكتب مهمة للشركة… (Ctrl+Enter للإضافة)" aria-label="نص المهمة"></textarea>
  <div class="row"><span class="lbl">النموذج</span><div class="seg" id="c-model"><button data-v="SONNET" class="on">سونيت</button><button data-v="OPUS">أوبس</button><button data-v="HAIKU">هايكو</button></div>
   <span class="lbl">التنفيذ</span><div class="seg" id="c-mode"><button data-v="auto" class="on">تلقائي</button><button data-v="schedule">جدولة</button><button data-v="approve">بعد موافقتي</button></div></div>
  <div class="row" id="c-atrow" hidden><span class="lbl">الموعد</span><input type="datetime-local" class="inp" id="c-at" style="flex:1"></div>
  <div class="row" id="c-rep" hidden><span class="lbl">التكرار</span><select class="sel" id="c-freq"><option value="daily">كل يوم</option><option value="workdays" selected>أيام العمل</option><option value="weekly">كل أسبوع</option><option value="monthly1">أول كل شهر</option></select><input type="time" class="inp" id="c-time" value="09:00"></div>
  <div class="row"><button class="pill sm" id="c-repbtn" aria-pressed="false">⟳ تكرار</button><button class="pill sm" id="c-team" aria-pressed="false">الفريق</button><span class="sp" style="flex:1"></span><button class="pill primary" id="c-add">إضافة</button></div>`;
  const seg=id=>$(id).addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;$(id).querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===b));
   if(id==='#c-mode'){const s=b.dataset.v==='schedule';$('#c-atrow').hidden=!s;if(s&&!$('#c-at').value){const d=new Date(Date.now()+H.HOUR);d.setMinutes(0,0,0);$('#c-at').value=toLocalInput(d);}}});
  seg('#c-model');seg('#c-mode');
  const tog=id=>$(id).addEventListener('click',()=>{const on=$(id).getAttribute('aria-pressed')!=='true';$(id).setAttribute('aria-pressed',on);$(id).classList.toggle('on',on);if(id==='#c-repbtn')$('#c-rep').hidden=!on;});
  tog('#c-repbtn');tog('#c-team');
  $('#c-add').addEventListener('click',()=>this.submitTask());
  $('#c-text').addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();this.submitTask();}});},
 fillProducts(){const sel=$('#c-prod');if(!sel)return;const key=store.products.map(p=>p.id+p.name).join();if(this._pk===key)return;this._pk=key;const v=sel.value;
  sel.innerHTML=`<option value="">المنتج: بلا</option>`+store.products.map(p=>`<option value="${p.id}">${E(p.name)}</option>`).join('');sel.value=store.products.some(p=>p.id===v)?v:'';},
 async submitTask(){const title=$('#c-text').value.trim();if(!title){this.toast('اكتب المهمة أولًا');$('#c-text').focus();return;}
  const on=id=>$(id).getAttribute('aria-pressed')==='true';const mode=$('#c-mode .on').dataset.v;
  const i={title,dept:$('#c-dept').value,productId:$('#c-prod').value||null,model:$('#c-model .on').dataset.v,mode,team:on('#c-team'),
   at:mode==='schedule'&&$('#c-at').value?new Date($('#c-at').value).getTime():null,repeat:on('#c-repbtn')?{freq:$('#c-freq').value,time:$('#c-time').value||'09:00'}:null};
  const r=await call('createTask',i);if(r!==null||i.repeat){$('#c-text').value='';this.toast(i.repeat?'أُنشئ الروتين وجُدولت تشغيلاته':i.dept==='auto'?'أُرسلت المهمة للمدير التنفيذي للتوجيه':'أُضيفت المهمة');}},
 renderRight(){this.fillProducts();const f=this.focus;let T=tasksArr().filter(t=>t.status!=='cancelled'&&(!f||t.dept===f)&&(!this.agentFilter||t.agent===this.agentFilter));
  $('#tsh').innerHTML=`<h2>حالة المهام</h2><span class="muted">${f?E(DEPT[f].name):'المكتب كاملًا'}</span>${this.agentFilter?`<button class="chip on" id="clrAgent" style="margin-inline-start:auto">${E(this.agentFilter)} ×</button>`:''}`;
  const cnt={all:T.length,scheduled:0,backlog:0,progress:0,waiting:0,done:0};T.forEach(t=>cnt[t.status]=(cnt[t.status]||0)+1);
  const F=[['all','الكل'],['scheduled','مجدولة'],['backlog','مؤجلة'],['progress','قيد التنفيذ'],['waiting','بانتظار الموافقة'],['done','منجزة']];
  $('#filters').innerHTML=F.map(([k,l])=>`<button class="chip${this.filter===k?' on':''}" data-f="${k}">${l} <b>${cnt[k]||0}</b></button>`).join('');
  const now=Date.now(),nx=T.filter(t=>t.status==='scheduled'&&t.at>=now).sort((a,b)=>a.at-b.at)[0];
  $('#nextline').innerHTML=nx?`التالي ⊙ بعد ${Math.max(1,Math.round((nx.at-now)/H.MIN))} دقيقة · ${E(nx.title)}`:'التالي ⊙ لا مهام مجدولة';
  if(this.filter!=='all')T=T.filter(t=>t.status===this.filter);
  const ord={waiting:0,progress:1,scheduled:2,backlog:3,done:4};T.sort((a,b)=>ord[a.status]-ord[b.status]||(a.status==='done'?b.doneAt-a.doneAt:(a.at||9e15)-(b.at||9e15)));
  const shown=T.slice(0,this.showN);const html=shown.length?shown.map(t=>this.taskCard(t)).join('')+(T.length>shown.length?`<button class="pill sm more" id="moreT">عرض ${Math.min(60,T.length-shown.length)} أخرى من ${T.length}</button>`:''):'<div class="empty">لا مهام في هذا العرض.</div>';
  const tl=$('#tasklist');if(tl._h!==html){const st=tl.scrollTop;tl.innerHTML=html;tl._h=html;tl.scrollTop=st;}},
 taskCard(t){const ac=META[t.dept].c,p=t.productId&&prodById(t.productId);
  const badge=t.status==='progress'?`<span class="tb p">${Math.round(t.progress)}%</span>`:t.status==='waiting'?'<span class="tb w">انتظار</span>':t.status==='done'?'<span class="tb d">منجز</span>':t.status==='backlog'?'<span class="tb b">مؤجل</span>':'<span class="tb">○</span>';
  let when='';if(t.status==='waiting')when='<span class="warn">بانتظار موافقتك</span>';else if(t.status==='done')when=`أُنجزت ${H.rel(t.doneAt)} ${H.hm(t.doneAt)}`;else if(t.at)when=`${t.status==='progress'?'بدأت':'الموعد'} ${H.rel(t.at)} ${H.hm(t.at)}`;
  const B=[];if(t.status==='waiting')B.push(`<button class="pill xs approve" data-a="review">مراجعة</button>`,`<button class="pill xs danger" data-a="reject">رفض</button>`);
  else if(t.status==='done')B.push(`<button class="pill xs" data-a="result">النتيجة</button>`,`<button class="pill xs" data-a="cal">التقويم</button>`);
  else{B.push(`<button class="pill xs" data-a="cancel">إلغاء</button>`);B.push(t.status==='progress'?`<button class="pill xs" data-a="cal">التقويم</button>`:`<button class="pill xs" data-a="run">تشغيل الآن</button>`);}
  return `<div class="task${t.status==='waiting'?' w':''}" data-id="${t.id}" tabindex="0" style="--ac:${ac}">${badge}<div class="tx"><div class="tt">${E(t.title)}${t.team?' <span class="muted">· الفريق</span>':''}</div>
   <div class="tm"><span class="dd"></span>${E(t.agent)} · ${E(DEPT[t.dept].name)} · ${STATUS_LABEL[t.status]}</div>
   ${p?`<div class="tm">المنتج: <a data-prod="${p.id}">${E(p.name)}</a></div>`:''}${t.source?`<div class="tm">أُضيفت · من ${E(t.source)}</div>`:''}
   ${when?`<div class="tm">${when}</div>`:''}${t.status==='progress'?`<div class="bar"><i style="width:${Math.round(t.progress)}%"></i></div>`:''}<div class="tbtns">${B.join('')}</div></div></div>`;},
 async taskAction(id,a){const t=store.tasks.get(id);if(!t)return;
  if(a==='review'||a==='result')return this.openTask(id);if(a==='reject'){await call('reject',id);this.toast('رُفضت المهمة');}
  if(a==='cancel'){await call('cancelTask',id);this.toast('أُلغيت المهمة');}if(a==='run'){await call('runNow',id);this.toast('بدأ التشغيل الآن');}
  if(a==='cal'){this.cal.cursor=t.status==='done'?t.doneAt:(t.at||Date.now());this.cal.q='';if(this.layer!=='cal')this.openLayer('cal');else this.render();}},

 /* left: dept panel */
 renderLeft(){const d=this.focus,D=DEPT[d],st=deptStats(d),m=store.metrics[d]||[0,0],b=busyAgents(),ac=META[d].c;
  const fmt=i=>d==='finance'&&i===1?H.sar(m[i]):/%/.test(D.metrics[i][0])?H.p1(m[i])+'%':H.num(m[i]);
  const chat=(store.chats[d]||[]).map(x=>`<div class="bub${x.me?' me':''}">${x.me?'':`<span class="who">${E(D.agents[0])}</span>`}${E(x.text)}</div>`).join('');
  const W=tasksArr().filter(t=>t.dept===d&&t.status==='waiting'),A=activeAlerts().filter(a=>a.dept===d),ev=store.events.filter(e=>e.dept===d).slice(-8).reverse();
  const html=`<div class="lscroll" id="lscroll">
   <div class="dstat" style="--ac:${ac}"><div class="row" style="font-weight:700;font-size:13px"><span class="dot"></span>${E(D.name)}</div>
    <div class="ms" style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:10px 0 8px"><div class="m"><b style="font-size:17px">${fmt(0)}</b><span>${E(D.metrics[0][0])}</span></div><div class="m"><b style="font-size:17px">${fmt(1)}</b><span>${E(D.metrics[1][0])}</span></div></div>
    <div class="ln ink2" style="font-size:11px">يعمل ${st.run} · التالي ${st.next} · منجز ${st.done}</div></div>
   <div class="mgr"><h3>${E(D.agents[0])}</h3><div class="muted">المدير · ${E(D.name)}</div><div class="tm" style="margin-top:4px">${E((AGENT_META[D.agents[0]]||{}).role||'')}</div></div>
   <div><div class="h4">الفريق</div><div class="team">${D.agents.map(a=>`<button class="chip${this.agentFilter===a?' on':''}" data-agent="${E(a)}" title="${E((AGENT_META[a]||{}).role||'')}">${b.has(a)?'<span style="width:6px;height:6px;border-radius:50%;background:var(--ok);box-shadow:0 0 6px var(--ok)"></span>':''}${E(a)}${(AGENT_META[a]||{}).status==='paused'?' ⏸':''}</button>`).join('')}</div></div>
   <div class="chat">${chat||'<div class="muted">…</div>'}</div>
   <div class="sep">— بث العمل الحي في الأسفل</div>
   ${W.length?`<div><div class="h4">الموافقات المنتظرة</div><div style="display:flex;flex-direction:column;gap:6px">${W.map(t=>`<button class="draftbtn" data-open="${t.id}"><b>${E(t.artifact?t.artifact.name:t.title)}</b><span>بانتظار موافقتك · اضغط للعرض</span></button>`).join('')}</div></div>`:''}
   ${A.length?`<div><div class="h4">تنبيهات القسم</div>${A.map(a=>`<div class="lrow" style="padding:6px 0"><span class="lvl ${a.level}">${LVL_LABEL[a.level]}</span><span style="font-size:11px">${E(a.title)}</span></div>`).join('')}</div>`:''}
   <div><div class="h4">بث العمل</div><div class="feed">${ev.length?ev.map(e=>`<div>${H.hm(e.t)} ${E(e.agent)} ${E(e.text)}</div>`).join(''):'<div>بانتظار الخطوة التالية…</div>'}</div></div></div>
  <div class="lfoot"><div class="row">${(QUESTIONS[d]||[]).map(q=>`<button class="pill xs" data-q="${E(q)}">${E(q)}</button>`).join('')}</div>
   <div class="row" style="flex-wrap:nowrap"><input class="inp" id="askin" style="flex:1" placeholder="اسأل هذا القسم… (مهمة: …)" aria-label="سؤال للقسم"><button class="pill primary sm" id="askbtn">إرسال</button></div></div>`;
  const L=$('#left');if(L._h===html)return;const inp=$('#askin'),val=inp?inp.value:'',foc=document.activeElement===inp;const sc=$('#lscroll');const atBottom=!sc||sc.scrollTop+sc.clientHeight>=sc.scrollHeight-30;const prev=sc?sc.scrollTop:0;
  L.innerHTML=html;L._h=html;const ni=$('#askin');ni.value=val;if(foc)ni.focus();const ns=$('#lscroll');ns.scrollTop=L._d===d&&!atBottom?prev:0;L._d=d;},
 async ask(q){if(!q||!this.focus)return;$('#askin').value='';await call('ask',this.focus,q);},

 renderFooter(){const f=$('#foot');const h=`<span>شركة الوكلاء · الإصدار 4 · ${CONFIG.mode==='live'?'متصل بالخادم':'محاكاة'}</span><span class="sp"></span>${CONFIG.mode==='live'?'<button class="pill xs" id="logoutbtn">خروج</button>':''}<button class="pill xs" id="exportbtn">تصدير البيانات</button>`;if(f._h!==h){f.innerHTML=h;f._h=h;}},
 async exportData(){const s=await call('exportState');if(!s)return;s.exportedAt=Date.now();
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(s,null,2)],{type:'application/json'}));a.download='agents-company-'+H.dayKey(Date.now())+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);this.toast('صُدّرت البيانات');}
};
function toLocalInput(d){return `${d.getFullYear()}-${H.pad(d.getMonth()+1)}-${H.pad(d.getDate())}T${H.pad(d.getHours())}:${H.pad(d.getMinutes())}`;}

// the adapter reports failures through the UI's toast
hooks.toast=m=>UI.toast(m);

export { $, PREF_KEY, prefs, savePrefs, E, call, UI, toLocalInput };
