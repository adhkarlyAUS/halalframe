// Segmentation is entirely local. Masks are cached per video frame/subject.
// A cache miss NEVER disables masking: the renderer falls back to the entire padded box.
import {activeAt,boxAt,clamp} from '../state.js';
import {pixelBox} from './render.js';
import {appearanceSignature,appearanceSimilarity,iou} from './identity.js';
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
// Resample the full-frame, per-pose probability mask into the current padded
// tracked box. A full-frame background class mask must never select the target.
export function sampleInstanceMask(instance,rect,videoW,videoH,size=MASK_RESOLUTION){
  const m=instance.mask,out=new Uint8Array(size*size);
  if(!m?.data)return out;
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const u=(rect.x+(x+.5)/size*rect.w)/videoW,v=(rect.y+(y+.5)/size*rect.h)/videoH;
    if(u<0||u>=1||v<0||v>=1)continue;
    const mx=Math.min(m.width-1,Math.floor(u*m.width)),my=Math.min(m.height-1,Math.floor(v*m.height));
    out[y*size+x]=Math.round(255*clamp(m.data[my*m.width+mx]||0,0,1));
  }
  return out;
}
export function selectTargetInstance(instances,box,referenceSignature=null,source=null){
  if(!instances?.length)return null;
  const centre=b=>({x:b.x+b.w/2,y:b.y+b.h/2}),b=centre(box);
  const ranked=instances.map(p=>{
    const q=centre(p.box),distance=Math.hypot(b.x-q.x,b.y-q.y),radius=Math.max(.06,Math.hypot(box.w,box.h));
    const geometry=Math.max(0,1-distance/radius);
    const app=referenceSignature&&source?appearanceSimilarity(referenceSignature,appearanceSignature(source,p.box)):.5;
    const score=.52*geometry+.27*iou(p.box,box)+.21*app;
    return {...p,score,appearance:app};
  }).sort((a,b)=>b.score-a.score);
  return ranked[0]?.score>=.28?ranked[0]:null;
}
export function subtractUnrelatedPeople(mask,rect,videoW,videoH,targetBox,otherBoxes,{margin=.002}={}){
  const side=Math.round(Math.sqrt(mask.length)),out=new Uint8Array(mask);
  for(const other of otherBoxes||[]){
    const left=Math.max(0,Math.floor((other.x-margin-rect.x/videoW)/(rect.w/videoW)*side));
    const right=Math.min(side,Math.ceil((other.x+other.w+margin-rect.x/videoW)/(rect.w/videoW)*side));
    const top=Math.max(0,Math.floor((other.y-margin-rect.y/videoH)/(rect.h/videoH)*side));
    const bottom=Math.min(side,Math.ceil((other.y+other.h+margin-rect.y/videoH)/(rect.h/videoH)*side));
    for(let y=top;y<bottom;y++)for(let x=left;x<right;x++){
      const ux=(rect.x+(x+.5)/side*rect.w)/videoW,uy=(rect.y+(y+.5)/side*rect.h)/videoH;
      const inOther=ux>=other.x&&ux<=other.x+other.w&&uy>=other.y&&uy<=other.y+other.h;
      const inTarget=ux>=targetBox.x&&ux<=targetBox.x+targetBox.w&&uy>=targetBox.y&&uy<=targetBox.y+targetBox.h;
      // Only preserve the genuine shared/occluded intersection. Release the
      // other person immediately after the bounding regions separate.
      if(inOther&&!inTarget)out[y*side+x]=0;
    }
  }
  return out;
}
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
    if(project.video.fps>=24 && index%3!==0 && !c.precisionCritical){
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
    // First prefer a separate PoseLandmarker mask for THIS person only.
    // This prevents the multiclass segmenter from expanding to a second
    // person as soon as both enter the same padded crop.
    let category=null,targetPose=null,poseAvailable=false,instances=[];
    if(c.shape==='outline'||c.shape==='skin'||c.shape==='hair'){
      try{
        instances=await ai.poseInstances(source,time,project.video.fps);
        targetPose=selectTargetInstance(instances,b,c.identitySignature||null,source);
        poseAvailable=!!targetPose?.mask;
      }catch(error){this.lastMessage='Pose instance unavailable: '+error.message;}
    }
    let rawMask=null;
    if(c.shape==='outline'&&poseAvailable){
      rawMask=sampleInstanceMask(targetPose,r,project.video.width,project.video.height);
    }else{
      try{category=await ai.segmentCrop(maskSource);}catch(error){this.lastMessage=error.message;}
      if(category)rawMask=selectCategories(category.data,c.shape,!!c.includeFace);
      if(rawMask&&poseAvailable){
        const personMask=sampleInstanceMask(targetPose,r,project.video.width,project.video.height);
        for(let i=0;i<rawMask.length;i++)rawMask[i]=Math.round(rawMask[i]*(personMask[i]/255));
      }
    }
    // Get other people's current detections (frame cache makes tracking fast).
    // If pose masks are unavailable, reject parts of the crop occupied ONLY
    // by separate unselected people. Explicit exclusions are also respected.
    let detections=[];
    try{detections=await ai.detect(source,time,project.video.fps);}catch{}
    const exclude=(project.exclusions||[]).filter(tr=>time>=tr.startTime&&time<=tr.endTime).map(tr=>boxAt(tr,time)).filter(Boolean);
    const nearby=(c.otherPeople||[]).reduce((best,sample)=>Math.abs(sample.t-time)<Math.abs((best?.t??1e9)-time)?sample:best,null);
    const trackedOthers=nearby&&Math.abs(nearby.t-time)<.12?nearby.boxes:[];
    const otherBoxes=detections.filter(d=>iou(d,b)<.38).concat(trackedOthers,exclude);
    if(!rawMask||maskRatio(rawMask)<.05){
      // Strict fallback for the selected person: safe padded box, minus known
      // unrelated non-overlapping people. Never emit an empty mask.
      rawMask=new Uint8Array(TEST_SIZE*TEST_SIZE).fill(255);
      rawMask=subtractUnrelatedPeople(rawMask,r,project.video.width,project.video.height,b,otherBoxes);
      if(maskRatio(rawMask)<.05)return {fallback:true,reason:'Instance unavailable; full padded box'};
      this.lastMessage='Precise pose not detected — bounded conservative box';
    }else{
      rawMask=subtractUnrelatedPeople(rawMask,r,project.video.width,project.video.height,b,otherBoxes);
      if(maskRatio(rawMask)<.05)return {fallback:true,reason:'Selected person mask too small'};
    }
    const feather=Number(c.feather||0),margin=Number(c.safetyMargin||0);
    const radius=Math.ceil((feather+margin)/Math.max(r.w,r.h,1)*TEST_SIZE)+2;
    const grown=dilateMask(rawMask,TEST_SIZE,TEST_SIZE,radius);
    // Reapply explicit exclusions after dilation to avoid halo bleeding into
    // people the user has explicitly marked as "Don't cover".
    const constrained=subtractUnrelatedPeople(grown,r,project.video.width,project.video.height,b,otherBoxes);
    const previous=this.get(c,Math.round(time*project.video.fps)-1);
    const stable=previous&&!previous.fallback&&previous.data?smoothMask(constrained,previous.data,.84):constrained;
    return {fallback:false,data:stable,width:TEST_SIZE,height:TEST_SIZE,reason:poseAvailable?'Per-person pose mask':'Bounded fallback',ratio:maskRatio(rawMask),instance:poseAvailable};
  }
}
