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
  // v1.12: a pose instance must actually sit on THIS track: its centre inside
  // the track box (expanded 20%) and real overlap. Otherwise a neighbour whose
  // pose was found (while this person's was not) would be masked instead,
  // leaving the tracked person uncovered; returning null forces the
  // conservative whole-box fallback for this person.
  // The mask-based extent is used (a chest-up person's LANDMARK box is only
  // face+shoulders and overlaps the detector box poorly).
  const onTrack=p=>{const e=instanceExtent(p)||p.box,c=centre(e),ex=box.w*.2,ey=box.h*.2;
    return c.x>=box.x-ex&&c.x<=box.x+box.w+ex&&c.y>=box.y-ey&&c.y<=box.y+box.h+ey&&(iou(e,box)>=.12||iou(p.box,box)>=.12);};
  const eligible=ranked.filter(onTrack);
  const best=eligible[0];
  if(!best||best.score<.38)return null;
  if(referenceSignature&&best.appearance<.43)return null;
  if(eligible.length>1&&best.score-eligible[1].score<.035&&best.appearance<.72)return null;
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
  // With shoulders visible the head size is measured, not guessed from the
  // (possibly full-body) box; otherwise keep the generous box-based estimate.
  const measured=shoulders.length>0;
  const height=Math.max(measured?box.h*.06:box.h*.19,Math.max(0,shoulderY-eyeY)*.72,earWidth*.62);
  const width=Math.max(measured?earWidth*1.7:box.w*.48,earWidth*1.58,shoulderWidth*.70);
  // 1.10 head heights ABOVE the eyes extends beyond hairline; >0.3 each
  // side of ear span. Include forehead, eyes, hair, cheeks and upper neck.
  // v1.12: anchor the cap to the HEAD (eyes/ears/shoulders), not to the whole
  // person box. With full-body boxes the old box-relative terms produced tall
  // opaque columns above the head and down to the waist.
  const top=Math.min(eyeY-1.25*height,box.y-Math.min(box.h*.22,height*.9));
  const bottom=Math.max(Math.max(...ys)+.75*height,Math.min(box.y+box.h*.39,Math.max(...ys)+1.6*height));
  const left=measured?centreX-width*.60:Math.min(centreX-width*.60,box.x+box.w*.15);
  const right=measured?centreX+width*.60:Math.max(centreX+width*.60,box.x+box.w*.85);
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
export function addTargetHairPixels(mask,categories,rect,W,H,headBounds,competing=[]){
  if(!categories||!headBounds||categories.length!==mask.length)return mask;
  const n=Math.round(Math.sqrt(mask.length)),out=new Uint8Array(mask);
  // v1.12: long hair falls beside the shoulders and down the chest/back; the
  // old region stopped just below the chin. Extend sideways and downwards, but
  // never claim pixels that another person's pose mask owns.
  const x0=clamp01(headBounds.x-headBounds.w*.40),x1=clamp01(headBounds.x+headBounds.w*1.40);
  const y0=clamp01(headBounds.y-headBounds.h*.60),y1=clamp01(headBounds.y+headBounds.h*2.8);
  for(let y=0;y<n;y++)for(let x=0;x<n;x++){
    const i=y*n+x;if(categories[i]!==1)continue;
    if(competing.some(m=>m[i]>128))continue;
    const u=(rect.x+(x+.5)/n*rect.w)/W,v=(rect.y+(y+.5)/n*rect.h)/H;
    if(u>=x0&&u<=x1&&v>=y0&&v<=y1)out[i]=255;
  }
  return out;
}
// v1.12: the pose instance mask is soft and frequently drops bare arms,
// shoulders and loose clothing. Inside the selected person's own extent, add
// every multiclass PERSON label (hair, body skin, face skin, clothes) that is
// not owned by a competing pose instance.
export function addTargetPersonPixels(mask,categories,rect,W,H,bounds,competing=[],near=null){
  if(!categories||!bounds||categories.length!==mask.length)return mask;
  const n=Math.round(Math.sqrt(mask.length)),out=new Uint8Array(mask);
  for(let y=0;y<n;y++)for(let x=0;x<n;x++){
    const i=y*n+x,k=categories[i];if(k<1||k>4)continue;
    if(near&&near[i]<128)continue;
    if(competing.some(m=>m[i]>128))continue;
    const u=(rect.x+(x+.5)/n*rect.w)/W,v=(rect.y+(y+.5)/n*rect.h)/H;
    if(u>=bounds.x&&u<=bounds.x+bounds.w&&v>=bounds.y&&v<=bounds.y+bounds.h)out[i]=255;
  }
  return out;
}
// Normalized extent of one pose instance: the foreground component(s) of its
// mask (p>.35) CONNECTED to its own visible landmarks (GPT review P1-5: stray
// isolated pixels must not inflate the extent), unioned with those landmarks.
export function instanceExtent(instance){
  const m=instance?.mask;let box=instance?.box?{...instance.box}:null;
  if(m?.data&&m.width&&m.height){
    const step=Math.max(1,Math.ceil(Math.max(m.width,m.height)/128));
    const gw=Math.ceil(m.width/step),gh=Math.ceil(m.height/step),grid=new Uint8Array(gw*gh);
    for(let gy=0;gy<gh;gy++)for(let gx=0;gx<gw;gx++){
      const x=Math.min(m.width-1,gx*step),y=Math.min(m.height-1,gy*step);
      if(m.data[y*m.width+x]>.35)grid[gy*gw+gx]=1;
    }
    const seeds=[];
    const lms=(instance.landmarks||[]).filter(p=>p&&(p.visibility??1)>.28&&p.x>=0&&p.x<1&&p.y>=0&&p.y<1);
    for(const p of lms){const gx=Math.min(gw-1,Math.floor(p.x*gw)),gy=Math.min(gh-1,Math.floor(p.y*gh));
      // search a small neighbourhood: landmarks sit on silhouette edges
      for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++){const x=gx+dx,y=gy+dy;if(x>=0&&y>=0&&x<gw&&y<gh&&grid[y*gw+x]===1)seeds.push(y*gw+x);}
    }
    if(!seeds.length&&!lms.length){for(let i=0;i<grid.length;i++)if(grid[i])seeds.push(i);}
    let x0=gw,y0=gh,x1=-1,y1=-1,found=0;
    const stack=[...seeds];
    for(const i of seeds)grid[i]=2;
    while(stack.length){
      const i=stack.pop(),x=i%gw,y=(i/gw)|0;found++;
      if(x<x0)x0=x;if(x>x1)x1=x;if(y<y0)y0=y;if(y>y1)y1=y;
      if(x>0&&grid[i-1]===1){grid[i-1]=2;stack.push(i-1);}
      if(x<gw-1&&grid[i+1]===1){grid[i+1]=2;stack.push(i+1);}
      if(y>0&&grid[i-gw]===1){grid[i-gw]=2;stack.push(i-gw);}
      if(y<gh-1&&grid[i+gw]===1){grid[i+gw]=2;stack.push(i+gw);}
    }
    if(found>3){const mb={x:x0/gw,y:y0/gh,w:(x1+1)/gw-x0/gw,h:(y1+1)/gh-y0/gh};box=box?unionBounds(box,mb):mb;}
  }
  if(!box)return null;
  const x=clamp01(box.x),y=clamp01(box.y);
  return {x,y,w:Math.max(0,Math.min(1,box.x+box.w)-x),h:Math.max(0,Math.min(1,box.y+box.h)-y)};
}
export function mostlyInside(a,b){
  const w=Math.max(0,Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x)),h=Math.max(0,Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y));
  return w*h>=.7*Math.max(1e-9,a.w*a.h);
}
// Pixel rectangle bounding a person's whole extent, with a small safety pad.
// It is never smaller than the legacy track-box rectangle.
export function coverRect(extent,trackBox,c,W,H){
  const legacy=concealmentRect(trackBox,c,W,H);
  const pad=.06;
  const x=Math.max(0,(extent.x-extent.w*pad)*W),y=Math.max(0,(extent.y-extent.h*pad)*H);
  const r={x,y,w:Math.min(W,(extent.x+extent.w*(1+pad))*W)-x,h:Math.min(H,(extent.y+extent.h*(1+pad))*H)-y};
  const x0=Math.min(r.x,legacy.x),y0=Math.min(r.y,legacy.y);
  return {x:x0,y:y0,w:Math.max(r.x+r.w,legacy.x+legacy.w)-x0,h:Math.max(r.y+r.h,legacy.y+legacy.h)-y0};
}
export class MaskCache {
  constructor({maxEntries=110}={}){this.masks=new Map();this.pending=new Map();this.maxEntries=maxEntries;this.generation=0;this.lastMessage='';}
  key(c,index){return `${this.generation}:head-v18:${c.id}:${c.shape}:${c.includeFace?1:0}:${c.padding}:${c.feather}:${c.safetyMargin||0}:${index}`;}
  get(c,index){const k=this.key(c,index);const entry=this.masks.get(k);if(entry){this.masks.delete(k);this.masks.set(k,entry);}return entry||null;}
  put(c,index,value){const k=this.key(c,index);this.masks.delete(k);this.masks.set(k,value);while(this.masks.size>this.maxEntries)this.masks.delete(this.masks.keys().next().value);return value;}
  clear(){this.generation++;this.masks.clear();this.pending.clear();}
  get size(){return this.masks.size;}
  // v1.12 (GPT review P1-6): ONE frozen copy of the current frame is shared by
  // every person on that frame, and its canvases are recycled once no pending
  // computation still reads them (no per-person/per-frame full-res allocations).
  _snapshots(source,index,sw,sh){
    const cur=this._snap;
    if(cur&&cur.index===index&&cur.source===source&&cur.generation===this.generation){cur.refs++;return cur;}
    const reuse=cur&&cur.refs===0?cur:null;
    try{
      const frameSnapshot=reuse?.frameSnapshot||document.createElement('canvas');
      frameSnapshot.width=Math.min(512,sw);frameSnapshot.height=Math.max(1,Math.round(frameSnapshot.width*sh/sw));
      frameSnapshot.getContext('2d').drawImage(source,0,0,frameSnapshot.width,frameSnapshot.height);
      const k=Math.min(1,1280/Math.max(sw,sh)),fullSnapshot=reuse?.fullSnapshot||document.createElement('canvas');
      fullSnapshot.width=Math.max(1,Math.round(sw*k));fullSnapshot.height=Math.max(1,Math.round(sh*k));
      fullSnapshot.getContext('2d').drawImage(source,0,0,fullSnapshot.width,fullSnapshot.height);
      this._snap={index,source,generation:this.generation,frameSnapshot,fullSnapshot,refs:1};
      return this._snap;
    }catch{return null;}
  }
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
  async compute(args){
    try{return await this._compute(args);}
    finally{if(args._snap)args._snap.refs=Math.max(0,args._snap.refs-1);}
  }
  async _compute(args){
    const {source,project,time,c,ai,signal}=args;
    const b=boxAt(c,time);if(!b)return {fallback:true,reason:'No track point'};
    const VW=project.video.width,VH=project.video.height;
    const sw=source.videoWidth||source.naturalWidth||source.width||VW;
    const sh=source.videoHeight||source.naturalHeight||source.height||VH;
    // Freeze this exact source frame BEFORE the first async model load/inference.
    // Otherwise playback/tracking may seek the underlying <video> while the
    // PoseLandmarker initializes, caching a mask of a different person/time.
    // v1.12: both snapshots are shared by every person on the same frame.
    const snap=this._snapshots(source,Math.round(time*project.video.fps),sw,sh);
    args._snap=snap;
    if(!snap)return {fallback:true,reason:'Frame snapshot unavailable'};
    const {frameSnapshot,fullSnapshot}=snap;
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
    // v1.12 WHOLE-PERSON EXTENT. The detector/track box is often a face/torso
    // box (close-ups, tilted heads). The selected person's own pose mask and
    // landmarks define where their body actually is; the covered rectangle is
    // the union, so arms, shoulders, long hair and lower body are inside it.
    const instanceBox=poseAvailable?instanceExtent(targetPose):null;
    const coverBox=instanceBox?unionBounds(b,instanceBox):b;
    const currentBox=poseAvailable&&iou(targetPose.box,b)>.05?unionBounds(targetPose.box,instanceBox||targetPose.box):coverBox;
    const headBounds=c.shape==='outline'?headBoundsFromPose(targetPose?.landmarks,poseAvailable&&iou(targetPose.box,b)>.05?targetPose.box:b):null;
    const expandedHead=headBounds?{x:clamp01(headBounds.x-headBounds.w*.12),y:clamp01(headBounds.y-headBounds.h*.14),w:Math.min(1-clamp01(headBounds.x-headBounds.w*.12),headBounds.w*1.24),h:Math.min(1-clamp01(headBounds.y-headBounds.h*.14),headBounds.h*1.21)}:null;
    // The legacy padded rectangle of the track box (incl. its extra headroom) is
    // always part of this person's safe area: hair crowns sit above both the
    // detector box and the pose landmarks.
    const legacyRect=concealmentRect(b,c,VW,VH);
    const legacyBounds={x:legacyRect.x/VW,y:legacyRect.y/VH,w:legacyRect.w/VW,h:legacyRect.h/VH};
    let safeBounds=unionBounds(unionBounds(currentBox,coverBox),legacyBounds);
    if(expandedHead)safeBounds=unionBounds(safeBounds,expandedHead);
    const r=coverRect(expandedHead?unionBounds(coverBox,expandedHead):coverBox,b,c,VW,VH);
    if(r.w<2||r.h<2)return {fallback:true,reason:'Box too small'};
    const fw=fullSnapshot.width||sw,fh=fullSnapshot.height||sh;
    const sx=r.x/VW*fw,sy=r.y/VH*fh;
    const bw=Math.min(fw-sx,r.w/VW*fw),bh=Math.min(fh-sy,r.h/VH*fh);
    if(bw<1||bh<1)return {fallback:true,reason:'Invalid crop'};
    const maskSource=document.createElement('canvas');maskSource.width=TEST_SIZE;maskSource.height=TEST_SIZE;
    const sourceCtx=maskSource.getContext('2d',{willReadFrequently:true});
    sourceCtx.fillStyle='#777';sourceCtx.fillRect(0,0,TEST_SIZE,TEST_SIZE);
    try{sourceCtx.drawImage(fullSnapshot,sx,sy,bw,bh,0,0,TEST_SIZE,TEST_SIZE);}catch{return {fallback:true,reason:'Crop unavailable'};}
    let rawMask=null,bodyCoverage=null,competing=[];
    if(c.shape==='outline'&&poseAvailable){
      rawMask=sampleInstanceMask(targetPose,r,VW,VH);
      // Per-frame pose masks are the only allowed outline source when multiple
      // people are in view: never use the all-person multiclass union.
      competing=instances.filter(p=>p!==targetPose&&p.mask).map(p=>sampleInstanceMask(p,r,VW,VH));
      rawMask=subtractCompetingInstances(rawMask,competing);
      bodyCoverage=maskRatio(rawMask); // evaluate body BEFORE the head cap is added
      // v1.12: classify EVERY analysed frame (was every 3rd), so hair and
      // clothing labels never flicker off between model passes.
      try{category=await ai.segmentCrop(maskSource);}catch(error){this.lastMessage='Hair classifier unavailable: '+error.message;}
      rawMask=unionHeadRegion(rawMask,r,VW,VH,headBounds);
      rawMask=addTargetHairPixels(rawMask,category?.data,r,VW,VH,headBounds,competing);
      // Only labels CONNECTED to this person's body/head (within ~6% of the
      // crop) are added: arms and loose clothes yes, distant background no.
      const near=dilateMask(rawMask,TEST_SIZE,TEST_SIZE,Math.round(TEST_SIZE*.06));
      rawMask=addTargetPersonPixels(rawMask,category?.data,r,VW,VH,safeBounds,competing,near);
    }else{
      try{category=await ai.segmentCrop(maskSource);}catch(error){this.lastMessage=error.message;}
      if(category&&c.shape!=='outline')rawMask=selectCategories(category.data,c.shape,!!c.includeFace);
      // v1.12: no pose for THIS person (small, back view, partly visible...):
      // use the multiclass person labels inside their own box instead of a
      // solid rectangle, minus anyone else's pose mask. The solid conservative
      // box below remains the fallback when the labels are too sparse.
      if(category&&c.shape==='outline'){
        competing=instances.filter(p=>p.mask).map(p=>sampleInstanceMask(p,r,VW,VH));
        const own=new Uint8Array(TEST_SIZE*TEST_SIZE);
        rawMask=addTargetPersonPixels(own,category.data,r,VW,VH,legacyBounds,competing);
        rawMask=unionHeadRegion(rawMask,r,VW,VH,headBounds);
        if(maskRatio(rawMask)<.08)rawMask=null;
      }
      if(rawMask&&poseAvailable){
        const personMask=dilateMask(sampleInstanceMask(targetPose,r,VW,VH),TEST_SIZE,TEST_SIZE,3);
        for(let i=0;i<rawMask.length;i++)rawMask[i]=Math.round(rawMask[i]*(personMask[i]/255));
      }
    }
    // Get other people's current detections (frame cache makes tracking fast).
    // If pose masks are unavailable, reject parts of the crop occupied ONLY
    // by separate unselected people. Explicit exclusions are also respected.
    let detections=[];
    try{detections=await ai.detect(frameSnapshot,time,project.video.fps,{tiles:false});}catch{}
    const exclude=(project.exclusions||[]).filter(tr=>time>=tr.startTime&&time<=tr.endTime).map(tr=>boxAt(tr,time)).filter(Boolean);
    const nearby=(c.otherPeople||[]).reduce((best,sample)=>Math.abs(sample.t-time)<Math.abs((best?.t??1e9)-time)?sample:best,null);
    const trackedOthers=nearby&&Math.abs(nearby.t-time)<.12?nearby.boxes:[];
    // subtractUnrelatedPeople() only removes pixels OUTSIDE this person's safe
    // bounds, so a partial self-detection can never uncover the target itself.
    const otherBoxes=detections.filter(d=>iou(d,b)<.38&&iou(d,coverBox)<.38).concat(trackedOthers);
    if(rawMask&&poseAvailable){
      rawMask=confineMaskToTarget(rawMask,r,VW,VH,safeBounds,{margin:.035});
    }
    let usedConservativeBox=false;
    if(!rawMask||maskRatio(rawMask)<.05||(bodyCoverage!==null&&bodyCoverage<.05)){
      usedConservativeBox=true;
      // Strict fallback for the selected person: safe padded box, minus known
      // unrelated non-overlapping people. Never emit an empty mask.
      rawMask=new Uint8Array(TEST_SIZE*TEST_SIZE).fill(255);
      rawMask=confineMaskToTarget(rawMask,r,VW,VH,safeBounds,{margin:.018});
      rawMask=subtractUnrelatedPeople(rawMask,r,VW,VH,safeBounds,otherBoxes.concat(exclude));
      if(headBounds)rawMask=unionHeadRegion(rawMask,r,VW,VH,headBounds);
      if(maskRatio(rawMask)<.05)return {fallback:true,reason:'Selected person lost; review this frame'};
      this.lastMessage='Precise pose not detected — bounded conservative box';
    }else{
      rawMask=subtractUnrelatedPeople(rawMask,r,VW,VH,safeBounds,otherBoxes.concat(exclude));
      if(headBounds)rawMask=unionHeadRegion(rawMask,r,VW,VH,headBounds);
      if(maskRatio(rawMask)<.05)return {fallback:true,reason:'Selected person mask too small'};
    }
    const feather=Number(c.feather||0),margin=Number(c.safetyMargin||0);
    // v1.12: a minimum ~1.2% of the person's size of dilation; pose masks are
    // soft at silhouette edges and a thin exposed rim (arm/shoulder) is a miss.
    const personPx=Math.max(1,Math.max(r.w,r.h));
    const radius=Math.ceil((feather+margin)/personPx*TEST_SIZE)+Math.max(3,Math.round(TEST_SIZE*.012));
    const grown=dilateMask(rawMask,TEST_SIZE,TEST_SIZE,radius);
    // Reapply explicit exclusions after dilation to avoid halo bleeding into
    // people the user has explicitly marked as "Don't cover".
    let constrained=subtractUnrelatedPeople(grown,r,VW,VH,safeBounds,otherBoxes);
    if(headBounds)constrained=unionHeadRegion(constrained,r,VW,VH,headBounds);
    // GPT review P0-3: the user's explicit "Don't cover" choices are applied
    // LAST, after the head cap, so nothing can re-cover an excluded person
    // (pixels genuinely shared with the target's own body stay covered).
    if(exclude.length)constrained=subtractUnrelatedPeople(constrained,r,VW,VH,safeBounds,exclude);
    if(c.precisionCritical){
      // Crucial: no previous-frame alpha blending for selected-person masks.
      // That caused an unrelated person to stay pixelated after separation.
      constrained=confineMaskToTarget(constrained,r,VW,VH,safeBounds,{margin:.045});
    }
    const previous=!c.precisionCritical?this.get(c,Math.round(time*project.video.fps)-1):null;
    const stable=previous&&!previous.fallback&&previous.data&&!previous.rect?smoothMask(constrained,previous.data,.84):constrained;
    return {fallback:false,data:stable,width:TEST_SIZE,height:TEST_SIZE,rect:{x:r.x/VW,y:r.y/VH,w:r.w/VW,h:r.h/VH},
      reason:usedConservativeBox?'Conservative target box + head':poseAvailable?'Per-person pose mask':'Target-box fallback',ratio:maskRatio(rawMask),instance:poseAvailable};
  }
}
