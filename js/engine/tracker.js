import {addPoint,clamp,normalizedBox} from '../state.js';

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
  const target=clamp(time,0,Number.isFinite(video.duration)?Math.max(0,video.duration-0.002):time);
  if(Math.abs(video.currentTime-target)<0.004 && video.readyState>=2)return;
  await new Promise((resolve,reject)=>{
    let done=false;
    const end=err=>{if(done)return;done=true;clearTimeout(timer);video.removeEventListener('seeked',ok);video.removeEventListener('error',bad);signal?.removeEventListener('abort',aborted);err?reject(err):resolve();};
    const ok=()=>end(),bad=()=>end(new Error('Video could not be decoded')),aborted=()=>end(new DOMException('Operation cancelled','AbortError'));
    video.addEventListener('seeked',ok,{once:true});video.addEventListener('error',bad,{once:true});signal?.addEventListener('abort',aborted,{once:true});
    const timer=setTimeout(()=>end(new Error('Seeking this video timed out')),7500);
    try{video.currentTime=target;}catch(e){end(e);}
  });
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
function conservativeGap(last,velocity,delta){
  // During temporary loss, cover BOTH the previous and the predicted location.
  const predicted=predictBox(last,velocity,delta);
  return unionBoxes(last,predicted);
}

export async function trackDirection({video,project,concealment,ai,direction=1,checkEvery=0,accuracy='best',onProgress=()=>{},onReview=async()=>({action:'continue'}),onFrame=()=>{},signal}){
  if(direction!==1&&direction!==-1)throw new Error('Tracking direction must be +1 or -1');
  video.pause();const oldTime=video.currentTime;
  const ordered=[...concealment.track].sort((a,b)=>a.t-b.t);
  let last=direction>0?ordered.at(-1):ordered[0];
  const prior=direction>0?ordered.at(-2):ordered[1];
  if(!last)throw new Error('Select a person or draw a region first');
  let velocity=prior?velocityBetween(prior,last):{x:0,y:0};
  let measuredLast=last,measuredPrior=prior||null;
  const start=last.t,end=direction>0?project.video.duration:0;
  const fps=analysisFPS(project,accuracy),step=1/fps;
  let missedFor=0,weakFor=0,ambiguousFor=0,nextPeriodic=Math.abs(start)+(checkEvery||Infinity);
  let lastReviewTime=-Infinity,lastProcessedTime=start,steps=0,endedEarly=false;
  const historySizes=[last];const sizeAnchor={w:last.w,h:last.h};
  const centreFilter=new OneEuroCentre(last,start);
  try{
    const count=Math.ceil(Math.abs(end-start)*fps);
    for(let i=1;i<=count;i++){
      if(signal?.aborted)throw new DOMException('Tracking cancelled','AbortError');
      const at=clamp(start+direction*i*step,0,Math.max(0,project.video.duration-.002));
      if(Math.abs(at-lastProcessedTime)<1e-5)continue;
      await seekFrame(video,at,{signal});
      const detections=await ai.detect(video,at,project.video.fps);
      const signedDT=at-measuredLast.t;
      const match=matchPerson(measuredLast,detections,velocity,signedDT);
      const dt=Math.abs(at-lastProcessedTime);
      lastProcessedTime=at;
      const weak=!!match&&match.confidence<.50;
      weakFor=weak?weakFor+dt:0;
      missedFor=match?0:missedFor+dt;
      ambiguousFor=match?.ambiguous?ambiguousFor+dt:0;
      const overdue=at>=nextPeriodic&&direction>0||direction<0&&start-at>=nextPeriodic-start;
      const cooldown=Math.abs(at-lastReviewTime)>=REVIEW_COOLDOWN_SECONDS;
      let reason=null;
      if(cooldown){
        if(missedFor>=LOW_CONFIDENCE_SECONDS)reason='Subject lost for over 0.5 seconds';
        else if(ambiguousFor>=LOW_CONFIDENCE_SECONDS)reason='Overlapping people need a position check';
        else if(weakFor>=LOW_CONFIDENCE_SECONDS)reason='Tracking match uncertain for 0.5 seconds';
        else if(checkEvery&&overdue)reason=`Scheduled check (${checkEvery} seconds)`;
      }
      if(reason){
        lastReviewTime=at;nextPeriodic=(direction>0?at:start+(start-at))+(checkEvery||Infinity);
        onFrame(at,detections);
        const review=await onReview({time:at,reason,detections,proposed:match?.box||conservativeGap(last,velocity,at-last.t),direction});
        if(signal?.aborted)throw new DOMException('Tracking cancelled','AbortError');
        if(review.action==='end'){
          if(direction>0)concealment.endTime=at;else concealment.startTime=at;
          endedEarly=true;break;
        }
        if(review.action==='fix'&&review.box){
          addPoint(concealment,at,review.box,'manual',1);
          measuredPrior=measuredLast;measuredLast={...review.box,t:at};
          velocity=measuredPrior?velocityBetween(measuredPrior,measuredLast):{x:0,y:0};
          last={...review.box,t:at};centreFilter.reset(review.box,at);historySizes.push(last);
          missedFor=weakFor=ambiguousFor=0;
          if(direction>0)concealment.endTime=Math.max(concealment.endTime,at);else concealment.startTime=Math.min(concealment.startTime,at);
          onProgress(Math.abs((at-start)/(end-start||1)),at);continue;
        }
        if(review.action==='skip'){
          // Preserve a conservative mask through the skipped interval.
          for(let skipped=1;skipped<=Math.ceil(.8*fps);skipped++){
            const t=clamp(at+direction*skipped*step,0,Math.max(0,project.video.duration-.002));
            addPoint(concealment,t,conservativeGap(last,velocity,t-last.t),'ai',0);
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
        const uncertain=match.confidence<.48||match.box.w<last.w*.85||match.box.h<last.h*.85;
        sizeAnchor.w=Math.max(sizeAnchor.w,match.box.w);sizeAnchor.h=Math.max(sizeAnchor.h,match.box.h);
        const filtered=moveCentre(match.box,centreFilter.update(match.box,at));
        result=stableBox(last,filtered,dt,historySizes,{uncertain,velocity,anchor:sizeAnchor});
        confidence=match.confidence;
        measuredPrior=measuredLast;measuredLast={...match.box,t:at};
        velocity=measuredPrior?velocityBetween(measuredPrior,measuredLast):velocity;
        historySizes.push(match.box);if(historySizes.length>12)historySizes.shift();
      }else{
        result=conservativeGap(last,velocity,at-last.t);
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
  }finally{if(!signal?.aborted)await seekFrame(video,oldTime).catch(()=>{});}
  return concealment;
}

function predictedTrack(tr,t){return predictBox(tr.last,tr.velocity||{x:0,y:0},t-tr.lastT);}
function makeTrack(box,t,id,source,fps){
  return {id:`person-${id}`,label:`Person ${id}`,thumbnail:personThumbnail(source,box),track:[{t,...box,source:'ai'}],last:box,lastT:t,lastObserved:box,lastObservedT:t,velocity:{x:0,y:0},observations:1,firstT:t,sizeHistory:[box],sizeAnchor:{w:box.w,h:box.h},fps,centreFilter:new OneEuroCentre(box,t)};
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
    const c=center(ib);addPoint(tr,bt,boundBox({x:c.x-w/2,y:c.y-h/2,w,h}),'ai',confidence*.65);
  }
}
function appendObservation(tr,box,t){
  const prev=tr.lastObserved,dt=t-tr.lastObservedT;
  const previousSized=tr.last;
  const uncertain=box.w<previousSized.w*.85||box.h<previousSized.h*.85;
  tr.sizeAnchor.w=Math.max(tr.sizeAnchor.w,box.w);tr.sizeAnchor.h=Math.max(tr.sizeAnchor.h,box.h);
  const filtered=moveCentre(box,tr.centreFilter.update(box,t));
  const output=stableBox(previousSized,filtered,dt,tr.sizeHistory,{uncertain,velocity:tr.velocity,anchor:tr.sizeAnchor});
  fillGap(tr,t,output,box.confidence??.4);
  addPoint(tr,t,output,'ai',box.confidence??.4);
  tr.velocity=velocityBetween({...prev,t:tr.lastObservedT},{...box,t});
  tr.lastObserved=box;tr.lastObservedT=t;tr.last=output;tr.lastT=t;
  tr.observations++;
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
      a.observations+=b.observations;
      arr.splice(j,1);j=i;
    }
  }
  return arr;
}

export async function findAllPeople({video,project,ai,accuracy='best',onProgress=()=>{},signal}){
  video.pause();const originalTime=video.currentTime;
  const fps=analysisFPS(project,accuracy),dt=1/fps;
  const tracks=[];let scanned=0,nextId=1;
  try{
    const n=Math.ceil(project.video.duration*fps);
    for(let frame=0;frame<n;frame++){
      if(signal?.aborted)throw new DOMException('Scan cancelled','AbortError');
      const t=Math.min(project.video.duration-.002,frame*dt);
      await seekFrame(video,t,{signal});
      // Detector accepts confidence >=0.18; only new tracks require 0.35.
      const boxes=await ai.detect(video,t,project.video.fps);
      const active=tracks.filter(tr=>t-tr.lastObservedT<=MAX_BRIDGE_SECONDS);
      const associations=[];
      for(const tr of active)for(let b=0;b<boxes.length;b++){
        const m=matchPerson(tr.lastObserved,[boxes[b]],tr.velocity,t-tr.lastObservedT);
        if(m)associations.push({tr,index:b,score:m.score});
      }
      associations.sort((a,b)=>b.score-a.score);
      const usedTracks=new Set(),usedBoxes=new Set();
      for(const a of associations){
        if(usedTracks.has(a.tr)||usedBoxes.has(a.index))continue;
        appendObservation(a.tr,boxes[a.index],t);usedTracks.add(a.tr);usedBoxes.add(a.index);
      }
      for(let b=0;b<boxes.length;b++){
        if(usedBoxes.has(b)||boxes[b].confidence<NEW_PERSON_CONFIDENCE)continue;
        // If this detection is extremely near an already-associated track,
        // suppress duplicate partial detections of the same person.
        const duplicate=active.some(tr=>{
          const prediction=predictedTrack(tr,t),p=center(prediction),v=center(boxes[b]);
          return intersectionOverUnion(prediction,boxes[b])>.32||Math.hypot(p.x-v.x,p.y-v.y)<Math.max(.065,Math.hypot(tr.last.w,tr.last.h)*.22);
        });
        if(!duplicate)tracks.push(makeTrack(boxes[b],t,nextId++,video,fps));
      }
      scanned++;
      if(scanned%4===0){onProgress(clamp((frame+1)/n,0,1),t,tracks.length);await sleep(0);}
    }
  }finally{if(!signal?.aborted)await seekFrame(video,originalTime).catch(()=>{});}
  const merged=mergeTracks(tracks).filter(tr=>tr.observations>=3);
  return merged.map((tr,index)=>{
    tr.track.sort((a,b)=>a.t-b.t);
    // Extend to source boundaries ONLY when the first/last observation is near
    // that boundary. This covers short detector misses at opening/closing frames.
    if(tr.firstT<=MAX_BRIDGE_SECONDS&&tr.firstT>0){
      const first=tr.track[0];addPoint(tr,0,first,'ai',0);}
    if(project.video.duration-tr.lastT<=MAX_BRIDGE_SECONDS){
      const last=tr.track.at(-1);addPoint(tr,project.video.duration,last,'ai',0);}
    tr.track.sort((a,b)=>a.t-b.t);
    return {id:`person-${index+1}`,label:`Person ${index+1}`,track:tr.track,thumbnail:tr.thumbnail,
      startTime:tr.track[0].t,endTime:tr.track.at(-1).t,reviewGaps:tr.reviewGaps||[]};
  });
}
