// HalalFrame v1.11 — ByteTrack-inspired, pixel-space, two-stage association.
// This module has no browser or MediaPipe dependencies. All coordinates are
// native video pixels until exported as normalized concealment keyframes.
// ByteTrack method inspiration: motion assignment first, high then low scores.
// No appearance score is allowed to override an otherwise valid motion match.
import {hungarian,appearanceSimilarity} from './identity.js';

const clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
const EPS=1e-8;
export const boxCenter=b=>({x:b.x+b.w/2,y:b.y+b.h/2});
export const boxIoU=(a,b)=>{const w=Math.max(0,Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x)),h=Math.max(0,Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y));const i=w*h;return i/(a.w*a.h+b.w*b.h-i+EPS);};
const median=values=>{const a=[...values].sort((x,y)=>x-y);return a.length?a[Math.floor(a.length/2)]:0;};
export function pixelDetections(list,W,H){
  return (list||[]).map(b=>{
    if(Array.isArray(b))return {x:b[0],y:b[1],w:b[2],h:b[3],confidence:b[4]>1?b[4]/100:b[4]};
    const norm=b.w<=1&&b.h<=1&&b.x<=1&&b.y<=1;
    return {x:norm?b.x*W:b.x,y:norm?b.y*H:b.y,w:norm?b.w*W:b.w,h:norm?b.h*H:b.h,confidence:(b.confidence??b.score??0)>1?(b.confidence??b.score)/100:(b.confidence??b.score??0)};
  }).filter(b=>b.w>=9&&b.h>=28&&b.confidence>=.20&&b.x+b.w>0&&b.y+b.h>0&&b.x<W&&b.y<H)
    .sort((a,b)=>b.confidence-a.confidence).filter((b,i,arr)=>{
      for(let j=0;j<i;j++)if(boxIoU(b,arr[j])>.62)return false;
      return true;
    });
}
// Two-axis constant velocity Kalman in PIXELS/frame (not normalized seconds).
// P/V covariance is independent for x and y. predict() advances exactly once.
export class PixelKalman {
  constructor(box,frame=0){const p=boxCenter(box);this.axes=[{p:p.x,v:0,p00:100,p01:0,p10:0,p11:25},{p:p.y,v:0,p00:100,p01:0,p10:0,p11:25}];this.frame=frame;}
  predict(frame){
    const dt=frame-this.frame;
    if(!dt)return this.center();
    // The single-target reverse tracker uses increasing logical frames, too.
    const d=clamp(dt,0,60);
    for(const a of this.axes){
      a.p+=a.v*d;
      const p00=a.p00+d*(a.p01+a.p10)+d*d*a.p11;
      a.p00=p00+1.5*d*d;a.p01+=d*a.p11;a.p10+=d*a.p11;a.p11+=.55*d;
    }
    this.frame=frame;return this.center();
  }
  center(){return {x:this.axes[0].p,y:this.axes[1].p};}
  correct(box,confidence=1){
    const target=boxCenter(box),r=clamp(12/(Math.max(.2,confidence)),10,45);
    for(const [a,z] of [[this.axes[0],target.x],[this.axes[1],target.y]]){
      const residual=z-a.p,s=a.p00+r,kp=a.p00/s,kv=a.p10/s;
      const p00=a.p00,p01=a.p01,p10=a.p10,p11=a.p11;
      a.p+=kp*residual;a.v=clamp(a.v+kv*residual,-38,38);
      a.p00=(1-kp)*p00;a.p01=(1-kp)*p01;a.p10=p10-kv*p00;a.p11=p11-kv*p01;
    }
  }
}
const boxAround=(c,w,h)=>({x:c.x-w/2,y:c.y-h/2,w,h});
function stablePixelBox(box,history,W,H){
  const mw=median(history.map(v=>v.w)),mh=median(history.map(v=>v.h));
  let w=Math.max(box.w,mw*.88),h=Math.max(box.h,mh*.88);
  // v1.12: NO absolute share-of-frame cap. A close-up/selfie subject legitimately
  // fills 60–90% of the frame; the old 20% cap shrank the region to a face strip.
  // Growth is bounded relative to this person's own observed median instead.
  const maxArea=Math.max(box.w*box.h,2.2*Math.max(1,mw*mh));
  if(w*h>maxArea){const f=Math.sqrt(maxArea/(w*h));w*=f;h*=f;}
  w=Math.min(w,W);h=Math.min(h,H);
  const c=boxCenter(box);return {x:clamp(c.x-w/2,0,W-w),y:clamp(c.y-h/2,0,H-h),w,h};
}
export function cappedGapBox(track,frame,W,H,fps){
  const age=(frame-track.lastSeen)/fps;
  if(age>1)return null;
  const predicted=track.kalman.center(),hist=track.sizes;
  const baseW=median(hist.map(s=>s.w)),baseH=median(hist.map(s=>s.h));
  const grow=1+Math.min(.3,.3*age),w=baseW*grow,h=baseH*grow;
  const maxA=Math.min(2*baseW*baseH,W*H);
  const f=Math.min(1,Math.sqrt(maxA/(w*h)));
  const a=boxAround(predicted,w*f,h*f);
  a.x=clamp(a.x,0,W-a.w);a.y=clamp(a.y,0,H-a.h);
  return a;
}
function matchCost(track,box,frame,stage,W,H,signature=null){
  const last=track.lastObserved,dt=Math.max(1,frame-track.lastSeen);
  const medW=median(track.sizes.map(b=>b.w)),medH=median(track.sizes.map(b=>b.h));
  const scale=medH||last.h;
  const predCenter=track.kalman.center(),center=boxCenter(box);
  const dist=Math.hypot(center.x-predCenter.x,center.y-predCenter.y);
  // Per-frame motion gate: no association to a person hundreds of pixels away.
  // After a disappearance, the search radius grows ONLY in the predicted vicinity.
  const gate=Math.min(scale*1.3,Math.max(16,.60*scale*Math.min(2.2,Math.sqrt(dt))));
  const ratio=(box.w*box.h)/Math.max(1,medW*medH);
  if(dist>gate||ratio<.35||ratio>1.85||box.h>medH*1.38||box.w>medW*1.60)return Infinity;
  if(dt<=4 && dist>.37*scale && boxIoU(box,track.predicted)<.015)return Infinity;
  // Appearance is a RE-ACQUISITION veto only, NEVER a replacement for motion.
  // It cannot select a distant newcomer at the right edge of the screen.
  const app=dt>2&&track.appearance&&signature?appearanceSimilarity(track.appearance,signature):null;
  if(app!==null&&app<.35)return Infinity;
  const overlap=boxIoU(track.predicted,box);
  const sizePenalty=Math.min(1,Math.abs(Math.log(ratio))/1.4);
  const distancePenalty=dist/Math.max(1,gate);
  // Use APPEARANCE only when re-acquiring lost targets; never in stage 1/2.
  return .54*(1-overlap)+.36*distancePenalty+.10*sizePenalty+(stage==='low'?.06:0)+(app===null?0:.10*(1-app));
}
const BIRTH_CONFIDENCE=.30;
const maxCost=(stage)=>stage==='high'?.77:.79;
export class ByteTrack {
  constructor({width,height,fps=30,maxLostSeconds=1.5,minHits=6}={}){
    this.width=width;this.height=height;this.fps=fps;this.maxLost=Math.max(1,Math.round(maxLostSeconds*fps));
    this.minHits=minHits;this.tracks=[];this.nextId=1;this.currentDetections=[];this.currentPredictions=[];this.frame=-1;
  }
  makeTrack(box,frame,signature=null){const tr={id:`person-${this.nextId++}`,birth:frame,firstSeen:frame,lastSeen:frame,kalman:new PixelKalman(box,frame),lastObserved:box,box,output:box,predicted:box,sizes:[box],velocity:{x:0,y:0},hits:1,missed:0,reviewGaps:[],pendingReview:null,points:[],confirmed:false,deleted:false,initial:box,appearance:signature};this.tracks.push(tr);return tr;}
  point(tr,frame,box,score,source='ai',uncertain=false){
    const p={frame,t:frame/this.fps,x:box.x/this.width,y:box.y/this.height,w:box.w/this.width,h:box.h/this.height,confidence:score,source,uncertain};
    tr.points.push(p);tr.output=box;return p;
  }
  _stage(detections,indices,tracks,frame,stage,matches,signatures){
    if(!indices.length||!tracks.length)return;
    const cost=tracks.map(tr=>indices.map(j=>matchCost(tr,detections[j],frame,stage,this.width,this.height,signatures?.[j])));
    // Explicit large-cost forbidden edges; do not let appearance bypass motion.
    const pairs=hungarian(cost.map(row=>row.map(n=>Number.isFinite(n)?n:10000)));
    for(const [i,k] of pairs){const c=cost[i][k],j=indices[k];if(!Number.isFinite(c)||c>maxCost(stage))continue;
      matches.push({track:tracks[i],index:j,cost:c});
    }
  }
  update(raw,frame,{signatures=null}={}){
    if(frame<=this.frame)throw new Error('ByteTrack frames must advance monotonically');
    const W=this.width,H=this.height,detections=pixelDetections(raw,W,H);
    this.frame=frame;this.currentDetections=detections;
    const active=this.tracks.filter(tr=>frame-tr.lastSeen<=this.maxLost&&!tr.deleted);
    for(const tr of active){const p=tr.kalman.predict(frame);tr.predicted={x:p.x-tr.lastObserved.w/2,y:p.y-tr.lastObserved.h/2,w:tr.lastObserved.w,h:tr.lastObserved.h};}
    const high=detections.map((d,j)=>d.confidence>=.50?j:-1).filter(j=>j>=0);
    const low=detections.map((d,j)=>d.confidence>=.20&&d.confidence<.50?j:-1).filter(j=>j>=0);
    const matches=[];
    this._stage(detections,high,active,frame,'high',matches,signatures);
    const usedTracks=new Set(matches.map(m=>m.track)),usedDetections=new Set(matches.map(m=>m.index));
    this._stage(detections,low,active.filter(x=>!usedTracks.has(x)),frame,'low',matches,signatures);
    for(const m of matches){usedTracks.add(m.track);usedDetections.add(m.index);}
    const matched=[];
    for(const m of matches){
      const tr=m.track,ob=detections[m.index],gap=frame-tr.lastSeen;
      const wasLost=gap>1;
      const old=boxCenter(tr.lastObserved),next=boxCenter(ob);
      tr.kalman.correct(ob,ob.confidence);
      tr.velocity={x:(next.x-old.x)/gap,y:(next.y-old.y)/gap};
      const previous=tr.lastSeen;
      tr.lastSeen=frame;tr.lastObserved=ob;tr.sizes.push(ob);if(tr.sizes.length>15)tr.sizes.shift();
      tr.box=stablePixelBox(ob,tr.sizes,W,H);
      tr.hits++;tr.missed=0;tr.confirmed=tr.hits>=this.minHits;
      if(signatures?.[m.index]&&gap<=2)tr.appearance=tr.appearance?tr.appearance.map((x,k)=>.96*x+.04*signatures[m.index][k]):signatures[m.index];
      if(wasLost&&gap>this.fps){tr.reviewGaps.push({from:previous/this.fps,to:frame/this.fps,reason:'Re-detected after an internal detection gap',resolved:false});}
      tr.pendingReview=null;
      this.point(tr,frame,tr.box,ob.confidence,'ai');matched.push(tr);
    }
    // v1.12: also start (tentative) tracks from mid-confidence detections. A
    // walker detected at 0.30–0.49 for many consecutive frames was previously
    // never born until a single ≥0.50 frame, leaving seconds uncovered. The
    // minHits confirmation still filters one-off false positives.
    const unmatchedHigh=high.concat(low.filter(j=>detections[j].confidence>=BIRTH_CONFIDENCE)).filter(j=>!usedDetections.has(j));
    for(const j of unmatchedHigh){
      const box=detections[j];
      // Avoid duplicate tracks for a torso/head partial detection of a matched person.
      const duplicate=this.tracks.some(tr=>frame-tr.lastSeen<=Math.max(2,this.maxLost/4)&&!tr.deleted&&(
        boxIoU(tr.predicted,box)>.32||boxIoU(tr.box,box)>.37));
      if(duplicate)continue;
      const tr=this.makeTrack(box,frame,signatures?.[j]||null);this.point(tr,frame,box,box.confidence,'ai');matched.push(tr);
    }
    for(const tr of active){if(usedTracks.has(tr))continue;
      const gap=frame-tr.lastSeen;tr.missed=gap;
      const hold=cappedGapBox(tr,frame,W,H,this.fps);
      if(hold){this.point(tr,frame,hold,0,'ai',true);tr.pendingReview=null;}
      else if(!tr.pendingReview){tr.pendingReview={at:frame/this.fps,reason:'Subject not detected for more than 1 second'}; /* A terminal exit is not an interior review gap. Add a gap only if re-detected. */}
    }
    this.currentPredictions=active.map(tr=>({id:tr.id,box:tr.predicted,predicted:tr.missed>0,review:tr.pendingReview}));
    return {frame,detections,tracks:this.tracks,matched,predicted:this.currentPredictions};
  }
  get(id){return this.tracks.find(tr=>tr.id===id)||null;}
  pick(x,y,frame,{nearest=true}={}){
    const list=this.tracks.filter(tr=>tr.lastSeen===frame||tr.birth===frame);
    const contain=list.filter(tr=>x>=tr.box.x&&x<=tr.box.x+tr.box.w&&y>=tr.box.y&&y<=tr.box.y+tr.box.h);
    const pool=contain.length?contain:nearest?list:[];
    return [...pool].sort((a,b)=>{const p=boxCenter(a.box),q=boxCenter(b.box);return Math.hypot(x-p.x,y-p.y)-Math.hypot(x-q.x,y-q.y);})[0]||null;
  }
  results({minHits=this.minHits,includeLost=false}={}){
    return this.tracks.filter(tr=>tr.hits>=minHits&&tr.points.length&&tr.box.h>=28).map(tr=>{
      const points=tr.points.slice().sort((a,b)=>a.frame-b.frame);
      const observedAreas=points.filter(p=>p.confidence>.20).map(p=>p.w*p.h).sort((a,b)=>a-b);
      const medianArea=observedAreas[Math.floor(observedAreas.length/2)]||points[0].w*points[0].h;
      // A global per-person cap prevents a short-lived detector union/oversize
      // from persisting as a giant region on a small CCTV pedestrian.
      // v1.12: only UNCERTAIN (predicted/hold) points are capped; an observed
      // detection of someone approaching the camera is never shrunk.
      for(const p of points)if(p.uncertain&&p.w*p.h>2*medianArea){
        const factor=Math.sqrt((2*medianArea)/(p.w*p.h));
        const cx=p.x+p.w/2,cy=p.y+p.h/2;p.w*=factor;p.h*=factor;
        p.x=clamp(cx-p.w/2,0,1-p.w);p.y=clamp(cy-p.h/2,0,1-p.h);
      }
      // Never extend stale people all the way to the end of the clip.
      return {id:tr.id,label:`Person ${tr.id.split('-').at(-1)}`,track:points,
        startTime:points[0].t,endTime:points.at(-1).t,hits:tr.hits,reviewGaps:tr.reviewGaps};
    });
  }
}
