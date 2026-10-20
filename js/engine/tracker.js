import {addPoint,clamp,normalizedBox} from '../state.js';
import {canSequentialAnalyse,sequentialSampler} from './sequential-analysis.js';
import {scanVideoOnce,scanResults,followTapFromCachedFrames} from './real-footage-tracker.js';
import {appearanceSignature,appearanceSimilarity,hungarian,associationCost,MultiObjectAssociator,iou,poseBodySignature,poseSimilarity,rankIdentityCandidates,chooseIdentityCandidate} from './identity.js';

// Analysis resolution is user-selectable; short clips default to every source frame.
export const TRACK_FPS = 30;
export const analysisFPS = (project, accuracy='best') => accuracy === 'fast' ? 10 : Math.min(60, Math.max(10, project.video.fps || TRACK_FPS));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const MIN_CONTINUATION_CONFIDENCE = 0.18;
const NEW_PERSON_CONFIDENCE = 0.35;
const MAX_BRIDGE_SECONDS = 1.5;
const MAX_MERGE_SECONDS = 3.5; // only when predicted trajectory + size match closely
const LOW_CONFIDENCE_SECONDS = 0.5;
const REVIEW_COOLDOWN_SECONDS = 2.5;
const EPS=1e-8;

export async function seekFrame(video,time,{signal}={}){
  if(signal?.aborted)throw new DOMException('Operation cancelled','AbortError');
  const target=clamp(time,0,Number.isFinite(video.duration)?Math.max(0,video.duration-.002):time);
  if(Math.abs(video.currentTime-target)<.004&&video.readyState>=2)return;
  const attempt=async (at,deadline)=>new Promise((resolve,reject)=>{
    let done=false;
    const end=err=>{if(done)return;done=true;clearTimeout(timer);video.removeEventListener('seeked',ok);video.removeEventListener('error',bad);signal?.removeEventListener('abort',aborted);err?reject(err):resolve();};
    const ok=()=>end(),bad=()=>end(new Error('Video decoder reported an error')),aborted=()=>end(new DOMException('Cancelled','AbortError'));
    video.addEventListener('seeked',ok,{once:true});video.addEventListener('error',bad,{once:true});signal?.addEventListener('abort',aborted,{once:true});
    const timer=setTimeout(()=>end(new Error('Preview seeking timed out')),deadline);
    try{video.currentTime=at;if(Math.abs(video.currentTime-at)<.003&&!video.seeking&&video.readyState>=2)end();}catch(e){end(e);}
  });
  try{await attempt(target,18000);}
  catch(e){if(e.name==='AbortError')throw e;
    // Retry once with a small nudge to force a seeked event on players that
    // suppress same-frame seeks. Sequential export does not call this method.
    const nudge=clamp(target+.025,0,Number.isFinite(video.duration)?Math.max(0,video.duration-.002):target+.025);
    try{await attempt(nudge,22000);}catch(second){if(second.name==='AbortError')throw second;throw new Error('Preview seek failed after retry. Try a shorter H.264 MP4 or Convert for editing.');}
  }
}

const center=b=>({x:b.x+b.w/2,y:b.y+b.h/2});
const boundBox=b=>normalizedBox(b);
function intersectionOverUnion(a,b){
  const x=Math.max(a.x,b.x),y=Math.max(a.y,b.y),w=Math.max(0,Math.min(a.x+a.w,b.x+b.w)-x),h=Math.max(0,Math.min(a.y+a.h,b.y+b.h)-y);
  const inter=w*h;return inter/Math.max(EPS,a.w*a.h+b.w*b.h-inter);
}
// One-Euro centre filter: high base cutoff avoids positional lag, while the
// derivative-controlled cutoff reacts instantly to movement. Box dimensions
// are handled separately by the conservative size stabilizer below.
const euroAlpha=(cutoff,dt)=>1/(1+1/(2*Math.PI*cutoff*Math.max(.001,dt)));
export class OneEuroCentre {
  constructor(box,t,{minCutoff=40,beta=150,derivativeCutoff=1.2}={}) {
    this.minCutoff=minCutoff;this.beta=beta;this.derivativeCutoff=derivativeCutoff;
    this.reset(box,t);
  }
  reset(box,t){this.raw=center(box);this.filtered={...this.raw};this.derivative={x:0,y:0};this.lastTime=t;}
  update(box,t){
    const raw=center(box),dt=Math.max(.001,Math.abs(t-this.lastTime));
    const da=euroAlpha(this.derivativeCutoff,dt),updated={};
    for(const k of ['x','y']){
      const derivative=(raw[k]-this.raw[k])/dt;
      this.derivative[k]+=da*(derivative-this.derivative[k]);
      const cutoff=this.minCutoff+this.beta*Math.abs(this.derivative[k]);
      updated[k]=this.filtered[k]+euroAlpha(cutoff,dt)*(raw[k]-this.filtered[k]);
    }
    this.raw=raw;this.filtered=updated;this.lastTime=t;
    return updated;
  }
}
const moveCentre=(box,c)=>boundBox({x:c.x-box.w/2,y:c.y-box.h/2,w:box.w,h:box.h});

function unionBoxes(a,b){
  const x=Math.min(a.x,b.x),y=Math.min(a.y,b.y),r=Math.max(a.x+a.w,b.x+b.w),bot=Math.max(a.y+a.h,b.y+b.h);
  return boundBox({x,y,w:r-x,h:bot-y});
}
function median(nums){const a=[...nums].sort((a,b)=>a-b);return a.length?(a[(a.length-1)>>1]+a[a.length>>1])/2:0;}

// Constant-velocity prediction uses the most recent *measured* centres, not a stale
// filtered box. Negative dt is supported for backwards tracking.
export function predictBox(previous,velocity={x:0,y:0},dt=0){
  const c=center(previous);
  const x=c.x+clamp(velocity.x*dt,-0.4,0.4)-previous.w/2;
  const y=c.y+clamp(velocity.y*dt,-0.4,0.4)-previous.h/2;
  const w=clamp(previous.w,0.005,1),h=clamp(previous.h,0.005,1);
  return boundBox({x:clamp(x,0,Math.max(0,1-w)),y:clamp(y,0,Math.max(0,1-h)),w,h});
}
export function velocityBetween(older,newer){
  const dt=newer.t-older.t;
  if(!Number.isFinite(dt)||Math.abs(dt)<EPS)return {x:0,y:0};
  const a=center(older),b=center(newer);
  return {x:clamp((b.x-a.x)/dt,-1,1),y:clamp((b.y-a.y)/dt,-1,1)};
}

export function personThumbnail(source,b){
  const W=source.videoWidth||source.naturalWidth||source.width||1,H=source.videoHeight||source.naturalHeight||source.height||1;
  const canvas=document.createElement('canvas');canvas.width=104;canvas.height=84;
  const ctx=canvas.getContext('2d');ctx.fillStyle='#131716';ctx.fillRect(0,0,104,84);
  const left=Math.max(0,b.x-.04),top=Math.max(0,b.y-.04),bw=Math.min(1-left,b.w+.08),bh=Math.min(1-top,b.h+.08);
  const factor=Math.min(104/(bw*W),84/(bh*H)),dw=bw*W*factor,dh=bh*H*factor;
  try{ctx.drawImage(source,left*W,top*H,bw*W,bh*H,(104-dw)/2,(84-dh)/2,dw,dh);}catch{}
  return canvas.toDataURL('image/jpeg',.60);
}

// Match quality is predominantly geometry against a *predicted* box. Detector
// scores below 0.5 do not cause spurious modal prompts on a clean match.
export function matchPerson(previous,candidates,velocity={x:0,y:0},delta=1/TRACK_FPS,{minConfidence=MIN_CONTINUATION_CONFIDENCE}={}){
  const predicted=predictBox(previous,velocity,delta),p=center(predicted);
  const scored=candidates.filter(b=>(b.confidence??1)>=minConfidence&&b.w>0&&b.h>0).map(box=>{
    const c=center(box),distance=Math.hypot(c.x-p.x,c.y-p.y);
    const radius=Math.max(.055,Math.hypot(predicted.w,predicted.h)*.54);
    const distanceScore=Math.exp(-1.3*distance/radius);
    const overlap=intersectionOverUnion(predicted,box);
    const areaRatio=Math.max(EPS,box.w*box.h)/Math.max(EPS,predicted.w*predicted.h);
    const sizeScore=Math.exp(-Math.abs(Math.log(areaRatio))*.7);
    const detectorScore=Math.min(1,(box.confidence??.35)/.35);
    const score=.40*overlap+.37*distanceScore+.18*sizeScore+.05*detectorScore;
    const confidence=clamp(.84*score+.16*detectorScore,0,1);
    return {box,score,confidence,distance,overlap,predicted};
  }).sort((a,b)=>b.score-a.score);
  if(!scored.length)return null;
  const best=scored[0];
  const maxDistance=Math.max(.18,Math.hypot(previous.w,previous.h)*1.20+Math.abs(delta)*.06);
  if(best.score<.25||best.distance>maxDistance)return null;
  return {...best,ambiguous:scored.length>1&&(scored[1].score>best.score-.085||intersectionOverUnion(scored[0].box,scored[1].box)>.15)};
}

// Low-lag centre tracking: position is nearly instantaneous while changes to
// size are deliberately conservative. Historic size prevents the face/torso-only
// detector boxes from rapidly shrinking a previously valid whole-person mask.
export function stableBox(previous,measurement,dt,measurements=[],{uncertain=false,velocity={x:0,y:0},anchor=null}={}){
  const delta=Math.max(.001,Math.abs(dt));
  const p=center(previous),m=center(measurement);
  const motion=Math.hypot(m.x-p.x,m.y-p.y)/delta;
  const posAlpha=motion>.03?.985:.94; // high alpha prevents visible tracking lag
  const c={x:p.x+(m.x-p.x)*posAlpha,y:p.y+(m.y-p.y)*posAlpha};
  const widths=measurements.slice(-9).map(b=>b.w).filter(Number.isFinite);
  const heights=measurements.slice(-9).map(b=>b.h).filter(Number.isFinite);
  const referenceW=widths.length?median(widths):previous.w;
  const referenceH=heights.length?median(heights):previous.h;
  const maxShrink=1-.10*delta;
  const w=Math.max(measurement.w,previous.w*maxShrink,referenceW*.95,(anchor?.w||0)*.95);
  const h=Math.max(measurement.h,previous.h*maxShrink,referenceH*.95,(anchor?.h||0)*.95);
  const result=boundBox({x:clamp(c.x-w/2,0,Math.max(0,1-w)),y:clamp(c.y-h/2,0,Math.max(0,1-h)),w,h});
  return uncertain?unionBoxes(result,predictBox(previous,velocity,dt)):result;
}
// A loss must never remove a person's region from a frame. The area stays
// anchored at the last reliable detection, grows at 10% per second (max 2×),
// and also covers the predicted motion path. Growth is computed from the
// reliable anchor, not from last frame's larger fallback (no runaway growth).
export function conservativeGap(anchor,velocity,elapsed){
  const time=Math.abs(elapsed),growth=Math.min(2,1+0.10*time);
  const c=center(anchor),w=Math.min(1,anchor.w*growth),h=Math.min(1,anchor.h*growth);
  const grown=boundBox({x:clamp(c.x-w/2,0,Math.max(0,1-w)),y:clamp(c.y-h/2,0,Math.max(0,1-h)),w,h});
  const predicted=predictBox(anchor,velocity,elapsed);
  return unionBoxes(grown,predicted);
}

// First try predicted-position matching, then (only after a tracking loss)
// search the whole image for a sufficiently similar-sized reappearance.
// This is deliberately conservative and cannot guarantee identity in crowds.
export function reacquirePerson(anchor,candidates,velocity,delta,{lostFor=0}={}){
  const match=matchPerson(anchor,candidates,velocity,delta);
  if(match)return {...match,reacquired:false};
  if(lostFor<.15||!candidates?.length)return null;
  const pred=predictBox(anchor,velocity,delta),expected=center(pred);
  const candidatesBySize=candidates.filter(b=>{
    if((b.confidence??0)<MIN_CONTINUATION_CONFIDENCE)return false;
    const ratio=(b.w*b.h)/Math.max(EPS,anchor.w*anchor.h);
    const wRatio=b.w/Math.max(EPS,anchor.w),hRatio=b.h/Math.max(EPS,anchor.h);
    return ratio>.38&&ratio<2.8&&wRatio>.48&&wRatio<1.9&&hRatio>.48&&hRatio<1.9;
  }).map(box=>{
    const p=center(box),distance=Math.hypot(p.x-expected.x,p.y-expected.y);
    const predictedDistanceScore=Math.exp(-distance/Math.max(.10,Math.hypot(anchor.w,anchor.h)*1.3));
    const sizeScore=Math.exp(-Math.abs(Math.log((box.w*box.h)/Math.max(EPS,anchor.w*anchor.h))));
    return {box,score:.5*sizeScore+.5*predictedDistanceScore,distance};
  }).sort((a,b)=>b.score-a.score);
  if(!candidatesBySize.length)return null;
  const top=candidatesBySize[0];
  // If two candidates look similarly plausible, ask rather than silently swap.
  if(candidatesBySize.length>1&&top.score-candidatesBySize[1].score<.10)return null;
  // Grow the global search radius while a subject is missing. This keeps
  // searching after the initial 1.5 s bridge window; crowded/ambiguous
  // candidates still fail the separate second-best match safeguard.
  const maxDistance=Math.min(1.45,Math.max(.35,Math.hypot(anchor.w,anchor.h)*1.65)+Math.min(.85,lostFor*.14));
  if(top.distance>maxDistance||top.score<.37)return null;
  return {...top,confidence:Math.max(.51,Math.min(.82,top.score)),reacquired:true,ambiguous:false};
}

async function legacyTrackDirection({video,file=null,project,concealment,ai,direction=1,checkEvery=0,accuracy='best',onProgress=()=>{},onReview=async()=>({action:'continue'}),onFrame=()=>{},signal}){
  if(direction!==1&&direction!==-1)throw new Error('Tracking direction must be +1 or -1');
  video.pause();const oldTime=video.currentTime;
  // Forward tracking uses sequential decode when supported; reverse tracking
  // keeps the existing seek path (reverse decoding requires a GOP cache).
  const sampler=direction>0&&canSequentialAnalyse(file)?sequentialSampler(file,project,{signal}):null;
  let currentSource=video;
  const ordered=[...concealment.track].sort((a,b)=>a.t-b.t);
  let last=direction>0?ordered.at(-1):ordered[0];
  const prior=direction>0?ordered.at(-2):ordered[1];
  if(!last)throw new Error('Select a person or draw a region first');
  let velocity=prior?velocityBetween(prior,last):{x:0,y:0};
  let measuredLast=last,measuredPrior=prior||null, reliableLast=last;
  const start=last.t,end=direction>0?project.video.duration:0;
  const fps=analysisFPS(project,accuracy),step=1/fps;
  let missedFor=0,weakFor=0,ambiguousFor=0,nextPeriodic=Math.abs(start)+(checkEvery||Infinity);
  let lastReviewTime=-Infinity,lastProcessedTime=start,steps=0,endedEarly=false;
  // All people are tracked, even when only one is selected. Never identify a
  // person based solely on a bounding box overlapping the last position.
  const allPeople=new MultiObjectAssociator({threshold:.78});
  let targetIdentity=null;
  try{
    if(sampler)currentSource=await sampler.at(start)||video;
    const initial=await ai.detect(currentSource,start,project.video.fps);
    const initialized=allPeople.update(currentSource,initial,start);
    targetIdentity=initialized.sort((a,b)=>iou(b.box,last)-iou(a.box,last))[0]?.id||null;
    if(!concealment.identitySignature)concealment.identitySignature=appearanceSignature(currentSource,last);
    if(!concealment.refEmbedding&&typeof ai.embedPerson==='function'){
      try{concealment.refEmbedding=await ai.embedPerson(currentSource,last);}catch{concealment.refEmbedding=null;}
    }
    if(!concealment.poseSignature&&typeof ai.poseInstances==='function'){
      try{
        const poses=await ai.poseInstances(currentSource,start,project.video.fps);
        const closest=poses.sort((a,b)=>iou(b.box,last)-iou(a.box,last))[0];
        if(closest&&iou(closest.box,last)>.06)concealment.poseSignature=poseBodySignature(closest.landmarks);
      }catch{/* Colour signature and motion remain available. */}
    }
    if(!concealment.thumbnail&&typeof document!=='undefined')concealment.thumbnail=personThumbnail(currentSource,last);
  }catch{}
  concealment.precisionCritical=true;
  concealment.otherPeople=[];let crossings=0,lastEmbedTime=-Infinity;
  const historySizes=[last];const sizeAnchor={w:last.w,h:last.h};
  const centreFilter=new OneEuroCentre(last,start);
  try{
    const count=Math.ceil(Math.abs(end-start)*fps);
    for(let i=1;i<=count;i++){
      if(signal?.aborted)throw new DOMException('Tracking cancelled','AbortError');
      const at=clamp(start+direction*i*step,0,Math.max(0,project.video.duration-.002));
      if(Math.abs(at-lastProcessedTime)<1e-5)continue;
      if(sampler){currentSource=await sampler.at(at)||currentSource;}
      else{await seekFrame(video,at,{signal});currentSource=video;}
      const detections=await ai.detect(currentSource,at,project.video.fps);
      const signedDT=at-measuredLast.t;
      const assignments=allPeople.update(currentSource,detections,at);
      const assigned=assignments.find(x=>x.id===targetIdentity);
      let match=reacquirePerson(measuredLast,detections,velocity,signedDT,{lostFor:Math.abs(at-measuredLast.t)});
      const expected=predictBox(measuredLast,velocity,signedDT);
      const ranked=rankIdentityCandidates(currentSource,detections,concealment.identitySignature,expected,ordered[0]);
      const identityChoice=chooseIdentityCandidate(ranked,{minimumAppearance:.44,minimumScore:.45});
      if(identityChoice){
        // A good match to the ORIGINAL appearance outranks a stale Kalman box.
        // This is especially important 1–3 seconds after two people cross.
        const candidate=matchPerson(measuredLast,[identityChoice.box],velocity,signedDT);
        const strong=identityChoice.appearance>.64||ranked.length===1&&identityChoice.appearance>.49;
        if(candidate||strong){
          match={...(candidate||{}),box:identityChoice.box,
            confidence:Math.max(.57,Math.min(.98,.52*identityChoice.appearance+.48*identityChoice.score)),
            ambiguous:false,reacquired:!candidate};
          const related=assignments.find(a=>a.box===identityChoice.box);
          if(related)targetIdentity=related.id;
        }
      }else if(targetIdentity&&assignments.length>1){
        // Avoid an ID swap. Prefer a short conservative gap and ask only if
        // ambiguity persists, rather than accepting a nearby wrong person.
        if(assigned){
          const similarity=appearanceSimilarity(concealment.identitySignature,assigned.appearance);
          const candidate=matchPerson(measuredLast,[assigned.box],velocity,signedDT);
          if(candidate&&similarity>.48)match={...candidate,ambiguous:similarity<.56};
          else match=null;
        }else match=null;
      }
      const others=assignments.filter(x=>!match||x.box!==match.box).map(x=>x.box);
      if(others.length)concealment.otherPeople.push({t:at,boxes:others});
      if(assigned?.confidence<.35&&assignments.length>1&&match&&!identityChoice)match.ambiguous=true;
      const crossing=!!(match&&others.some(other=>iou(other,match.box)>.08));
      if(crossing)crossings++;
      if(match&&crossing&&concealment.poseSignature&&typeof ai.poseInstances==='function'&&Math.abs(at-lastEmbedTime)>.45){
        try{
          const poses=await ai.poseInstances(currentSource,at,project.video.fps);
          const pose=poses.sort((a,b)=>iou(b.box,match.box)-iou(a.box,match.box))[0];
          const ratio=poseBodySignature(pose?.landmarks);
          if(ratio&&poseSimilarity(concealment.poseSignature,ratio)<.67){match.ambiguous=true;match.confidence=Math.min(match.confidence,.40);}
        }catch{}
      }
      if(match&&crossing&&concealment.refEmbedding&&typeof ai.embedPerson==='function'&&Math.abs(at-lastEmbedTime)>.45){
        lastEmbedTime=at;
        try{
          const candidate=await ai.embedPerson(currentSource,match.box);
          if(candidate?.length===concealment.refEmbedding.length){
            const dot=candidate.reduce((n,v,i)=>n+v*concealment.refEmbedding[i],0);
            const a=Math.hypot(...candidate),b=Math.hypot(...concealment.refEmbedding);
            const similarity=dot/Math.max(1e-8,a*b);
            if(similarity<.67){match.ambiguous=true;match.confidence=Math.min(match.confidence,.42);}
          }
        }catch{/* Appearance histogram/pose remains as the free fallback. */}
      }
      // A face/upper-torso-only detection must not shrink or pull the full-body
      // mask. Keep predicting from the last reliable whole-person observation.
      if(match&&(match.box.w<ordered[0].w*.78||match.box.h<ordered[0].h*.78))match=null;
      const dt=Math.abs(at-lastProcessedTime);
      lastProcessedTime=at;
      const hadLoss=missedFor>step*.75;
      const weak=!!match&&match.confidence<.50;
      weakFor=weak?weakFor+dt:0;
      missedFor=match?0:missedFor+dt;
      ambiguousFor=match?.ambiguous?ambiguousFor+dt:0;
      const overdue=at>=nextPeriodic&&direction>0||direction<0&&start-at>=nextPeriodic-start;
      const cooldown=Math.abs(at-lastReviewTime)>=REVIEW_COOLDOWN_SECONDS;
      let reason=null;
      if(cooldown){
        if(missedFor>=LOW_CONFIDENCE_SECONDS && !(ranked.length===1&&ranked[0].appearance>.50))reason='Subject lost for over 0.5 seconds';
        else if(ambiguousFor>=LOW_CONFIDENCE_SECONDS)reason='Overlapping people need a position check';
        else if(weakFor>=LOW_CONFIDENCE_SECONDS)reason='Tracking match uncertain for 0.5 seconds';
        else if(checkEvery&&overdue)reason=`Scheduled check (${checkEvery} seconds)`;
      }
      if(reason){
        lastReviewTime=at;nextPeriodic=(direction>0?at:start+(start-at))+(checkEvery||Infinity);
        onFrame(at,detections);
        const review=await onReview({time:at,reason,detections,proposed:match?.box||conservativeGap(reliableLast,velocity,at-reliableLast.t),direction,expectedThumb:concealment.thumbnail||null,candidateThumb:typeof document!=='undefined'?personThumbnail(currentSource,match?.box||ranked[0]?.box||last):null});
        if(signal?.aborted)throw new DOMException('Tracking cancelled','AbortError');
        if(review.action==='end'){
          if(direction>0)concealment.endTime=at;else concealment.startTime=at;
          endedEarly=true;break;
        }
        if(review.action==='fix'&&review.box){
          addPoint(concealment,at,review.box,'manual',1);
          measuredPrior=measuredLast;measuredLast={...review.box,t:at};
          velocity=measuredPrior?velocityBetween(measuredPrior,measuredLast):{x:0,y:0};
          last={...review.box,t:at};reliableLast=last;centreFilter.reset(review.box,at);historySizes.push(last);
          missedFor=weakFor=ambiguousFor=0;
          if(direction>0)concealment.endTime=Math.max(concealment.endTime,at);else concealment.startTime=Math.min(concealment.startTime,at);
          onProgress(Math.abs((at-start)/(end-start||1)),at);continue;
        }
        if(review.action==='skip'){
          // Preserve a conservative mask through the skipped interval.
          for(let skipped=1;skipped<=Math.ceil(.8*fps);skipped++){
            const t=clamp(at+direction*skipped*step,0,Math.max(0,project.video.duration-.002));
            addPoint(concealment,t,conservativeGap(reliableLast,velocity,t-reliableLast.t),'ai',0);
            if(direction>0)concealment.endTime=Math.max(concealment.endTime,t);else concealment.startTime=Math.min(concealment.startTime,t);
          }
          i+=Math.ceil(.8*fps);missedFor=weakFor=ambiguousFor=0;continue;
        }
        // Keep going means resume the entire remaining video; do not reprompt
        // on each low-scoring individual frame.
        missedFor=weakFor=ambiguousFor=0;
      }
      let result,confidence=0;
      if(match){
        const uncertain=match.confidence<.48||match.box.w<measuredLast.w*.85||match.box.h<measuredLast.h*.85;
        sizeAnchor.w=Math.max(sizeAnchor.w,match.box.w);sizeAnchor.h=Math.max(sizeAnchor.h,match.box.h);
        // After a loss restart the filter at the newly observed subject rather
        // than smoothing the inflated safety box into the recovered detection.
        if(hadLoss)centreFilter.reset(match.box,at);
        const filtered=moveCentre(match.box,centreFilter.update(match.box,at));
        result=stableBox(reliableLast,filtered,Math.abs(at-reliableLast.t),historySizes,{uncertain,velocity,anchor:sizeAnchor});
        if(match.confidence>.55&&!match.ambiguous){
          // No union/size-anchor carry-over after identification. Restrict to
          // the current detection even on the first frame after separation.
          // Reject face-only/torso-only detector shrinkage, without carrying
          // an enlarged crossing/union box into later separated frames.
          const w=clamp(Math.max(match.box.w,ordered[0].w*.94),.005,1);
          const h=clamp(Math.max(match.box.h,ordered[0].h*.94),.005,1);
          const cc=center(filtered);
          result=boundBox({x:clamp(cc.x-w/2,0,1-w),y:clamp(cc.y-h/2,0,1-h),w,h});
        }
        confidence=match.confidence;
        measuredPrior=measuredLast;measuredLast={...match.box,t:at};
        reliableLast={...result,t:at};
        velocity=measuredPrior?velocityBetween(measuredPrior,measuredLast):velocity;
        historySizes.push(match.box);if(historySizes.length>12)historySizes.shift();
      }else{
        result=conservativeGap(reliableLast,velocity,at-reliableLast.t);
      }
      addPoint(concealment,at,result,'ai',confidence);
      last={...result,t:at};
      if(direction>0)concealment.endTime=Math.max(concealment.endTime,at);else concealment.startTime=Math.min(concealment.startTime,at);
      steps++;
      if(steps%3===0){onProgress(Math.abs((at-start)/(end-start||1)),at);onFrame(at,detections);await sleep(0);}
    }
    if(!endedEarly&&direction>0){const lastBox=concealment.track.at(-1);if(lastBox&&lastBox.t<project.video.duration) addPoint(concealment,project.video.duration,lastBox,'ai',lastBox.confidence??0);
      concealment.endTime=project.video.duration;
    }else if(!endedEarly){const firstBox=concealment.track[0];if(firstBox&&firstBox.t>0)addPoint(concealment,0,firstBox,'ai',firstBox.confidence??0);concealment.startTime=0;}
    onProgress(1,end);
  }finally{await sampler?.close();if(!signal?.aborted&&!sampler)await seekFrame(video,oldTime).catch(()=>{});}
  return concealment;
}

function predictedTrack(tr,t){return predictBox(tr.last,tr.velocity||{x:0,y:0},t-tr.lastT);}
function makeTrack(box,t,id,source,fps){
  return {id:`person-${id}`,label:`Person ${id}`,identitySignature:appearanceSignature(source,box),thumbnail:personThumbnail(source,box),track:[{t,...box,source:'ai'}],last:box,lastT:t,lastObserved:box,lastObservedT:t,velocity:{x:0,y:0},observations:1,observedTimes:[t],firstT:t,sizeHistory:[box],sizeAnchor:{w:box.w,h:box.h},fps,centreFilter:new OneEuroCentre(box,t)};
}
function fillGap(tr,t,box,confidence){
  const prev=tr.track.at(-1);
  if(!prev)return;
  const dt=t-prev.t;
  if(dt<=0)return;
  // Replace speculative points with linear interpolation between observed
  // positions. Retain a little extra width/height to favour concealment safety.
  const n=Math.max(0,Math.round(dt*tr.fps)-1);
  for(let i=1;i<=n;i++){
    const alpha=i/(n+1),bt=prev.t+alpha*dt;
    const ib={};for(const k of ['x','y','w','h'])ib[k]=prev[k]+(box[k]-prev[k])*alpha;
    const w=Math.max(ib.w,Math.min(prev.w,box.w)*.98),h=Math.max(ib.h,Math.min(prev.h,box.h)*.98);
    const c=center(ib);let gapBox=boundBox({x:c.x-w/2,y:c.y-h/2,w,h});
    const existing=tr.track.find(p=>Math.abs(p.t-bt)<1/(tr.fps*3));
    if(existing&&existing.confidence===0)gapBox=unionBoxes(gapBox,existing);
    addPoint(tr,bt,gapBox,'ai',confidence*.65);
  }
}
function appendObservation(tr,box,t){
  const prev=tr.lastObserved,dt=t-tr.lastObservedT;
  if(dt>MAX_BRIDGE_SECONDS)(tr.reviewGaps??=[]).push({from:tr.lastObservedT,to:t});
  const previousSized=tr.last;
  const uncertain=box.w<previousSized.w*.85||box.h<previousSized.h*.85;
  tr.sizeAnchor.w=Math.max(tr.sizeAnchor.w,box.w);tr.sizeAnchor.h=Math.max(tr.sizeAnchor.h,box.h);
  const filtered=moveCentre(box,tr.centreFilter.update(box,t));
  const output=stableBox(previousSized,filtered,dt,tr.sizeHistory,{uncertain,velocity:tr.velocity,anchor:tr.sizeAnchor});
  fillGap(tr,t,output,box.confidence??.4);
  addPoint(tr,t,output,'ai',box.confidence??.4);
  tr.velocity=velocityBetween({...prev,t:tr.lastObservedT},{...box,t});
  tr.lastObserved=box;tr.lastObservedT=t;tr.last=output;tr.lastT=t;
  tr.observations++;tr.observedTimes.push(t);tr.longGapMarked=false;
  tr.sizeHistory.push(box);if(tr.sizeHistory.length>12)tr.sizeHistory.shift();
}
function linkedAcrossGap(a,b,maxGap=MAX_MERGE_SECONDS){
  const gap=b.firstT-a.lastT;
  if(gap<-.001||gap>maxGap)return false;
  const prediction=predictedTrack(a,b.firstT),first=b.track[0];
  const dist=Math.hypot(center(prediction).x-center(first).x,center(prediction).y-center(first).y);
  const sizeRatio=Math.max(prediction.w*prediction.h,first.w*first.h)/Math.max(EPS,Math.min(prediction.w*prediction.h,first.w*first.h));
  return dist<Math.max(.12,Math.hypot(prediction.w,prediction.h)*.60)&&sizeRatio<3.5;
}
function mergeTracks(tracks){
  const arr=[...tracks].sort((a,b)=>a.firstT-b.firstT);
  for(let i=0;i<arr.length;i++){
    for(let j=i+1;j<arr.length;j++){
      const a=arr[i],b=arr[j];
      if(!linkedAcrossGap(a,b))continue;
      const start=b.track[0],end=a.track.at(-1);
      const gap=start.t-end.t;
      if(gap>MAX_BRIDGE_SECONDS){(a.reviewGaps??=[]).push({from:end.t,to:start.t});}
      if(b.reviewGaps?.length)(a.reviewGaps??=[]).push(...b.reviewGaps);
      fillGap(a,start.t,start,Math.min(end.confidence||.5,start.confidence||.5));
      for(const pt of b.track)addPoint(a,pt.t,pt,pt.source,pt.confidence);
      a.last=b.last;a.lastT=b.lastT;a.lastObserved=b.lastObserved;a.lastObservedT=b.lastObservedT;a.velocity=b.velocity;
      a.observations+=b.observations;a.observedTimes.push(...b.observedTimes);
      arr.splice(j,1);j=i;
    }
  }
  return arr;
}

async function legacyFindAllPeople({video,file=null,project,ai,accuracy='best',onProgress=()=>{},signal}){
  video.pause();const originalTime=video.currentTime;
  const sampler=canSequentialAnalyse(file)?sequentialSampler(file,project,{signal}):null;
  const fps=analysisFPS(project,accuracy),dt=1/fps;
  const tracks=[];let scanned=0,nextId=1;
  try{
    const n=Math.ceil(project.video.duration*fps);
    for(let frame=0;frame<n;frame++){
      if(signal?.aborted)throw new DOMException('Scan cancelled','AbortError');
      const t=Math.min(project.video.duration-.002,frame*dt);
      let analysisSource=video;
      if(sampler){analysisSource=await sampler.at(t);if(!analysisSource)break;}
      else await seekFrame(video,t,{signal});
      // Detector accepts confidence >=0.18; only new tracks require 0.35.
      const boxes=await ai.detect(analysisSource,t,project.video.fps);
      // Keep *every* previously seen person eligible for re-acquisition.
      // A 1.5 s bridge window only governs review warnings, not lifetime.
      // Otherwise a longer disappearance creates a new Person and leaves
      // a safety mask frozen until the end of the clip.
      const active=tracks;
      const signatures=boxes.map(box=>appearanceSignature(analysisSource,box));
      const matrix=active.map(tr=>boxes.map((box,j)=>{
        const m=reacquirePerson(tr.lastObserved,[box],tr.velocity,t-tr.lastObservedT,{lostFor:t-tr.lastObservedT});
        if(!m)return 10;
        const sim=appearanceSimilarity(tr.identitySignature,signatures[j]);
        // Predicted motion, size and appearance jointly determine assignment.
        return (1-m.score)*.60+(1-sim)*.40;
      }));
      const usedTracks=new Set(),usedBoxes=new Set();
      for(const [i,j] of hungarian(matrix)){
        if(matrix[i][j]>.63)continue;
        const tr=active[i];appendObservation(tr,boxes[j],t);
        if(signatures[j])tr.identitySignature=tr.identitySignature?tr.identitySignature.map((x,k)=>.97*x+.03*signatures[j][k]):signatures[j];
        usedTracks.add(tr);usedBoxes.add(j);
      }
      // Account for every moment without a detection: keep a growing,
      // prediction-aware mask until a person reappears or the video ends.
      for(const tr of active){
        if(usedTracks.has(tr))continue;
        const elapsed=t-tr.lastObservedT;
        if(elapsed>=MAX_BRIDGE_SECONDS&&!tr.longGapMarked){
          (tr.reviewGaps??=[]).push({from:tr.lastObservedT,to:t});tr.longGapMarked=true;
        }
        const mask=conservativeGap({...tr.last,t:tr.lastObservedT},tr.velocity,elapsed);
        addPoint(tr,t,mask,'ai',0);
      }
      for(let b=0;b<boxes.length;b++){
        if(usedBoxes.has(b)||boxes[b].confidence<NEW_PERSON_CONFIDENCE)continue;
        // If this detection is extremely near an already-associated track,
        // suppress duplicate partial detections of the same person.
        const duplicate=active.some(tr=>{
          const prediction=predictedTrack(tr,t),p=center(prediction),v=center(boxes[b]);
          return intersectionOverUnion(prediction,boxes[b])>.32||Math.hypot(p.x-v.x,p.y-v.y)<Math.max(.065,Math.hypot(tr.last.w,tr.last.h)*.22);
        });
        if(!duplicate)tracks.push(makeTrack(boxes[b],t,nextId++,analysisSource,fps));
      }
      scanned++;
      if(scanned%4===0){onProgress(clamp((frame+1)/n,0,1),t,tracks.length);await sleep(0);}
    }
  }finally{await sampler?.close();if(!signal?.aborted&&!sampler)await seekFrame(video,originalTime).catch(()=>{});}
  const merged=mergeTracks(tracks).filter(tr=>tr.observations>=3);
  return merged.map((tr,index)=>{
    tr.track.sort((a,b)=>a.t-b.t);
    // Extend to source boundaries ONLY when the first/last observation is near
    // that boundary. This covers short detector misses at opening/closing frames.
    if(tr.firstT<=MAX_BRIDGE_SECONDS&&tr.firstT>0){
      const first=tr.track[0];addPoint(tr,0,first,'ai',0);}
    // Missing detections must not silently end a concealment. Only an explicit
    // user End Here / drag handle can shorten its end time.
    if(tr.lastT<project.video.duration){
      const missing=project.video.duration-tr.lastObservedT;
      const last=conservativeGap({...tr.last,t:tr.lastObservedT},tr.velocity,missing);
      addPoint(tr,project.video.duration,last,'ai',0);
    }
    tr.track.sort((a,b)=>a.t-b.t);
    tr.observedTimes.sort((a,b)=>a-b);
    for(let i=1;i<tr.observedTimes.length;i++){
      if(tr.observedTimes[i]-tr.observedTimes[i-1]>MAX_BRIDGE_SECONDS)
        (tr.reviewGaps??=[]).push({from:tr.observedTimes[i-1],to:tr.observedTimes[i]});
    }
    // Record extended periods covered only by the speculative safety box.
    let lostStart=null,lostEnd=null;
    for(const p of tr.track){
      if(p.confidence===0){if(lostStart===null)lostStart=p.t;lostEnd=p.t;}
      else if(lostStart!==null){if(lostEnd-lostStart>=MAX_BRIDGE_SECONDS)(tr.reviewGaps??=[]).push({from:lostStart,to:lostEnd});lostStart=null;lostEnd=null;}
    }
    if(lostStart!==null&&lostEnd-lostStart>=MAX_BRIDGE_SECONDS)(tr.reviewGaps??=[]).push({from:lostStart,to:lostEnd});
    return {id:`person-${index+1}`,label:`Person ${index+1}`,track:tr.track,thumbnail:tr.thumbnail,identitySignature:tr.identitySignature||null,
      startTime:tr.track[0].t,endTime:tr.track.at(-1).t,reviewGaps:tr.reviewGaps||[]};
  });
}

// v1.11: both UI entry points consume a single sequential pass of EVERY frame.
// Association uses the same ByteTrack motion-only two-stage Hungarian process
// for all people; appearance can only assist a human re-identification review.
export async function trackDirection({video,file=null,project,concealment,ai,direction=1,checkEvery=0,accuracy='best',onProgress=()=>{},onReview=async()=>({action:'continue'}),onFrame=()=>{},signal}){
  if(!file)return legacyTrackDirection({video,file,project,concealment,ai,direction,checkEvery,accuracy,onProgress,onReview,onFrame,signal});
  const fps=Math.max(1,Math.round(project.video.fps||30));
  const scan=await scanVideoOnce({video,file,project,ai,seekFrame,signal,onProgress:(p,t,n)=>onProgress(p*.86,t,n)});
  const tapTime=Number.isFinite(concealment.originalTapTime)?concealment.originalTapTime:
    direction>0?concealment.track[0]?.t:concealment.track[0]?.t;
  let anchorFrame=clamp(Math.round(tapTime*fps),0,scan.frames.length-1);
  if(scan.frameTimes?.length){let best=Infinity;for(let i=0;i<scan.frameTimes.length;i++){const d=Math.abs(scan.frameTimes[i]-tapTime);if(d<best){best=d;anchorFrame=i;}}}
  const seed=concealment.track.find(p=>Math.abs(p.t-tapTime)<.005)||concealment.track.reduce((a,b)=>Math.abs(a.t-tapTime)<Math.abs(b.t-tapTime)?a:b);
  if(!seed)throw new Error('No selected person found to track');
  const result=await followTapFromCachedFrames({scan,anchorFrame,anchorBox:seed,direction,signal,
    onProgress:(p,t)=>onProgress(.86+.14*p,t),onFrame,
    onReview:async data=>{
      // A review prompt must display the ACTUAL time of uncertainty, not the
      // initial tap frame. Seeking is allowed here once per review, never as
      // part of the sequential 600-frame analysis loop.
      await seekFrame(video,data.time,{signal}).catch(()=>{});
      onFrame(data.time,data.detections,data.proposed);
      const expectedThumb=concealment.thumbnail||null;
      const candidateThumb=typeof document!=='undefined'&&data.proposed?personThumbnail(video,data.proposed):null;
      return onReview({...data,expectedThumb,candidateThumb});
    }});;
  for(const point of result.points)addPoint(concealment,point.t,point,point.source||'ai',point.confidence??0);
  concealment.reviewGaps ??= [];
  for(const gap of result.reviewGaps)if(!concealment.reviewGaps.some(g=>Math.abs(g.from-gap.from)<.04&&Math.abs(g.to-gap.to)<.04))concealment.reviewGaps.push(gap);
  if(result.stopped){
    const last=direction>0?Math.max(...result.points.map(x=>x.t)):Math.min(...result.points.map(x=>x.t));
    if(direction>0)concealment.endTime=last;else concealment.startTime=last;
    concealment.userEnded=true;
  }else if(direction>0)concealment.endTime=project.video.duration;
  else concealment.startTime=0;
  // Tracking history may legitimately end after visibility is lost. Do not
  // extrapolate the last box across the entire clip or blur a stationary area.
  onProgress(1,direction>0?project.video.duration:0);
  return concealment;
}
export async function findAllPeople({video,file=null,project,ai,accuracy='best',onProgress=()=>{},signal}){
  if(!file)return legacyFindAllPeople({video,file,project,ai,accuracy,onProgress,signal});
  const scan=await scanVideoOnce({video,file,project,ai,seekFrame,signal,onProgress});
  return scanResults(scan);
}
