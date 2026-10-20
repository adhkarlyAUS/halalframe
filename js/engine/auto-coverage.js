// A v1.10 person selection is a complete-video job. Manual regions keep their own ranges.
import {addPoint} from '../state.js';
import {normalizeScanGaps,openReviewGaps} from './gap-review.js';
export const isPersonSelection = c => !!c && (c.precisionCritical===true || /^Person\s+\d+/i.test(c.label||''));
export function needsFullTracking(c,duration){
  if(!isPersonSelection(c)||c.enabled===false)return false;
  if(openReviewGaps(c).length)return true;
  if(c.userEnded===true)return false;
  if(c.scanDerived)return false;
  if(c.trackingStatus==='running'||c.trackingStatus==='incomplete'||c.trackingStatus==='pending'||c.trackingStatus==='review')return true;
  const points=c.track||[];
  if(!points.length)return true;
  const start=points[0].t,end=points[points.length-1].t;
  return c.startTime>.04||c.endTime<duration-.04||start>.04||end<duration-.04;
}
export function finalizeFullTrack(c,duration){
  if(!c.track?.length)throw new Error('No person positions available to finish tracking.');
  c.track.sort((a,b)=>a.t-b.t);
  if(c.track[0].t>.0005){if(c.track[0].t<=1/Math.max(1,c.fps||30)+.003)addPoint(c,0,c.track[0],'ai',c.track[0].confidence??0);else(c.reviewGaps??=[]).push({from:0,to:c.track[0].t,reason:'Untracked start',resolved:false});}
  const last=c.track.at(-1);
  if(last.t<duration-.0005){if(duration-last.t<=1/Math.max(1,c.fps||30)+.003)addPoint(c,duration,last,'ai',last.confidence??0);else(c.reviewGaps??=[]).push({from:last.t,to:duration,reason:'Untracked ending',resolved:false});}
  c.startTime=0;c.endTime=duration;c.trackingStatus=c.reviewGaps?.some(g=>!g.resolved)?'review':'complete';
  return c;
}
export function applyCompleteScanTrack(c,tr,duration){
  c.track=structuredClone(tr.track);
  c.precisionCritical=true;c.userEnded=false;c.scanDerived=true;
  // Scan-owned tracks cover only the time when their identity is visible.
  // A natural exit is NOT an unfinished full-video task.
  c.startTime=Number.isFinite(tr.startTime)?tr.startTime:c.track[0]?.t??0;
  c.endTime=Number.isFinite(tr.endTime)?tr.endTime:c.track.at(-1)?.t??duration;
  c.trackingStatus='complete';
  c.reviewGaps=normalizeScanGaps(tr.reviewGaps||[],c.track,c.fps||30);
  if(openReviewGaps(c).length)c.trackingStatus='review';
  return c;
}
