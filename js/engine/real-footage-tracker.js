// v1.11: sequential full-frame scan shared by Tap/Track and Find All.
// One detection pass produces time-indexed boxes; association is deterministic,
// separate from the detector, and independently regression-tested on real data.
import {ByteTrack,boxCenter,boxIoU,pixelDetections} from './bytetrack.js';
import {appearanceSignature,appearanceSimilarity} from './identity.js';
import {normalizeScanGaps} from './gap-review.js';
import {canSequentialAnalyse} from './sequential-analysis.js';
import {sequentialVideoFrames,drawOrientedFrame} from './sequential-decoder.js';
const cachedScans=new WeakMap();
export function debugFrameForFile(file,frame,targetBox=null){
  const scan=file&&cachedScans.get(file);if(!scan)return null;
  const list=scan.predictions?.[frame]||[];
  let predicted=null;
  if(targetBox?.w){const a=targetBox.w<=1?{x:targetBox.x*scan.width,y:targetBox.y*scan.height,w:targetBox.w*scan.width,h:targetBox.h*scan.height}:targetBox;
    const match=[...list].sort((p,q)=>boxIoU(q.box,a)-boxIoU(p.box,a))[0];
    if(match&&boxIoU(match.box,a)>.1)predicted=normalizedBox(match.box,scan.width,scan.height);
  }
  return {detections:scan.frames[frame]||[],predicted};
}
const nextTick=()=>new Promise(resolve=>setTimeout(resolve,0));
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
function thumbnail(source,box,W,H){
  if(typeof document==='undefined'||!source)return '';
  const canvas=document.createElement('canvas');canvas.width=100;canvas.height=116;
  try{const ctx=canvas.getContext('2d');ctx.fillStyle='#151816';ctx.fillRect(0,0,100,116);
    ctx.drawImage(source,Math.max(0,box.x-8)/W*(source.videoWidth||source.width),Math.max(0,box.y-8)/H*(source.videoHeight||source.height),Math.min(W-box.x+8,box.w+16)/W*(source.videoWidth||source.width),Math.min(H-box.y+8,box.h+16)/H*(source.videoHeight||source.height),0,0,100,116);
    return canvas.toDataURL('image/jpeg',.66);
  }catch{return '';}
}
export async function scanVideoOnce({video,file,project,ai,seekFrame,onProgress=()=>{},signal,force=false}){
  const W=project.video.width,H=project.video.height,fps=Math.max(1,Math.round(project.video.fps||30));
  const n=Math.max(1,Math.ceil(project.video.duration*fps));
  const cacheKey=`${W}x${H}:${fps}:${n}:${file?.size||0}:${file?.lastModified||0}`;
  const stored=file&&cachedScans.get(file);
  if(!force&&stored?.key===cacheKey)return stored;
  const tracker=new ByteTrack({width:W,height:H,fps,maxLostSeconds:1.5,minHits:6});
  const frames=[],predictions=[],frameTimes=[],signatures=[],thumbs=new Map();
  const canDecode=canSequentialAnalyse(file);
  const oldTime=video.currentTime;
  const canvas=typeof document!=='undefined'?document.createElement('canvas'):null;
  const ratio=Math.min(1,512/Math.max(W,H));
  if(canvas){canvas.width=Math.max(2,Math.round(W*ratio));canvas.height=Math.max(2,Math.round(H*ratio));}
  const ctx=canvas?.getContext('2d',{alpha:false});
  const register=async(source,i,time)=>{
    const boxes=await ai.detect(source,time,fps,{force:true});
    // Keep both the real-timestamp and indexed lookup for debug scrubbing.
    ai.frameCache?.set(i,boxes);
    frames.push(boxes);frameTimes.push(time);
    const sig=pixelDetections(boxes,W,H).map(b=>appearanceSignature(source,{x:b.x/W,y:b.y/H,w:b.w/W,h:b.h/H}));
    signatures.push(sig);
    const update=tracker.update(boxes,i,{signatures:sig});predictions.push(update.predicted.map(p=>({id:p.id,box:{...p.box}})));
    if(typeof document!=='undefined')for(const tr of update.matched)if(!thumbs.has(tr.id))thumbs.set(tr.id,thumbnail(source,tr.initial,W,H));
    if(i%5===0||i>=n-1){onProgress(clamp((i+1)/n,0,1),time,tracker.tracks.length);await nextTick();}
  };
  try{
    if(canDecode){
      let i=0;
      // Iterate actual DECODED frames, not an array of target seek positions.
      // VFR footage may have irregular timestamps; no frames are intentionally skipped.
      for await(const {frame,time,meta} of sequentialVideoFrames(file,{signal})){
        try{drawOrientedFrame(ctx,frame,meta,canvas.width,canvas.height);}finally{frame.close();}
        if(signal?.aborted)throw new DOMException('Scanning cancelled','AbortError');
        await register(canvas,i++,time);
      }
    }else{
      // Compatibility-only fallback. The normal Chrome path above never seeks.
      for(let i=0;i<n;i++){
        if(signal?.aborted)throw new DOMException('Scanning cancelled','AbortError');
        const time=Math.min(Math.max(0,project.video.duration-.002),i/fps);
        await seekFrame(video,time,{signal});await register(video,i,time);
      }
    }
    if(!frames.length)throw new Error('No frames decoded for tracking; try Convert for editing.');
  }finally{
    if(!canDecode&&!signal?.aborted)await seekFrame(video,oldTime).catch(()=>{});
  }
  const result={key:cacheKey,tracker,frames,frameTimes,signatures,predictions,thumbs,fps,width:W,height:H};
  if(file)cachedScans.set(file,result);
  return result;
}
export function scanResults(scan,{minHits=6}={}){
  const list=scan.tracker.results({minHits});
  return list.map((tr,i)=>{
    const native=scan.tracker.get(tr.id);
    const endLimit=(native.lastSeen+scan.fps)/scan.fps;
    const points=tr.track.filter(p=>p.t<=endLimit+1e-5);
    const last=points.at(-1);
    return {id:`person-${i+1}`,label:`Person ${i+1}`,sourceId:tr.id,
      track:points.map(({frame,...p})=>({...p,t:scan.frameTimes[frame]??p.t})),startTime:scan.frameTimes[points[0]?.frame]??0,endTime:scan.frameTimes[last?.frame]??last?.t??0,
      thumbnail:scan.thumbs.get(tr.id)||'',reviewGaps:normalizeScanGaps(tr.reviewGaps,points,scan.fps),scanDerived:true};
  });
}
function normalizedBox(box,W,H){return {x:box.x/W,y:box.y/H,w:box.w/W,h:box.h/H};}
export function createTapTrace({frames,signatures=null,anchorFrame,anchorBox,direction=1,width,height,fps=30}){
  if(![1,-1].includes(direction))throw new Error('Direction must be +1 or -1');
  if(!frames?.[anchorFrame])throw new Error('No person detection data at selected frame');
  const tracker=new ByteTrack({width,height,fps,maxLostSeconds:1.5,minHits:1});
  const anchorDetections=pixelDetections(frames[anchorFrame],width,height);
  const anchor=anchorBox.w<=1&&anchorBox.h<=1?{x:anchorBox.x*width,y:anchorBox.y*height,w:anchorBox.w*width,h:anchorBox.h*height}:anchorBox;
  let match=anchorDetections.map(b=>({box:b,overlap:boxIoU(b,anchor),dist:Math.hypot(boxCenter(b).x-boxCenter(anchor).x,boxCenter(b).y-boxCenter(anchor).y)})).sort((a,b)=>b.overlap-a.overlap||a.dist-b.dist)[0];
  if(!match||match.overlap<.12&&match.dist>anchor.h*.35)throw new Error('Selected person is not detected at that frame; tap closer to their body or Draw a box.');
  tracker.update(anchorDetections,0,{signatures:signatures?.[anchorFrame]});
  const target=[...tracker.tracks].sort((a,b)=>boxIoU(b.initial,match.box)-boxIoU(a.initial,match.box))[0];
  if(!target)throw new Error('Could not lock onto the chosen detection');
  const id=target.id,points=[{t:anchorFrame/fps,...normalizedBox(match.box,width,height),confidence:match.box.confidence,source:'ai'}];
  const reviews=[];let lastWarningFrame=-Infinity;
  return {
    anchorFrame,targetId:id,tracker,points,reviews,
    advance(absFrame){
      const logical=Math.abs(absFrame-anchorFrame);
      const result=tracker.update(frames[absFrame],logical,{signatures:signatures?.[absFrame]}),tr=tracker.get(id);
      if(!tr)throw new Error('Tracked person disappeared from the state');
      const last=tr.points.at(-1);
      let point=null;
      if(last?.frame===logical){const {frame,...norm}=last;point={...norm,t:absFrame/fps};points.push(point);}
      let review=null;
      if(tr.pendingReview&&logical-lastWarningFrame>=fps){
        lastWarningFrame=logical;
        review={time:absFrame/fps,reason:tr.pendingReview.reason,proposed:point||normalizedBox(tr.output,width,height),lost:true};
        reviews.push(review);
      }
      const candidates=result.detections.map(b=>normalizedBox(b,width,height));
      const predicted=tr.predicted?normalizedBox(tr.predicted,width,height):null;
      return {point,review,candidates,predicted,matched:tr.lastSeen===logical};
    }
  };
}
// A disconnected global ByteTrack ID is only a PROPOSAL, never an automatic
// identity switch. Search the entire remaining timeline after the selected ID
// expires, but allow the user to compare the two identities before linking.
export function reacquisitionCandidates(scan,lastBox,lastObservedFrame,{direction=1,excluded=new Set()}={}){
  if(!lastBox)return [];
  const last=lastBox.w<=1?{x:lastBox.x*scan.width,y:lastBox.y*scan.height,w:lastBox.w*scan.width,h:lastBox.h*scan.height}:lastBox;
  const a=boxCenter(last),fps=scan.fps||30;
  return (scan.tracker?.tracks||[]).filter(tr=>tr.hits>=6&&!excluded.has(tr.id) &&
    (direction>0?tr.birth>lastObservedFrame+Math.ceil(fps*.6):tr.lastSeen<lastObservedFrame-Math.ceil(fps*.6)))
    .map(tr=>{
      const box=direction>0?tr.initial:tr.lastObserved,b=boxCenter(box);
      const frame=direction>0?tr.birth:tr.lastSeen;
      const dt=Math.abs(frame-lastObservedFrame)/fps;
      const distance=Math.hypot(a.x-b.x,a.y-b.y);
      const size=Math.min(last.h,box.h)/Math.max(last.h,box.h);
      const plausibleRadius=Math.min(scan.width*.42,Math.max(1.8*last.h,1.2*last.h+18*dt));
      const spatialOk=distance<=plausibleRadius && size>=.48 &&
        (box.w*box.h)/(last.w*last.h)>.35 && (box.w*box.h)/(last.w*last.h)<2.2;
      const rawSignature=scan.tracker?.tracks?.find(x=>x.lastSeen===lastObservedFrame)?.appearance;
      const similarity=rawSignature&&tr.appearance?appearanceSimilarity(rawSignature,tr.appearance):null;
      return {sourceId:tr.id,frame,box,track:tr,dt,distance,size,appearance:similarity,
        // Appearance cannot silently accept/reject a target; human confirmation
        // remains mandatory even for apparently strong matches.
        eligible:spatialOk,score:(1-distance/Math.max(1,plausibleRadius))*.65+size*.35+(similarity===null?0:.10*similarity)};
    }).filter(x=>x.eligible)
    .sort((x,y)=>direction>0?x.frame-y.frame||y.score-x.score:y.frame-x.frame||y.score-x.score);
}
export async function followTapFromCachedFrames({scan,anchorFrame,anchorBox,direction=1,signal,onProgress=()=>{},onFrame=()=>{},onReview=async()=>({action:'continue'})}){
  let trace=createTapTrace({frames:scan.frames,signatures:scan.signatures,anchorFrame,anchorBox,direction,width:scan.width,height:scan.height,fps:scan.fps});
  const count=direction>0?scan.frames.length-anchorFrame-1:anchorFrame;
  let stopped=false,lossStart=null,lastObservedFrame=anchorFrame,lastObservedBox=anchorBox;
  let proposed=new Set(),acceptedTrack=null,acceptedPoints=null;
  const points=trace.points.map(p=>({...p,t:scan.frameTimes[anchorFrame]??p.t})),reviewGaps=[];
  const initialThumb=scan.thumbs?.get(scan.tracker?.tracks?.find(tr=>tr.birth===anchorFrame&&boxIoU(tr.initial,anchorBox.w<=1?{x:anchorBox.x*scan.width,y:anchorBox.y*scan.height,w:anchorBox.w*scan.width,h:anchorBox.h*scan.height}:anchorBox)>.25)?.id)||null;
  const initialCropped=initialThumb||null;
  for(let i=1;i<=count;i++){
    if(signal?.aborted)throw new DOMException('Tracking cancelled','AbortError');
    const f=anchorFrame+direction*i;
    let out=null;
    if(!acceptedTrack){
      out=trace.advance(f);
      if(out.point)points.push({...out.point,t:scan.frameTimes[f]??out.point.t});
      if(out.matched){lastObservedFrame=f;lastObservedBox=out.point;lossStart=null;}
      else if(lossStart===null)lossStart=f;
    }else{
      const point=acceptedPoints.get(f);
      if(point){const {frame,...p}=point;points.push({...p,t:scan.frameTimes[f]??p.t});}
      out={candidates:scan.frames[f],predicted:null};
    }
    // A track may terminate permanently inside a crowd. Continue searching
    // for newly born TRACKS, NOT arbitrary detections, until the video ends.
    if(!acceptedTrack&&lossStart!==null&&direction>0&&f-lastObservedFrame>scan.fps){
      const options=reacquisitionCandidates(scan,lastObservedBox,lastObservedFrame,{direction,excluded:proposed});
      const candidate=options.find(x=>x.frame===f);
      if(candidate){
        proposed.add(candidate.sourceId);
        const candidateBox=normalizedBox(candidate.box,scan.width,scan.height);
        const decision=await onReview({kind:'reacquire',time:scan.frameTimes[f]??f/scan.fps,
          reason:`Possible reappearance after ${candidate.dt.toFixed(1)} seconds. Is this the same person?`,
          proposed:candidateBox,detections:scan.frames[f],direction,
          expectedThumb:initialCropped,candidateThumb:scan.thumbs?.get(candidate.sourceId)||null,
          sourceId:candidate.sourceId});
        if(decision.action==='accept'){
          acceptedTrack=candidate.track;
          acceptedPoints=new Map(acceptedTrack.points.map(p=>[p.frame,p]));
          // During the unseen interval, DO NOT interpolate through strangers.
          // The user can later review and explicitly resolve the amber gap.
          reviewGaps.push({from:Math.min(lastObservedFrame,f)/scan.fps,to:Math.max(lastObservedFrame,f)/scan.fps,
            reason:'Selected person hidden during crossing; identity re-acquired with user confirmation',resolved:false,kind:'occlusion'});
          const point=acceptedPoints.get(f);
          if(point){const {frame,...p}=point;points.push({...p,t:scan.frameTimes[f]??p.t});}
          lossStart=null;
        }else if(decision.action==='fix'&&decision.box){
          const box=decision.box.w<=1?{x:decision.box.x*scan.width,y:decision.box.y*scan.height,w:decision.box.w*scan.width,h:decision.box.h*scan.height}:decision.box;
          reviewGaps.push({from:Math.min(lastObservedFrame,f)/scan.fps,to:Math.max(lastObservedFrame,f)/scan.fps,reason:'Manual re-anchor after an occlusion',resolved:false,kind:'occlusion'});
          trace=createTapTrace({frames:scan.frames,signatures:scan.signatures,anchorFrame:f,anchorBox:box,direction,width:scan.width,height:scan.height,fps:scan.fps});
          points.push({t:scan.frameTimes[f]??f/scan.fps,...normalizedBox(box,scan.width,scan.height),source:'manual',confidence:1});
          lastObservedFrame=f;lastObservedBox=box;lossStart=null;
        }else if(decision.action==='end'){stopped=true;break;}
        // "No" and "Keep going" both continue searching. Neither changes ID.
      }
    }
    if(i%3===0||i===count){onProgress(i/Math.max(1,count),scan.frameTimes[f]??f/scan.fps);onFrame(scan.frameTimes[f]??f/scan.fps,out.candidates,out.predicted);await nextTick();}
  }
  if(!acceptedTrack&&lossStart!==null){
    const boundary=anchorFrame+direction*count;
    if(Math.abs(boundary-lastObservedFrame)>scan.fps){
      const from=Math.min(lastObservedFrame,boundary)/scan.fps,to=Math.max(lastObservedFrame,boundary)/scan.fps;
      reviewGaps.push({from,to,reason:'Target lost; no confirmed reappearance. Review the timeline or end cover.',resolved:false,kind:'occlusion'});
      // Persistent gap review is offered in the editor/export; avoid a popup
      // per second of permanently lost footage.
      if(!stopped)await onReview({kind:'lost',time:scan.frameTimes[boundary]??boundary/scan.fps,
        reason:'Person not re-acquired. The remaining interval needs review.',proposed:lastObservedBox,
        detections:scan.frames[boundary]||[],direction,expectedThumb:initialCropped,candidateThumb:null});
    }
  }
  return {points,reviewGaps,stopped,anchorFrame,direction,reacquiredSourceId:acceptedTrack?.id||null};
}
