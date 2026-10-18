// Segmentation is entirely local. Masks are cached per video frame/subject.
// A cache miss NEVER disables masking: the renderer falls back to the entire padded box.
import {activeAt,boxAt,clamp} from '../state.js';
import {concealmentRect} from './render.js';
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
    // More weight on original identity appearance; a distant/background crop
    // must never beat the selected visible subject merely because it overlaps
    // a previously inflated tracking rectangle.
    const score=.39*geometry+.21*iou(p.box,box)+.40*app;
    return {...p,score,appearance:app};
  }).sort((a,b)=>b.score-a.score);
  const best=ranked[0];
  if(!best||best.score<.38)return null;
  if(referenceSignature&&best.appearance<.43)return null;
  if(ranked.length>1&&best.score-ranked[1].score<.035&&best.appearance<.72)return null;
  return best;
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
// Never let a cached, expanded or feathered mask apply to a second person
// after the two subjects separate. All coordinates use the current frame.
export function confineMaskToTarget(mask,rect,W,H,targetBox,{margin=.025}={}){
  const side=Math.round(Math.sqrt(mask.length));
  const result=new Uint8Array(mask);
  const left=Math.max(0,targetBox.x-margin),right=Math.min(1,targetBox.x+targetBox.w+margin);
  const top=Math.max(0,targetBox.y-margin),bottom=Math.min(1,targetBox.y+targetBox.h+margin);
  for(let y=0;y<side;y++)for(let x=0;x<side;x++){
    const u=(rect.x+(x+.5)/side*rect.w)/W,v=(rect.y+(y+.5)/side*rect.h)/H;
    if(u<left||u>right||v<top||v>bottom)result[y*side+x]=0;
  }
  return result;
}
// When distinct pose masks exist, suppress a pixel only if another person's
// probability clearly dominates the target probability. Shared true overlap
// remains attached to the selected subject.
export function subtractCompetingInstances(target,others,{margin=.10}={}){
  const out=new Uint8Array(target);
  for(const other of others){
    if(!other||other.length!==out.length)continue;
    for(let i=0;i<out.length;i++)if(other[i]>out[i]+Math.round(margin*255))out[i]=0;
  }
  return out;
}
// MediaPipe PoseLandmarker excludes most hair above the forehead; its instance
// mask is NOT a safe full-head silhouette. Enclose the head landmarks in a
// generous cap, with a fallback anchored to the current TARGET box only.
const HEAD_POINTS=[0,1,2,3,4,5,6,7,8,9,10];
const clamp01=n=>clamp(n,0,1);
const unionBounds=(a,b)=>{
  const x=Math.min(a.x,b.x),y=Math.min(a.y,b.y);
  return {x,y,w:Math.max(a.x+a.w,b.x+b.w)-x,h:Math.max(a.y+a.h,b.y+b.h)-y};
};
export function headBoundsFromPose(landmarks,box){
  const valid=p=>p&&Number.isFinite(p.x)&&Number.isFinite(p.y)&&p.x>=0&&p.x<=1&&p.y>=0&&p.y<=1&&(p.visibility??1)>.23;
  const head=HEAD_POINTS.map(i=>landmarks?.[i]).filter(valid);
  const shoulders=[landmarks?.[11],landmarks?.[12]].filter(valid);
  // With missing face landmarks use a generous TOP cap of the selected box;
  // do not use the other person's face or whole-frame multiclass labels.
  if(head.length<3){
    const x=box.x+box.w*.15,y=box.y-box.h*.27;
    return {x:clamp01(x),y:clamp01(y),w:Math.min(1-clamp01(x),box.w*.70),h:Math.min(1-clamp01(y),box.h*.72)};
  }
  const xs=head.map(p=>p.x),ys=head.map(p=>p.y);
  const ears=[landmarks?.[7],landmarks?.[8]].filter(valid);
  const eyes=[landmarks?.[1],landmarks?.[2],landmarks?.[3],landmarks?.[4],landmarks?.[5],landmarks?.[6]].filter(valid);
  const centreX=ears.length===2?(ears[0].x+ears[1].x)/2:xs.reduce((a,b)=>a+b,0)/xs.length;
  const eyeY=eyes.length?Math.min(...eyes.map(p=>p.y)):Math.min(...ys);
  const shoulderY=shoulders.length?shoulders.reduce((a,b)=>a+b.y,0)/shoulders.length:eyeY+box.h*.40;
  const earWidth=ears.length===2?Math.abs(ears[0].x-ears[1].x):Math.max(...xs)-Math.min(...xs);
  const shoulderWidth=shoulders.length===2?Math.abs(shoulders[0].x-shoulders[1].x):box.w;
  const height=Math.max(box.h*.19,Math.max(0,shoulderY-eyeY)*.72,earWidth*.62);
  const width=Math.max(box.w*.48,earWidth*1.58,shoulderWidth*.70);
  // 1.10 head heights ABOVE the eyes extends beyond hairline; >0.3 each
  // side of ear span. Include forehead, eyes, hair, cheeks and upper neck.
  const top=Math.min(eyeY-1.10*height,box.y-box.h*.22);
  const bottom=Math.max(Math.max(...ys)+.65*height,box.y+box.h*.39);
  const left=Math.min(centreX-width*.60,box.x+box.w*.15);
  const right=Math.max(centreX+width*.60,box.x+box.w*.85);
  const x=clamp01(left),y=clamp01(top);
  return {x,y,w:Math.max(0,Math.min(1,right)-x),h:Math.max(0,Math.min(1,bottom)-y)};
}
// The cap is deliberately opaque: slightly over-covering background adjacent
// to the selected head is safer than exposing a fringe, forehead or eyes.
export function unionHeadRegion(mask,rect,videoW,videoH,headBounds){
  const side=Math.round(Math.sqrt(mask.length)),result=new Uint8Array(mask);
  if(!headBounds||!headBounds.w||!headBounds.h)return result;
  const x0=clamp(Math.floor((headBounds.x*videoW-rect.x)/rect.w*side),0,side);
  const x1=clamp(Math.ceil(((headBounds.x+headBounds.w)*videoW-rect.x)/rect.w*side),0,side);
  const y0=clamp(Math.floor((headBounds.y*videoH-rect.y)/rect.h*side),0,side);
  const y1=clamp(Math.ceil(((headBounds.y+headBounds.h)*videoH-rect.y)/rect.h*side),0,side);
  for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){
    const idx=y*side+x;
    // An absent classifier hair label must NEVER expose the target hairline.
    result[idx]=255;
  }
  return result;
}
// Add classifier-detected hair beyond the geometric cap only in a narrow
// neighbourhood of the selected head. The all-person hair map is NEVER used
// outside that region; the other subject is not part of this target mask.
export function addTargetHairPixels(mask,categories,rect,W,H,headBounds){
  if(!categories||!headBounds||categories.length!==mask.length)return mask;
  const n=Math.round(Math.sqrt(mask.length)),out=new Uint8Array(mask);
  const x0=clamp01(headBounds.x-headBounds.w*.12),x1=clamp01(headBounds.x+headBounds.w*1.12);
  const y0=clamp01(headBounds.y-headBounds.h*.14),y1=clamp01(headBounds.y+headBounds.h*1.07);
  for(let y=0;y<n;y++)for(let x=0;x<n;x++){
    const i=y*n+x;if(categories[i]!==1)continue;
    const u=(rect.x+(x+.5)/n*rect.w)/W,v=(rect.y+(y+.5)/n*rect.h)/H;
    if(u>=x0&&u<=x1&&v>=y0&&v<=y1)out[i]=255;
  }
  return out;
}
export class MaskCache {
  constructor({maxEntries=110}={}){this.masks=new Map();this.pending=new Map();this.maxEntries=maxEntries;this.generation=0;this.lastMessage='';}
  key(c,index){return `${this.generation}:head-v18:${c.id}:${c.shape}:${c.includeFace?1:0}:${c.padding}:${c.feather}:${c.safetyMargin||0}:${index}`;}
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
    const r=concealmentRect(b,c,project.video.width,project.video.height);
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
    // Freeze this exact source frame BEFORE the first async model load/inference.
    // Otherwise playback/tracking may seek the underlying <video> while the
    // PoseLandmarker initializes, caching a mask of a different person/time.
    const frameSnapshot=document.createElement('canvas');
    frameSnapshot.width=Math.min(512,sw);
    frameSnapshot.height=Math.max(1,Math.round(frameSnapshot.width*sh/sw));
    try{frameSnapshot.getContext('2d').drawImage(source,0,0,frameSnapshot.width,frameSnapshot.height);}
    catch{return {fallback:true,reason:'Frame snapshot unavailable'};}
    if(signal?.aborted)throw new DOMException('Cancelled','AbortError');
    // First prefer a separate PoseLandmarker mask for THIS person only.
    // This prevents the multiclass segmenter from expanding to a second
    // person as soon as both enter the same padded crop.
    let category=null,targetPose=null,poseAvailable=false,instances=[];
    if(c.shape==='outline'||c.shape==='skin'||c.shape==='hair'){
      try{
        instances=await ai.poseInstances(frameSnapshot,time,project.video.fps);
        targetPose=selectTargetInstance(instances,b,c.identitySignature||null,frameSnapshot);
        poseAvailable=!!targetPose?.mask;
      }catch(error){this.lastMessage='Pose instance unavailable: '+error.message;}
    }
    // The target head cap MUST survive later instance clipping/dilation.
    // This is the current target pose, not the enlarged history/union box.
    const currentBox=poseAvailable&&iou(targetPose.box,b)>.05?targetPose.box:b;
    const headBounds=c.shape==='outline'?headBoundsFromPose(targetPose?.landmarks,currentBox):null;
    const expandedHead=headBounds?{x:clamp01(headBounds.x-headBounds.w*.12),y:clamp01(headBounds.y-headBounds.h*.14),w:Math.min(1-clamp01(headBounds.x-headBounds.w*.12),headBounds.w*1.24),h:Math.min(1-clamp01(headBounds.y-headBounds.h*.14),headBounds.h*1.21)}:null;
    const safeBounds=expandedHead?unionBounds(currentBox,expandedHead):currentBox;
    let rawMask=null,bodyCoverage=null;
    if(c.shape==='outline'&&poseAvailable){
      rawMask=sampleInstanceMask(targetPose,r,project.video.width,project.video.height);
      // Per-frame pose masks are the only allowed outline source when multiple
      // people are in view: never use the all-person multiclass union.
      const competing=instances.filter(p=>p!==targetPose&&p.mask)
        .map(p=>sampleInstanceMask(p,r,project.video.width,project.video.height));
      rawMask=subtractCompetingInstances(rawMask,competing);
      bodyCoverage=maskRatio(rawMask); // evaluate body BEFORE the head cap is added
      // On analyzed frames, add hair-class pixels *only* in the target head
      // region. The geometric cap remains primary when hair labels are absent.
      if(Math.round(time*project.video.fps)%3===0){
        try{category=await ai.segmentCrop(maskSource);}catch(error){this.lastMessage='Hair classifier unavailable: '+error.message;}
      }
      rawMask=unionHeadRegion(rawMask,r,project.video.width,project.video.height,headBounds);
      rawMask=addTargetHairPixels(rawMask,category?.data,r,project.video.width,project.video.height,headBounds);
    }else{
      try{category=await ai.segmentCrop(maskSource);}catch(error){this.lastMessage=error.message;}
      if(category&&c.shape!=='outline')rawMask=selectCategories(category.data,c.shape,!!c.includeFace);
      if(rawMask&&poseAvailable){
        const personMask=sampleInstanceMask(targetPose,r,project.video.width,project.video.height);
        for(let i=0;i<rawMask.length;i++)rawMask[i]=Math.round(rawMask[i]*(personMask[i]/255));
      }
    }
    // Get other people's current detections (frame cache makes tracking fast).
    // If pose masks are unavailable, reject parts of the crop occupied ONLY
    // by separate unselected people. Explicit exclusions are also respected.
    let detections=[];
    try{detections=await ai.detect(frameSnapshot,time,project.video.fps);}catch{}
    const exclude=(project.exclusions||[]).filter(tr=>time>=tr.startTime&&time<=tr.endTime).map(tr=>boxAt(tr,time)).filter(Boolean);
    const nearby=(c.otherPeople||[]).reduce((best,sample)=>Math.abs(sample.t-time)<Math.abs((best?.t??1e9)-time)?sample:best,null);
    const trackedOthers=nearby&&Math.abs(nearby.t-time)<.12?nearby.boxes:[];
    const otherBoxes=detections.filter(d=>iou(d,b)<.38).concat(trackedOthers,exclude);
    // A tracked person may have a larger historical safety box from a crossing.
    // Once they separate, clamp coverage to the target's CURRENT instance box,
    // not the full padded/union region. Cache is frame-local to avoid echoes.
    if(rawMask&&poseAvailable){
      rawMask=confineMaskToTarget(rawMask,r,project.video.width,project.video.height,safeBounds,{margin:.035});
    }
    let usedConservativeBox=false;
    if(!rawMask||maskRatio(rawMask)<.05||(bodyCoverage!==null&&bodyCoverage<.05)){
      usedConservativeBox=true;
      // Strict fallback for the selected person: safe padded box, minus known
      // unrelated non-overlapping people. Never emit an empty mask.
      rawMask=new Uint8Array(TEST_SIZE*TEST_SIZE).fill(255);
      rawMask=confineMaskToTarget(rawMask,r,project.video.width,project.video.height,safeBounds,{margin:.018});
      rawMask=subtractUnrelatedPeople(rawMask,r,project.video.width,project.video.height,safeBounds,otherBoxes);
      if(headBounds)rawMask=unionHeadRegion(rawMask,r,project.video.width,project.video.height,headBounds);
      if(maskRatio(rawMask)<.05)return {fallback:true,reason:'Selected person lost; review this frame'};
      this.lastMessage='Precise pose not detected — bounded conservative box';
    }else{
      rawMask=subtractUnrelatedPeople(rawMask,r,project.video.width,project.video.height,safeBounds,otherBoxes);
      if(headBounds)rawMask=unionHeadRegion(rawMask,r,project.video.width,project.video.height,headBounds);
      if(maskRatio(rawMask)<.05)return {fallback:true,reason:'Selected person mask too small'};
    }
    const feather=Number(c.feather||0),margin=Number(c.safetyMargin||0);
    const radius=Math.ceil((feather+margin)/Math.max(r.w,r.h,1)*TEST_SIZE)+2;
    const grown=dilateMask(rawMask,TEST_SIZE,TEST_SIZE,radius);
    // Reapply explicit exclusions after dilation to avoid halo bleeding into
    // people the user has explicitly marked as "Don't cover".
    let constrained=subtractUnrelatedPeople(grown,r,project.video.width,project.video.height,safeBounds,otherBoxes);
    if(headBounds)constrained=unionHeadRegion(constrained,r,project.video.width,project.video.height,headBounds);
    if(c.precisionCritical){
      // Crucial: no previous-frame alpha blending for selected-person masks.
      // That caused an unrelated person to stay pixelated after separation.
      constrained=confineMaskToTarget(constrained,r,project.video.width,project.video.height,safeBounds,{margin:.045});
    }
    const previous=!c.precisionCritical?this.get(c,Math.round(time*project.video.fps)-1):null;
    const stable=previous&&!previous.fallback&&previous.data?smoothMask(constrained,previous.data,.84):constrained;
    return {fallback:false,data:stable,width:TEST_SIZE,height:TEST_SIZE,reason:usedConservativeBox?'Conservative target box + head':poseAvailable?'Per-person pose mask':'Target-box fallback',ratio:maskRatio(rawMask),instance:poseAvailable};
  }
}
