export const clamp = (v, a, b) => Math.max(a, Math.min(b, Number.isFinite(v) ? v : a));
export const clone = v => structuredClone(v);
export const makeId = () => globalThis.crypto?.randomUUID?.() || `hf-${Date.now()}-${Math.random().toString(36).slice(2)}`;
export const seconds = (s) => { const n = Math.max(0,s||0); return `${Math.floor(n/60).toString().padStart(2,'0')}:${(n%60).toFixed(2).padStart(5,'0')}`; };
export function createProject(video) {
  return { version: '1.1', video: { duration: Number(video.duration)||0, fps: Number(video.fps)||30, width: video.width, height: video.height, fileName: video.fileName||'', fileSize: video.fileSize||0 }, concealments: [] };
}
export function normalizedBox(b) {
  const x=clamp(b.x,0,1), y=clamp(b.y,0,1);
  return { x,y,w:clamp(b.w,0,1-x),h:clamp(b.h,0,1-y) };
}
export function newConcealment(project, box, t, { label, source='manual' } = {}) {
  const startTime=clamp(t,0,project.video.duration), endTime=Math.min(project.video.duration,startTime+3);
  return { id:makeId(), label:label||`Region ${project.concealments.length+1}`,
    startTime, endTime, shape:'box', effect:'black', strength:18, padding:0.12, feather:0, safetyMargin:8, includeFace:false,
    track:[{t:startTime,...normalizedBox(box),confidence:1,source}] };
}
export function addPoint(c, t, box, source='manual', confidence=1) {
  const time=Math.max(0,Number(t));
  c.track=c.track.filter(p=>Math.abs(p.t-time)>0.0005);
  c.track.push({t:time,...normalizedBox(box),confidence:clamp(confidence,0,1),source});
  c.track.sort((a,b)=>a.t-b.t);
}
export function boxAt(c,t) {
  const a=c.track;
  if(!a?.length) return null;
  if(t<=a[0].t) return normalizedBox(a[0]);
  if(t>=a[a.length-1].t) return normalizedBox(a[a.length-1]);
  let l=0,r=a.length-1;
  while(r-l>1){const m=(l+r)>>1; if(a[m].t<=t)l=m;else r=m;}
  const alpha=clamp((t-a[l].t)/Math.max(1e-8,a[r].t-a[l].t),0,1);
  const b={}; for(const k of ['x','y','w','h'])b[k]=a[l][k]*(1-alpha)+a[r][k]*alpha;
  return normalizedBox(b);
}
export const activeAt = (project,t) => project.concealments.filter(c=>c.startTime-0.00001<=t && c.endTime+0.00001>=t && c.track?.length);
export class History {
  constructor(limit=70){this.entries=[];this.cursor=-1;this.limit=limit;}
  reset(value){this.entries=[JSON.stringify(value)];this.cursor=0;}
  record(value){const str=JSON.stringify(value);if(this.entries[this.cursor]===str)return;this.entries=this.entries.slice(0,this.cursor+1);this.entries.push(str);if(this.entries.length>this.limit)this.entries.shift();this.cursor=this.entries.length-1;}
  undo(){if(this.cursor<=0)return null;return JSON.parse(this.entries[--this.cursor]);}
  redo(){if(this.cursor>=this.entries.length-1)return null;return JSON.parse(this.entries[++this.cursor]);}
  get canUndo(){return this.cursor>0;} get canRedo(){return this.cursor<this.entries.length-1;}
}
const DB_NAME='halalframe-projects', STORE='drafts';
function openDB(){return new Promise((res,rej)=>{if(!indexedDB)return rej(new Error('IndexedDB unavailable'));const req=indexedDB.open(DB_NAME,1);req.onupgradeneeded=()=>req.result.createObjectStore(STORE);req.onsuccess=()=>res(req.result);req.onerror=()=>rej(req.error);});}
export async function saveProject(project){const db=await openDB();try{await new Promise((res,rej)=>{const tx=db.transaction(STORE,'readwrite');tx.objectStore(STORE).put({project,at:Date.now()},'latest');tx.oncomplete=res;tx.onerror=()=>rej(tx.error);});}finally{db.close();}}
export async function loadSavedProject(){const db=await openDB();try{return await new Promise((res,rej)=>{const r=db.transaction(STORE,'readonly').objectStore(STORE).get('latest');r.onsuccess=()=>res(r.result||null);r.onerror=()=>rej(r.error);});}finally{db.close();}}
