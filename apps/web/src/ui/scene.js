/* Ported from the Claude Design prototype (d-scene.js); logic kept intact, wired as an ES module. */
import * as THREE from 'three';
import { ACTION_LABEL, DEPT, DEPTS, H, META, OPS, applyConfig, reduced } from '../core/runtime.js';
import { adapter } from '../core/adapter.js';
import { $, UI } from './ui.js';

/* ============ store (UI copy — mutated only by adapter events) ============ */
const store={tasks:new Map(),routines:[],products:[],alerts:[],policies:[],kpi:{},metrics:{},chats:{},briefs:[],events:[],notes:0,running:true,ready:false,config:null,configHistory:[],audit:[],usage:null,connectors:{}};
const tasksArr=()=>Array.from(store.tasks.values());
const prodById=id=>store.products.find(p=>p.id===id);
function applySnapshot(s){s=s||{};store.tasks=new Map((s.tasks||[]).map(t=>[t.id,t]));store.routines=s.routines||[];store.products=s.products||[];store.alerts=s.alerts||[];
 store.policies=s.policies||[];store.kpi=s.kpi||{};store.metrics=s.metrics||{};store.chats=s.chats||{};store.briefs=s.briefs||[];store.events=(s.events||[]).slice(-150);
 store.notes=s.notes||0;store.running=s.running!==false;store.ready=true;store.base=s.base||{};
 store.config=s.config||null;store.configHistory=s.configHistory||[];store.audit=s.audit||[];store.usage=s.usage||null;store.connectors=s.connectors||{};if(store.config)applyConfig(store.config);}
const upsert=(arr,o)=>{const i=arr.findIndex(x=>x.id===o.id);if(i<0)arr.push(o);else arr[i]=o;};
function onEvent(e){switch(e.type){
 case 'snapshot':applySnapshot(e.state);UI.configChanged();break;
 case 'config':store.config=e.config;applyConfig(e.config);UI.configChanged();break;
 case 'audit':store.audit.unshift(e.entry);if(store.audit.length>400)store.audit.length=400;break;
 case 'usage':store.usage=e.usage;break;
 case 'connectors':store.connectors=e.connectors;break;
 case 'task.upsert':store.tasks.set(e.task.id,e.task);break;
 case 'task.remove':store.tasks.delete(e.id);break;
 case 'routine.upsert':upsert(store.routines,e.routine);break;
 case 'routine.remove':store.routines=store.routines.filter(r=>r.id!==e.id);break;
 case 'product.upsert':upsert(store.products,e.product);break;
 case 'alert.upsert':upsert(store.alerts,e.alert);break;
 case 'kpi':store.kpi=e.kpi;break;
 case 'metric':store.metrics[e.dept]=e.values;break;
 case 'notes':store.notes=e.count;break;
 case 'activity':store.events.push(e.event);if(store.events.length>150)store.events.shift();Viz.activity(e);break;
 case 'chat':(store.chats[e.dept]=store.chats[e.dept]||[]).push(e.message);break;
 case 'brief':{const i=store.briefs.findIndex(b=>b.id===e.brief.id);if(i<0){store.briefs.unshift(e.brief);UI.briefArrived(e.brief);}else store.briefs[i]=e.brief;break;}
 case 'policies':store.policies=e.policies;break;
 case 'running':store.running=e.on;break;}
 UI.schedule();}

/* derived */
function deptStats(d){const now=Date.now(),end=H.dayStart(now)+H.DAY,ds=H.dayStart(now);let run=0,next=0,done=0,wait=0,late=0;
 for(const t of store.tasks.values()){if(d&&t.dept!==d)continue;
  if(t.status==='progress')run++;else if(t.status==='waiting')wait++;
  else if(t.status==='scheduled'){if(t.at>=now&&t.at<end)next++;if(t.at<now-45*H.MIN)late++;}
  else if(t.status==='done'&&t.doneAt>=ds)done++;}
 return {run,next,done,wait,late};}
const busyAgents=()=>{const s=new Map();for(const t of store.tasks.values())if(t.status==='progress')s.set(t.agent,(s.get(t.agent)||0)+1);return s;};
const activeAlerts=()=>store.alerts.filter(a=>!a.dismissed);
const policyOf=a=>store.policies.find(p=>p.action===a);
function approvalReason(t){if(t.approvalReason)return t.approvalReason;const p=policyOf(t.action);const lbl=ACTION_LABEL[t.action]||'هذا الفعل';
 if(p&&p.mode==='limit'&&t.value!=null){const v=p.unit==='SAR'?H.sar(t.value):(t.value>0?'+':'')+t.value+'%';return `تحتاج موافقتك لأن ${lbl} (${v}) تجاوز الحد ${p.limit}${p.unit==='%'?'%':' ر.س'}`;}
 if(p&&p.mode==='always')return t.action==='payment'?'الدفعات تحتاج موافقتك دائمًا، والوكلاء يجهّزونها ولا ينفذونها':`${lbl} يحتاج موافقتك دائمًا`;
 return 'طلبت أن تُنفَّذ هذه المهمة بعد موافقتك';}
function valueDesc(t){if(t.value==null)return ACTION_LABEL[t.action]||'';if(t.action==='price_change')return 'سعر '+(t.value>0?'+':'')+t.value+'%';if(t.action==='ad_budget')return 'ميزانية +'+t.value+'%';return H.sar(t.value);}

/* ============ 3D scene ============ */
const Scene=(function(){
 const OFF=new THREE.Vector3(30,30,30),VIEW=44;
 let renderer,scene,cam,W=1,Hh=1,fitZoom=1;const target=new THREE.Vector3(),goal=new THREE.Vector3(),overviewTarget=new THREE.Vector3();let zoomCur=1,zoomGoal=1;
 const people=[];const ray=new THREE.Raycaster(),mouse=new THREE.Vector2(),pickables=[],desks=[],deskBy={};let ring,ico,coreBall,stageEl,canvas;
 const matCache={};const M=(c,o)=>{const k=c+JSON.stringify(o||{});return matCache[k]||(matCache[k]=new THREE.MeshStandardMaterial(Object.assign({color:c,roughness:.85,metalness:0},o||{})));};
 const mesh=(g,m,x,y,z,shadow=true)=>{const o=new THREE.Mesh(g,m);o.position.set(x,y,z);o.castShadow=shadow;o.receiveShadow=true;return o;};
 function rr(w,h,r){const s=new THREE.Shape(),x=-w/2,y=-h/2;s.moveTo(x+r,y);s.lineTo(x+w-r,y);s.quadraticCurveTo(x+w,y,x+w,y+r);s.lineTo(x+w,y+h-r);s.quadraticCurveTo(x+w,y+h,x+w-r,y+h);s.lineTo(x+r,y+h);s.quadraticCurveTo(x,y+h,x,y+h-r);s.lineTo(x,y+r);s.quadraticCurveTo(x,y,x+r,y);return s;}
 function platform(d){const m=META[d];const g=new THREE.ExtrudeGeometry(rr(7.2,7.2,.55),{depth:1,bevelEnabled:true,bevelThickness:.08,bevelSize:.08,bevelSegments:2,curveSegments:10});
  g.rotateX(-Math.PI/2);g.translate(0,-1,0);const o=new THREE.Mesh(g,[M(m.top),M(m.side)]);o.position.set(m.x,0,m.z);o.receiveShadow=true;o.castShadow=true;o.userData.dept=d;scene.add(o);pickables.push(o);}
 function desk(dept,agent,x,z,y,mgr){const g=new THREE.Group();g.position.set(x,y,z);g.rotation.y=Math.PI/4;const m=META[dept];
  g.add(mesh(new THREE.BoxGeometry(1.55,.08,.9),M(0xe3d6bf),0,.78,0));
  const leg=new THREE.CylinderGeometry(.035,.035,.78,8);[[.68,.36],[-.68,.36],[.68,-.36],[-.68,-.36]].forEach(([a,b])=>g.add(mesh(leg,M(0x2b2b36),a,.39,b)));
  g.add(mesh(new THREE.BoxGeometry(.4,.03,.2),M(0x23242e),0,.835,-.25));g.add(mesh(new THREE.BoxGeometry(.07,.36,.06),M(0x23242e),0,1.0,-.27));
  g.add(mesh(new THREE.BoxGeometry(1.2,.76,.06),M(0x23242e),0,1.42,-.24));
  const cv=document.createElement('canvas');cv.width=160;cv.height=100;const tex=new THREE.CanvasTexture(cv);const scr=new THREE.Mesh(new THREE.PlaneGeometry(1.1,.66),new THREE.MeshBasicMaterial({map:tex}));scr.position.set(0,1.42,-.205);g.add(scr);
  g.add(mesh(new THREE.CylinderGeometry(.3,.3,.07,20),M(0x2e3044),0,.47,.66));g.add(mesh(new THREE.CylinderGeometry(.04,.04,.42,8),M(0x2b2b36),0,.24,.66));
  g.add(mesh(new THREE.BoxGeometry(.56,.34,.07),M(0x2e3044),0,.72,.95));
  const tc=mgr?new THREE.Color(m.c).multiplyScalar(.55).getHex():0x4a4f6a;const torso=mesh(new THREE.CylinderGeometry(.19,.25,.52,16),M(tc),0,.78,.62);g.add(torso);
  const head=mesh(new THREE.SphereGeometry(.2,16,12),M(0x3a2c28),0,1.2,.6);g.add(head);
  scene.add(g);people.push(g);const ref={dept,agent,mgr,g,torso,head,cv,ctx:cv.getContext('2d'),tex,seed:Math.random()*100,anchor:new THREE.Vector3(),busy:false};
  g.updateMatrixWorld(true);ref.anchor.copy(g.localToWorld(new THREE.Vector3(0,2.05,-.24)));desks.push(ref);deskBy[agent]=ref;drawScreen(ref,0);}
 function plant(x,z,s){const g=new THREE.Group();g.position.set(x,.08,z);g.scale.setScalar(s);g.add(mesh(new THREE.CylinderGeometry(.28,.22,.4,16),M(0xcfc3b0),0,.2,0));
  g.add(mesh(new THREE.IcosahedronGeometry(.45,0),M(0x3f8f5a),0,.78,0));g.add(mesh(new THREE.IcosahedronGeometry(.32,0),M(0x3f8f5a),.22,1.12,.08));return g;}
 function prop(d,px,pz){const m=META[d],x=m.x+px,z=m.z+pz,y=.08,g=new THREE.Group();
  if(d==='exec'){g.add(mesh(new THREE.BoxGeometry(1.8,.08,1),M(0x6b5a3a),x,y+.6,z));const l=new THREE.CylinderGeometry(.04,.04,.6,8);[[.8,.4],[-.8,.4],[.8,-.4],[-.8,-.4]].forEach(([a,b])=>g.add(mesh(l,M(0x2b2b36),x+a,y+.3,z+b)));}
  else if(d==='marketing')g.add(plant(x,z,1));else if(d==='personal')g.add(plant(x,z,.9));else if(d==='research')g.add(plant(x,z,.8));
  else if(d==='amazon'){const b=new THREE.BoxGeometry(.5,.5,.5);g.add(mesh(b,M(0xc9a27a),x-.27,y+.25,z));g.add(mesh(b,M(0xc9a27a),x+.27,y+.25,z));g.add(mesh(b,M(0xc9a27a),x,y+.75,z));}
  else if(d==='finance'){[[.3,-.25,0],[.45,.25,0],[.2,0,.3]].forEach(([h,a,b])=>g.add(mesh(new THREE.CylinderGeometry(.22,.22,h,20),M(0xe0b84a,{metalness:.2,roughness:.5}),x+a,y+h/2,z+b)));}
  else if(d==='supply'){g.add(mesh(new THREE.BoxGeometry(1.2,.1,1.2),M(0x9b7b55),x,y+.05,z));const b=new THREE.BoxGeometry(.55,.55,.55);[[-.28,.375,0],[.28,.375,0],[-.28,.925,0],[.28,.925,0]].forEach(([a,h])=>g.add(mesh(b,M(0xc9a27a),x+a,y+h,z)));}
  else if(d==='tech'){g.add(mesh(new THREE.BoxGeometry(.7,1.6,.6),M(0x23242e),x,y+.8,z));[.5,.9,1.3].forEach(h=>{const s=new THREE.Mesh(new THREE.BoxGeometry(.5,.04,.02),new THREE.MeshBasicMaterial({color:m.c}));s.position.set(x,y+h,z+.31);g.add(s);});}
  scene.add(g);people.push(g);}
 const LAY={1:[[0,0]],2:[[-1.4,1.4],[1.4,-1.4]],3:[[-1.8,-1.8],[1.8,-1.8],[-1.8,1.8]],4:[[-1.8,-1.8],[1.8,-1.8],[-1.8,1.8],[1.8,1.8]],5:[[-2.1,-2.1],[2.1,-2.1],[0,0],[-2.1,2.1],[2.1,2.1]],
  6:[[-2.3,-2.3],[2.3,-2.3],[-2.3,2.3],[2.3,2.3],[-1.1,1.1],[1.1,-1.1]]};
 const PROP_AT={1:[1.9,1.9],2:[1.9,1.9],3:[1.9,1.9],4:[0,0],5:[3.1,0],6:null};
 function buildPeople(){OPS.forEach(d=>{const m=META[d.id],ags=d.agents.slice(0,6),n=Math.max(1,ags.length),L=LAY[n];ags.forEach((a,i)=>desk(d.id,a,m.x+L[i][0],m.z+L[i][1],.08,i===0));const pa=PROP_AT[n];if(pa)prop(d.id,pa[0],pa[1]);});
  DEPT.core.agents.slice(0,1).forEach(a=>desk('core',a,1.4,1.4,0,false));}
 function rebuild(){people.forEach(g=>{scene.remove(g);g.traverse(o=>{if(o.geometry)o.geometry.dispose();if(o.material&&o.material.map){o.material.map.dispose();o.material.dispose();}});});
  people.length=0;desks.length=0;Object.keys(deskBy).forEach(k=>delete deskBy[k]);buildPeople();}

 /* screen drawing */
 function drawScreen(r,t){const c=r.ctx,w=160,h=100,ac=META[r.dept].c,busy=r.busy,k=t/1000+r.seed;c.fillStyle=busy?'#f5f7fc':'#aeb2c8';c.fillRect(0,0,w,h);
  c.fillStyle=ac;c.fillRect(0,0,w,10);c.fillStyle=busy?'#dfe3f0':'#9a9eb6';c.fillRect(0,10,30,h-10);c.fillStyle=busy?'#b9bfd6':'#8a8ea6';for(let i=0;i<5;i++)c.fillRect(5,16+i*14,20,4);
  const X=36,Y=16,CW=w-X-6,CH=h-Y-6;c.save();c.beginPath();c.rect(X,Y,CW,CH);c.clip();const ink=busy?'#3b4270':'#6d718a';c.strokeStyle=ink;c.fillStyle=ink;c.lineWidth=2;
  const s=META[r.dept].scr;
  if(s==='cal'){for(let i=0;i<5;i++)for(let j=0;j<3;j++){c.fillStyle=((i+j+Math.floor(k))%4===0)?ac:(busy?'#dfe3f0':'#9a9eb6');c.fillRect(X+i*14,Y+j*12,12,10);}c.fillStyle=ink;for(let i=0;i<3;i++)c.fillRect(X+76,Y+4+i*12,40-((i*9+Math.floor(k*3))%20),4);}
  else if(s==='bars'){for(let i=0;i<8;i++){const v=(Math.sin(k*1.4+i)*.5+.5)*CH*.8+6;c.fillStyle=i%3===0?ac:ink;c.fillRect(X+i*14,Y+CH-v,10,v);}}
  else if(s==='orders'){const o=(k*18)%16;for(let i=-1;i<5;i++){const y=Y+i*16+o;c.fillStyle=ac;c.fillRect(X,y,11,11);c.fillStyle=ink;c.fillRect(X+16,y+2,60,3);c.fillRect(X+16,y+7,30,2);c.fillRect(X+CW-22,y+3,20,4);}}
  else if(s==='map'){c.fillStyle=busy?'#dfe3f0':'#9a9eb6';c.fillRect(X,Y,CW,CH);const pts=[[10,50],[40,20],[80,40],[110,15]];c.setLineDash([4,3]);c.lineDashOffset=-k*20;c.strokeStyle=ac;c.beginPath();pts.forEach(([a,b],i)=>i?c.lineTo(X+a,Y+b):c.moveTo(X+a,Y+b));c.stroke();c.setLineDash([]);c.fillStyle=ink;pts.forEach(([a,b])=>{c.beginPath();c.arc(X+a,Y+b,3,0,7);c.fill();});}
  else if(s==='line'){const n=Math.floor((k*8)%20)+2;c.strokeStyle=ac;c.beginPath();for(let i=0;i<n;i++){const x=X+i*(CW/20),y=Y+CH*.8-(Math.sin(i*.5)*.3+.5+i*.02)*CH*.6;i?c.lineTo(x,y):c.moveTo(x,y);}c.stroke();}
  else if(s==='table'){for(let i=0;i<5;i++){c.fillStyle=ink;c.fillRect(X,Y+i*13,50,3);c.fillRect(X+56,Y+i*13,((i*13+Math.floor(k*5))%24)+8,3);}const a=(k%6)/6*Math.PI*2;c.fillStyle=busy?'#dfe3f0':'#9a9eb6';c.beginPath();c.arc(X+CW-20,Y+CH/2,18,0,7);c.fill();c.fillStyle=ac;c.beginPath();c.moveTo(X+CW-20,Y+CH/2);c.arc(X+CW-20,Y+CH/2,18,-1.57,-1.57+a);c.fill();}
  else if(s==='code'){const cols=[ac,'#4CD08A','#FF8AD0',ink];const o=(k*14)%9;for(let i=-1;i<9;i++){const y=Y+i*9-o;const ind=(i*7)%3*8;c.fillStyle=cols[(i+9)%4];c.fillRect(X+ind,y,20+((i*17+9)%40),3);c.fillStyle=ink;c.fillRect(X+ind+26+((i*17+9)%40),y,14,3);}}
  else if(s==='check'){const n=Math.floor(k*1.5)%6;for(let i=0;i<5;i++){const y=Y+i*14;c.strokeStyle=ink;c.lineWidth=1.5;c.strokeRect(X,y,9,9);if(i<n){c.strokeStyle=ac;c.beginPath();c.moveTo(X+2,y+5);c.lineTo(X+4,y+7);c.lineTo(X+8,y+2);c.stroke();}c.fillStyle=ink;c.fillRect(X+14,y+3,60-i*6,3);}}
  else{const P=[[20,20],[60,12],[95,30],[40,55],[80,62],[110,50]];c.lineWidth=1;c.strokeStyle=ac;[[0,1],[1,2],[0,3],[3,4],[4,5],[2,5],[1,4]].forEach(([a,b])=>{c.beginPath();c.moveTo(X+P[a][0],Y+P[a][1]);c.lineTo(X+P[b][0],Y+P[b][1]);c.stroke();});
   P.forEach(([a,b],i)=>{c.fillStyle=i===Math.floor(k*2)%6?ac:ink;c.beginPath();c.arc(X+a,Y+b,4,0,7);c.fill();});}
  c.restore();r.tex.needsUpdate=true;}

 function init(){stageEl=document.getElementById('stage');canvas=document.getElementById('cv');
  renderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:true});renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;
  scene=new THREE.Scene();cam=new THREE.OrthographicCamera(-1,1,1,-1,-300,400);
  scene.add(new THREE.HemisphereLight(0xc4ccff,0x1a1c40,.72));const dl=new THREE.DirectionalLight(0xffffff,.62);dl.position.set(-14,36,12);dl.target.position.set(0,0,0);dl.castShadow=true;
  dl.shadow.mapSize.set(2048,2048);Object.assign(dl.shadow.camera,{left:-32,right:32,top:32,bottom:-32,near:1,far:100});dl.shadow.bias=-.0006;scene.add(dl,dl.target);
  const d2=new THREE.DirectionalLight(0x9fb2ff,.25);d2.position.set(20,10,-10);scene.add(d2);
  const hub=mesh(new THREE.CylinderGeometry(3,3,.5,48),M(0x262a5e),0,-.25,0,false);hub.userData.dept='core';scene.add(hub);pickables.push(hub);
  ring=new THREE.Mesh(new THREE.TorusGeometry(3,.05,8,96),new THREE.MeshBasicMaterial({color:0x8fd3ff,transparent:true,opacity:.5}));ring.rotation.x=Math.PI/2;ring.position.y=.02;scene.add(ring);
  ico=new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(.9,1)),new THREE.LineBasicMaterial({color:0xaec0ff,transparent:true,opacity:.75}));ico.position.y=1.9;scene.add(ico);
  coreBall=new THREE.Mesh(new THREE.SphereGeometry(.35,20,16),new THREE.MeshBasicMaterial({color:0x8fd3ff}));coreBall.position.y=1.9;scene.add(coreBall);
  OPS.forEach(d=>{const m=META[d.id];platform(d.id);const dist=Math.hypot(m.x,m.z);const b=mesh(new THREE.BoxGeometry(dist,.22,1.7),M(0x2b2f58),m.x/2,-.13,m.z/2,false);b.rotation.y=-Math.atan2(m.z,m.x);scene.add(b);});
  buildPeople();
  new ResizeObserver(resize).observe(stageEl);resize();target.copy(goal);zoomCur=zoomGoal;
  bindInput();setInterval(drawScreens,350);requestAnimationFrame(frame);}
 function placeCam(t){cam.position.copy(t).add(OFF);cam.lookAt(t);cam.updateMatrixWorld();}
 function resize(){const r=stageEl.getBoundingClientRect();W=Math.max(1,r.width);Hh=Math.max(1,r.height);renderer.setSize(W,Hh,false);const a=W/Hh;
  cam.left=-VIEW*a/2;cam.right=VIEW*a/2;cam.top=VIEW/2;cam.bottom=-VIEW/2;computeFit();
  if(UI.focus){zoomGoal=fitZoom*2.2;}else{goal.copy(overviewTarget);zoomGoal=fitZoom;}}
 function computeFit(){const z0=cam.zoom;cam.zoom=1;cam.updateProjectionMatrix();placeCam(new THREE.Vector3());let x0=1e9,x1=-1e9,y0=1e9,y1=-1e9;const v=new THREE.Vector3();
  OPS.forEach(d=>{const m=META[d.id];const pts=[[m.x-3.8,0,m.z-3.8],[m.x+3.8,0,m.z-3.8],[m.x-3.8,0,m.z+3.8],[m.x+3.8,0,m.z+3.8],[m.x-1.6,3.2+7,m.z-1.6]];
   pts.forEach(p=>{v.set(p[0],p[1],p[2]).project(cam);x0=Math.min(x0,v.x);x1=Math.max(x1,v.x);y0=Math.min(y0,v.y);y1=Math.max(y1,v.y);});});
  fitZoom=Math.min(1.9/(x1-x0),1.9/(y1-y0));const cx=(x0+x1)/2,cy=(y0+y1)/2;const R=new THREE.Vector3(),U=new THREE.Vector3();cam.matrixWorld.extractBasis(R,U,new THREE.Vector3());
  overviewTarget.set(0,0,0).addScaledVector(R,cx*cam.right).addScaledVector(U,cy*cam.top);cam.zoom=z0;cam.updateProjectionMatrix();}
 function project(v3){const v=v3.clone().project(cam);return {x:(v.x+1)/2*W,y:(1-v.y)/2*Hh,vis:v.z<1};}
 function hit(ev){const r=canvas.getBoundingClientRect();mouse.set((ev.clientX-r.left)/r.width*2-1,-(ev.clientY-r.top)/r.height*2+1);ray.setFromCamera(mouse,cam);const h=ray.intersectObjects(pickables,false)[0];return h?h.object.userData.dept:null;}
 function bindInput(){let down=null,drag=false;
  canvas.addEventListener('pointerdown',e=>{down={x:e.clientX,y:e.clientY};drag=false;canvas.setPointerCapture(e.pointerId);});
  canvas.addEventListener('pointermove',e=>{if(down){const dx=e.clientX-down.x,dy=e.clientY-down.y;if(!drag&&Math.hypot(dx,dy)>4)drag=true;
    if(drag){const ppu=Hh/(VIEW/zoomCur);const R=new THREE.Vector3(1,0,-1).normalize(),U=new THREE.Vector3(-1,0,-1).normalize();goal.addScaledVector(R,-dx/ppu).addScaledVector(U,dy/(ppu*.577));if(reduced)target.copy(goal);down={x:e.clientX,y:e.clientY};}return;}
   const d=hit(e);UI.hover(d&&d!=='core'?d:null);canvas.style.cursor=d?'pointer':'grab';});
  canvas.addEventListener('pointerup',e=>{if(down&&!drag){const d=hit(e);if(d==='core')UI.openBrain();else if(d)UI.focusDept(d);}down=null;});
  canvas.addEventListener('pointerleave',()=>UI.hover(null));
  canvas.addEventListener('wheel',e=>{e.preventDefault();setZoom(zoomGoal*Math.exp(-e.deltaY*.0012));},{passive:false});}
 function setZoom(z){zoomGoal=H.clamp(z,fitZoom*.6,fitZoom*5);if(reduced)zoomCur=zoomGoal;}
 function drawScreens(){if(document.hidden)return;const t=performance.now();const f=UI.focus;let list=f?desks.filter(d=>d.dept===f):[];
  if(!f)for(let i=0;i<6;i++)list.push(desks[Math.floor(Math.random()*desks.length)]);list.forEach(r=>drawScreen(r,t));}
 function setBusy(map){desks.forEach(r=>{const b=map.has(r.agent);if(b!==r.busy){r.busy=b;drawScreen(r,performance.now());}});}
 function frame(ts){requestAnimationFrame(frame);const k=reduced?1:.12;target.lerp(goal,k);zoomCur+=(zoomGoal-zoomCur)*k;placeCam(target);cam.zoom=zoomCur;cam.updateProjectionMatrix();
  const s=ts/1000;ring.material.opacity=.55+Math.sin(s*1.6)*.25;if(!reduced){ico.rotation.y=s*.25;ico.rotation.x=s*.12;
   desks.forEach(r=>{if(r.busy){r.head.position.y=1.2+Math.sin(s*6+r.seed)*.018;r.torso.rotation.x=Math.sin(s*2.2+r.seed)*.04;}else{r.head.position.y=1.2;r.torso.rotation.x=0;}});}
  renderer.render(scene,cam);Overlay.update();Viz.update(ts);}
 return {init,project,setBusy,setZoom,rebuild,desks:()=>desks,deskBy,
  get zoom(){return zoomCur;},get fit(){return fitZoom;},get size(){return {W,Hh};},
  focusOn(d){const m=META[d];goal.set(m.x,.8,m.z);zoomGoal=fitZoom*2.2;if(reduced){target.copy(goal);zoomCur=zoomGoal;}},
  overview(){goal.copy(overviewTarget);zoomGoal=fitZoom;if(reduced){target.copy(goal);zoomCur=zoomGoal;}},
  zoomBy(f){setZoom(zoomGoal*f);},
  anchorCard:d=>{const m=META[d];return new THREE.Vector3(m.x-1.6,3.2,m.z-1.6);},
  anchorPlat:d=>{const m=META[d];return new THREE.Vector3(m.x,.2,m.z);},
  anchorBrain:()=>new THREE.Vector3(0,1.1,0),hubPt:()=>new THREE.Vector3(0,.2,0)};
})();

/* ============ overlay: dept cards, agent tags, brain tag ============ */
const Overlay=(function(){let root,cards={},tags={},btag,bSub;
 function init(){root=document.getElementById('overlay');
  OPS.forEach(d=>{const el=document.createElement('div');el.className='dcard';el.tabIndex=0;el.setAttribute('role','button');el.setAttribute('aria-label','قسم '+d.name);el.style.setProperty('--ac',META[d.id].c);
   el.addEventListener('click',()=>UI.focusDept(d.id));el.addEventListener('keydown',e=>{if(e.key==='Enter')UI.focusDept(d.id);});
   el.addEventListener('mouseenter',()=>UI.hover(d.id));el.addEventListener('mouseleave',()=>UI.hover(null));root.appendChild(el);cards[d.id]={el,html:''};});
  makeTags();
  btag=document.createElement('div');btag.className='btag';btag.innerHTML='<div><b>العقل</b><span class="c mono">0</span>ملاحظة</div><div class="s"></div>';btag.addEventListener('click',()=>UI.openBrain());root.appendChild(btag);bSub=btag.querySelector('.s');}
 function makeTags(){Object.values(tags).forEach(t=>t.el.remove());tags={};DEPTS.forEach(d=>d.agents.forEach(a=>{const el=document.createElement('div');el.className='atag';el.style.display='none';root.appendChild(el);tags[a]={el,html:''};}));}
 function setCard(d,html,hot){const c=cards[d];if(c.html!==html){c.el.innerHTML=html;c.html=html;}c.el.classList.toggle('hot',!!hot);}
 function setTag(a,html){const t=tags[a];if(!t)return;if(t.html!==html){t.el.innerHTML=html;t.html=html;}}
 function brain(count,line){btag.querySelector('.c').textContent=H.num(count);if(line!=null&&bSub.textContent!==line){bSub.style.opacity=0;setTimeout(()=>{bSub.textContent=line;bSub.style.opacity=1;},250);}}
 function update(){if(!root)return;const {W}=Scene.size,z=Scene.zoom,fit=Scene.fit||1,f=UI.focus,hideAll=!!UI.layer;
  const cs=H.clamp(W/1400,.5,.9)*H.clamp(z/fit,.8,1.25);
  OPS.forEach(d=>{const el=cards[d.id].el;if(f||hideAll){el.classList.add('hide');return;}el.classList.remove('hide');const p=Scene.project(Scene.anchorCard(d.id));
   el.style.transform=`translate(${p.x.toFixed(1)}px,${p.y.toFixed(1)}px) scale(${cs.toFixed(3)}) translate(-50%,-100%)`;});
  const ts=H.clamp(z/fit*.6,.8,1.12),showAll=!f&&z>fit*1.35;
  Scene.desks().forEach(r=>{const t=tags[r.agent];if(!t)return;const show=!hideAll&&(f?r.dept===f:showAll);if(!show){if(t.el.style.display!=='none')t.el.style.display='none';return;}
   t.el.style.display='flex';const p=Scene.project(r.anchor);t.el.style.transform=`translate(${p.x.toFixed(1)}px,${p.y.toFixed(1)}px) scale(${ts.toFixed(3)}) translate(-50%,-100%)`;});
  if(f||hideAll)btag.style.display='none';else{btag.style.display='block';const p=Scene.project(Scene.anchorBrain());btag.style.transform=`translate(${p.x.toFixed(1)}px,${p.y.toFixed(1)}px) scale(${cs.toFixed(3)}) translate(-50%,-100%)`;}}
 return {init,setCard,setTag,brain,update,rebuildTags:makeTags};})();

/* ============ wires + pulses (SVG over #app) ============ */
const Viz=(function(){let svg,gT,gB,gR,gP,app;const paths=new Map();const pulses=[];const routes=[];let lastKey='';
 const NS='http://www.w3.org/2000/svg';
 function init(){svg=document.getElementById('wires');gT=svg.querySelector('#g-tools');gB=svg.querySelector('#g-brain');gR=svg.querySelector('#g-route');gP=svg.querySelector('#g-pulse');app=document.getElementById('app');if(reduced)svg.classList.add('rm');}
 function path(key,cls,g){let p=paths.get(key);if(!p){p=document.createElementNS(NS,'path');p.setAttribute('class',cls);g.appendChild(p);paths.set(key,p);}p.__keep=true;return p;}
 function stageOff(){const a=app.getBoundingClientRect(),s=document.getElementById('stage').getBoundingClientRect();return {x:s.left-a.left,y:s.top-a.top,a};}
 function update(ts){if(!svg)return;const hide=!!UI.layer;svg.classList.toggle('off',hide);if(hide)return;
  paths.forEach(p=>p.__keep=false);const o=stageOff(),f=UI.focus;const pp=v=>{const p=Scene.project(v);return {x:p.x+o.x,y:p.y+o.y};};
  document.querySelectorAll('#tools .tool').forEach(btn=>{const id=btn.dataset.tool,r=btn.getBoundingClientRect();const x1=r.left+r.width/2-o.a.left,y1=r.bottom-o.a.top;
   const ds=f?[f]:OPS.filter(d=>d.tools.includes(id)).map(d=>d.id);ds.forEach(d=>{const q=pp(Scene.anchorPlat(d));
    path('t:'+id+':'+d,'w-tool',gT).setAttribute('d',`M${x1.toFixed(1)} ${y1.toFixed(1)} C${x1.toFixed(1)} ${(y1+90).toFixed(1)} ${q.x.toFixed(1)} ${(q.y-160).toFixed(1)} ${q.x.toFixed(1)} ${q.y.toFixed(1)}`);});});
  if(!f){const h=pp(Scene.hubPt());OPS.forEach(d=>{const q=pp(Scene.anchorPlat(d.id));const mx=(h.x+q.x)/2,my=(h.y+q.y)/2-30;path('b:'+d.id,'w-brain',gB).setAttribute('d',`M${h.x.toFixed(1)} ${h.y.toFixed(1)} Q${mx.toFixed(1)} ${my.toFixed(1)} ${q.x.toFixed(1)} ${q.y.toFixed(1)}`);});}
  const now=performance.now();for(let i=routes.length-1;i>=0;i--){const r=routes[i];if(now>r.end){routes.splice(i,1);continue;}const a=pp(Scene.anchorPlat(r.from)),b=pp(Scene.anchorPlat(r.to));
   path(r.key,'w-route',gR).setAttribute('d',`M${a.x.toFixed(1)} ${a.y.toFixed(1)} Q${((a.x+b.x)/2).toFixed(1)} ${((a.y+b.y)/2-60).toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`);}
  paths.forEach((p,k)=>{if(!p.__keep){p.remove();paths.delete(k);}});
  for(let i=pulses.length-1;i>=0;i--){const u=pulses[i],p=paths.get(u.key);const k=(now-u.t0)/1300;if(k>=1||!p){u.el.remove();pulses.splice(i,1);continue;}
   try{const L=p.getTotalLength(),pt=p.getPointAtLength(L*(u.rev?1-k:k));u.el.setAttribute('cx',pt.x);u.el.setAttribute('cy',pt.y);u.el.setAttribute('opacity',String(1-Math.max(0,k-.8)*5));}catch(e){}}}
 function pulse(key,color,rev){if(reduced||!paths.has(key))return;const c=document.createElementNS(NS,'circle');c.setAttribute('r','2.6');c.setAttribute('fill',color||'#fff');
  c.style.filter=`drop-shadow(0 0 4px ${color||'#fff'})`;gP.appendChild(c);pulses.push({key,el:c,t0:performance.now(),rev});}
 function activity(e){const ev=e.event;if(!ev)return;
  if(e.tool&&ev.dept!=='core')pulse('t:'+e.tool+':'+ev.dept);
  if(e.brain&&ev.dept!=='core')pulse('b:'+ev.dept,'#8FD3FF',ev.kind==='write'||ev.kind==='draft'||ev.kind==='finish');
  if(ev.kind==='read'||ev.kind==='write')UI.brainLine(`${ev.agent} ${ev.text}`);
  if(e.route){const key='r:'+e.route.to+':'+Math.random().toString(36).slice(2,6);routes.push({key,from:e.route.from,to:e.route.to,end:performance.now()+1800});
   setTimeout(()=>pulse(key,'#FFD27A'),30);}}
 return {init,update,activity};})();

export { store, tasksArr, prodById, applySnapshot, upsert, onEvent, deptStats, busyAgents, activeAlerts, policyOf, approvalReason, valueDesc, Scene, Overlay, Viz };
