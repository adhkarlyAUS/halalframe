import {addPoint,clamp,normalizedBox} from '../state.js';
export const TRACK_FPS=15;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export async function seekFrame(video,time,{signal}={}){
  if(signal?.aborted)throw new DOMException('Operation cancelled','AbortError');
  const target=clamp(time,0,Number.isFinite(video.duration)?Math.max(0,video.duration-0.002):time);
  if(Math.abs(video.currentTime-target)<0.004 && video.readyState>=2)return;
  await new Promise((resolve,reject)=>{
    let done=false;
    const end=(err)=>{if(done)return;done=true;clearTimeout(timer);video.removeEventListener('seeked',ok);video.removeEventListener('error',bad);signal?.removeEventListener('abort',aborted);err?reject(err):resolve();};
    const ok=()=>end(), bad=()=>end(new Error('Video could not be decoded')),aborted=()=>end(new DOMException('Operation cancelled','AbortError'));
    video.addEventListener('seeked',ok,{once:true});video.addEventListener('error',bad,{once:true});signal?.addEventListener('abort',aborted,{once:true});
    const timer=setTimeout(()=>end(new Error('Seeking this video timed out')),7500);
    try{video.currentTime=target;}catch(e){end(e);}
  });
}
function iou(a,b){const ix=Math.max(a.x,b.x),iy=Math.max(a.y,b.y),iw=Math.max(0,Math.min(a.x+a.w,b.x+b.w)-ix),ih=Math.max(0,Math.min(a.y+a.h,b.y+b.h)-iy);const inter=iw*ih;return inter/Math.max(1e-7,a.w*a.h+b.w*b.h-inter);}
const center=b=>({x:b.x+b.w/2,y:b.y+b.h/2});
export function personThumbnail(source,b){
  const W=source.videoWidth||source.naturalWidth||source.width||1,H=source.videoHeight||source.naturalHeight||source.height||1;
  const canvas=document.createElement('canvas');canvas.width=104;canvas.height=84;
  const ctx=canvas.getContext('2d');ctx.fillStyle='#131716';ctx.fillRect(0,0,104,84);
  const left=Math.max(0,b.x-.04),top=Math.max(0,b.y-.04),bw=Math.min(1-left,b.w+.08),bh=Math.min(1-top,b.h+.08);
  const factor=Math.min(104/(bw*W),84/(bh*H));
  const drawWidth=bw*W*factor,drawHeight=bh*H*factor;
  try{ctx.drawImage(source,left*W,top*H,bw*W,bh*H,(104-drawWidth)/2,(84-drawHeight)/2,drawWidth,drawHeight);}catch{}
  return canvas.toDataURL('image/jpeg',.60);
}
export function matchPerson(previous, candidates, velocity={x:0,y:0}, delta=1/TRACK_FPS){
  const c=center(previous), px=c.x+velocity.x*delta,py=c.y+velocity.y*delta;
  const scored=candidates.map(b=>{
    const v=center(b),dist=Math.hypot(v.x-px,v.y-py),sizePenalty=Math.abs(Math.log(Math.max(1e-5,b.w*b.h)/Math.max(1e-5,previous.w*previous.h)));
    const overlap=iou(previous,b);
    const distanceScore=Math.exp(-dist*7);
    const sizeScore=Math.exp(-sizePenalty);
    const score=0.42*overlap+0.38*distanceScore+0.20*sizeScore;
    return {box:b,score,dist,overlap,confidence:Math.min(b.confidence,score)};
  }).sort((a,b)=>b.score-a.score);
  return scored.length&&scored[0].score>=0.28&&scored[0].dist<0.32?{...scored[0],ambiguous:scored.length>1&&(scored[1].score>scored[0].score-0.10||iou(scored[0].box,scored[1].box)>0.13)}:null;
}
const smoothed=(prev,b,alpha=0.63)=>normalizedBox(Object.fromEntries(['x','y','w','h'].map(k=>[k,prev[k]*(1-alpha)+b[k]*alpha])));
export async function trackDirection({video,project,concealment,ai,direction=1,checkEvery=0,onProgress=()=>{},onReview=async()=>({action:'continue'}),onFrame=()=>{},signal}){
  if(direction!==1&&direction!==-1)throw new Error('Tracking direction must be +1 or -1');
  video.pause();const oldTime=video.currentTime;
  const ordered=[...concealment.track].sort((a,b)=>a.t-b.t);
  let last=direction>0?ordered.at(-1):ordered[0];
  let previous=direction>0?ordered.at(-2):ordered[1];
  let velocity={x:0,y:0};
  if(previous){const dt=last.t-previous.t||0.067;velocity={x:(center(last).x-center(previous).x)/dt,y:(center(last).y-center(previous).y)/dt};}
  const start=last.t,max=direction>0?project.video.duration:0;
  let misses=0,reviewAt=start,lastReviewAt=-100,steps=0;
  try{
    for(let t=start+direction/TRACK_FPS; direction>0?t<max-0.002:t>max+0.002;t+=direction/TRACK_FPS) {
      if(signal?.aborted)throw new DOMException('Tracking cancelled','AbortError');
      const at=clamp(t,0,Math.max(0,project.video.duration-.002));
      await seekFrame(video,at,{signal});const detections=await ai.detect(video,at,project.video.fps);
      const delta=Math.max(.001,Math.abs(at-last.t));
      const match=matchPerson(last,detections,velocity,delta);
      const warnOverlap=!!match?.ambiguous;
      const weak=!!match&&match.confidence<0.50;
      if(!match)misses+=1/TRACK_FPS;else misses=0;
      let reason=misses>=0.50?'Subject lost for over 0.5 seconds':warnOverlap?'People crossed or overlapped':weak?'Low-confidence tracking match':null;
      if(!reason && checkEvery && Math.abs(at-reviewAt)>=checkEvery)reason=`Scheduled check (${checkEvery} seconds)`;
      if(reason && Math.abs(at-lastReviewAt)<0.7)reason=null;
      if(reason){
        lastReviewAt=at;reviewAt=at;onFrame(at,detections);
        const review=await onReview({time:at,reason,detections,proposed:match?.box||last,direction});
        if(signal?.aborted)throw new DOMException('Tracking cancelled','AbortError');
        if(review.action==='end') {if(direction>0)concealment.endTime=at;else concealment.startTime=at;break;}
        if(review.action==='fix'&&review.box){
          addPoint(concealment,at,review.box,'manual',1);previous=last;last={...review.box,t:at};misses=0;
          if(direction>0)concealment.endTime=Math.max(concealment.endTime,at);else concealment.startTime=Math.min(concealment.startTime,at);
          onProgress(Math.abs((at-start)/(max-start||1)),at);continue;
        }
        if(review.action==='skip') {
          t+=direction*0.9;misses=0;continue;
        }
        // Continue conservatively: extrapolate only a short distance, never unmask.
        misses=0;
      }
      if(match){
        const target=smoothed(last,match.box);
        addPoint(concealment,at,target,'ai',match.confidence);
        const p=center(last),q=center(target);
        velocity={x:clamp((q.x-p.x)/delta,-1,1),y:clamp((q.y-p.y)/delta,-1,1)};
        previous=last;last={...target,t:at};
      }else{
        const holding=normalizedBox(last);
        addPoint(concealment,at,holding,'ai',0);previous=last;last={...holding,t:at};
      }
      if(direction>0)concealment.endTime=Math.max(concealment.endTime,at);else concealment.startTime=Math.min(concealment.startTime,at);
      steps++;if(steps%2===0){onProgress(Math.abs((at-start)/(max-start||1)),at);onFrame(at,detections);await sleep(0);}
    }
    onProgress(1,direction>0?project.video.duration:0);
  } finally {
    if(!signal?.aborted)await seekFrame(video,oldTime).catch(()=>{});
  }
  return concealment;
}
export async function findAllPeople({video,project,ai,onProgress=()=>{},signal}){
  video.pause();const previousTime=video.currentTime;
  const tracks=[];const step=0.25;let scanned=0;
  try{
    for(let t=0;t<project.video.duration-.001;t+=step){
      if(signal?.aborted)throw new DOMException('Scan cancelled','AbortError');
      await seekFrame(video,t,{signal});
      const boxes=await ai.detect(video,t,project.video.fps);
      const available=tracks.filter(x=>t-x.lastT<1.0),used=new Set();
      for(const b of boxes){
        let best=null;for(const tr of available){if(used.has(tr)||!tr.last)continue;const m=matchPerson(tr.last,[b],tr.velocity||{x:0,y:0},t-tr.lastT);if(m&&(!best||m.score>best.score))best={tr,score:m.score};}
        if(best){const tr=best.tr;const old=center(tr.last),fresh=center(b),dt=t-tr.lastT||.25;tr.velocity={x:(fresh.x-old.x)/dt,y:(fresh.y-old.y)/dt};tr.track.push({t,...b,source:'ai'});tr.last=b;tr.lastT=t;used.add(tr);}
        else{const tr={id:`person-${tracks.length+1}`,label:`Person ${tracks.length+1}`,thumbnail:personThumbnail(video,b),track:[{t,...b,source:'ai'}],last:b,lastT:t,velocity:{x:0,y:0}};tracks.push(tr);used.add(tr);}
      }
      scanned++;if(scanned%3===0){onProgress(clamp(t/project.video.duration,0,1),t,tracks.length);await sleep(0);}
    }
  } finally {if(!signal?.aborted)await seekFrame(video,previousTime).catch(()=>{});}
  // Drop tiny false positives but preserve people who enter/leave briefly.
  return tracks.filter(x=>x.track.length>=2).map(tr=>({id:tr.id,label:tr.label,track:tr.track,thumbnail:tr.thumbnail,startTime:tr.track[0].t,endTime:Math.min(project.video.duration,tr.lastT+step)}));
}
