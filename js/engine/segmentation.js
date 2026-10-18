// Segmentation is entirely local. Masks are cached per video frame/subject.
// A cache miss NEVER disables masking: the renderer falls back to the entire padded box.
import {activeAt,boxAt,clamp} from '../state.js';
import {pixelBox} from './render.js';
export const MASK_RESOLUTION=256;
const TEST_SIZE=MASK_RESOLUTION;
const ALLOWED={outline:new Set([1,2,3,4]),skin:new Set([2]),hair:new Set([1])};
export function selectCategories(categories,shape,includeFace=false){
  const sel=ALLOWED[shape];if(!sel)return new Uint8Array(categories.length);
  const result=new Uint8Array(categories.length);
  for(let i=0;i<categories.length;i++)result[i]=(sel.has(categories[i])||(shape==='skin'&&includeFace&&categories[i]===3))?255:0;
  return result;
}
// O(width*height) two-pass square dilation, safe default for uncertain edges.
export function dilateMask(input,width,height,radius){
  const r=Math.max(0,Math.min(28,Math.round(radius)));
  if(!r)return new Uint8Array(input);
  const tmp=new Uint8Array(width*height),out=new Uint8Array(tmp.length);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    let best=0;for(let dx=-r;dx<=r;dx++){const xx=x+dx;if(xx>=0&&xx<width){best=Math.max(best,input[y*width+xx]);if(best===255)break;}}
    tmp[y*width+x]=best;
  }
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    let best=0;for(let dy=-r;dy<=r;dy++){const yy=y+dy;if(yy>=0&&yy<height){best=Math.max(best,tmp[yy*width+x]);if(best===255)break;}}
    out[y*width+x]=best;
  }
  return out;
}
export function smoothMask(current,previous,blend=.6){
  if(!previous||previous.length!==current.length)return current;
  const next=new Uint8Array(current.length);
  for(let i=0;i<next.length;i++)next[i]=Math.round(current[i]*blend+previous[i]*(1-blend));
  return next;
}
export function maskRatio(data){let count=0;for(let i=0;i<data.length;i++)if(data[i]>80)count++;return count/Math.max(1,data.length);}
export class MaskCache {
  constructor({maxEntries=110}={}){this.masks=new Map();this.pending=new Map();this.maxEntries=maxEntries;this.generation=0;this.lastMessage='';}
  key(c,index){return `${this.generation}:${c.id}:${c.shape}:${c.includeFace?1:0}:${c.padding}:${c.feather}:${c.safetyMargin||0}:${index}`;}
  get(c,index){const k=this.key(c,index);const entry=this.masks.get(k);if(entry){this.masks.delete(k);this.masks.set(k,entry);}return entry||null;}
  put(c,index,value){const k=this.key(c,index);this.masks.delete(k);this.masks.set(k,value);while(this.masks.size>this.maxEntries)this.masks.delete(this.masks.keys().next().value);return value;}
  clear(){this.generation++;this.masks.clear();this.pending.clear();}
  get size(){return this.masks.size;}
  async ensure({source,project,time,c,ai,signal}){
    if(!c||c.shape==='box')return null;
    const index=Math.round(time*project.video.fps),key=this.key(c,index),existing=this.get(c,index);
    if(existing)return existing;
    if(this.pending.has(key))return await this.pending.get(key);
    // At 30fps, reuse a recent mask on intermediate frames; the box itself still
    // follows the current track point. This limits expensive segmentation to ~10fps
    // during ordered exports and prevents a full-box flash between model passes.
    if(project.video.fps>=24 && index%3!==0){
      for(let delta=1;delta<=2;delta++){
        const nearby=this.masks.get(this.key(c,index-delta));
        if(nearby)return this.put(c,index,nearby);
      }
    }
    const promise=this.compute({source,project,time,c,ai,signal}).then(entry=>this.put(c,index,entry)).finally(()=>this.pending.delete(key));
    this.pending.set(key,promise);return await promise;
  }
  async ensureActive({source,project,time,ai,signal}){
    for(const c of activeAt(project,time)){
      if(signal?.aborted)throw new DOMException('Cancelled','AbortError');
      await this.ensure({source,project,time,c,ai,signal});
    }
  }
  async compute({source,project,time,c,ai,signal}){
    const b=boxAt(c,time);if(!b)return {fallback:true,reason:'No track point'};
    const r=pixelBox(b,c.padding??.12,project.video.width,project.video.height);
    if(r.w<2||r.h<2)return {fallback:true,reason:'Box too small'};
    const sw=source.videoWidth||source.naturalWidth||source.width||project.video.width;
    const sh=source.videoHeight||source.naturalHeight||source.height||project.video.height;
    const sx=r.x/project.video.width*sw,sy=r.y/project.video.height*sh;
    const bw=Math.min(sw-sx,r.w/project.video.width*sw),bh=Math.min(sh-sy,r.h/project.video.height*sh);
    if(bw<1||bh<1)return {fallback:true,reason:'Invalid crop'};
    const maskSource=document.createElement('canvas');maskSource.width=TEST_SIZE;maskSource.height=TEST_SIZE;
    const sourceCtx=maskSource.getContext('2d',{willReadFrequently:true});
    sourceCtx.fillStyle='#777';sourceCtx.fillRect(0,0,TEST_SIZE,TEST_SIZE);
    try{sourceCtx.drawImage(source,sx,sy,bw,bh,0,0,TEST_SIZE,TEST_SIZE);}catch{return {fallback:true,reason:'Crop unavailable'};}
    if(signal?.aborted)throw new DOMException('Cancelled','AbortError');
    let raw;
    try{raw=await ai.segmentCrop(maskSource);}catch(e){this.lastMessage=e.message;return {fallback:true,reason:e.message};}
    const rawMask=selectCategories(raw.data,c.shape,c.includeFace||false);
    if(maskRatio(rawMask)<.05)return {fallback:true,reason:'Less than 5% of box segmented'};
    const feather=Number(c.feather||0),margin=Number(c.safetyMargin||0);
    const radius=Math.ceil((feather+margin)/Math.max(r.w,r.h,1)*TEST_SIZE)+3;
    const grown=dilateMask(rawMask,TEST_SIZE,TEST_SIZE,radius);
    const prevIndex=Math.round(time*project.video.fps)-1;
    const previous=this.get(c,prevIndex);
    const stable=previous&&!previous.fallback&&previous.data?smoothMask(grown,previous.data,.6):grown;
    return {fallback:false,data:stable,width:TEST_SIZE,height:TEST_SIZE,reason:'Segmented',ratio:maskRatio(rawMask)};
  }
}
