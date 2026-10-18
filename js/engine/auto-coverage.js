// A v1.10 person selection is a complete-video job. Manual regions keep their own ranges.
import {addPoint} from '../state.js';
export const isPersonSelection = c => !!c && (c.precisionCritical===true || /^Person\s+\d+/i.test(c.label||''));
export function needsFullTracking(c,duration){
  if(!isPersonSelection(c)||c.enabled===false||c.userEnded===true)return false;
  if(c.trackingStatus==='running'||c.trackingStatus==='incomplete'||c.trackingStatus==='pending')return true;
  const points=c.track||[];
  if(!points.length)return true;
  const start=points[0].t,end=points[points.length-1].t;
  return c.startTime>.04||c.endTime<duration-.04||start>.04||end<duration-.04;
}
export function finalizeFullTrack(c,duration){
  if(!c.track?.length)throw new Error('No person positions available to finish tracking.');
  c.track.sort((a,b)=>a.t-b.t);
  if(c.track[0].t>.0005)addPoint(c,0,c.track[0],'ai',c.track[0].confidence??0);
  const last=c.track.at(-1);
  if(last.t<duration-.0005)addPoint(c,duration,last,'ai',last.confidence??0);
  c.startTime=0;c.endTime=duration;c.trackingStatus='complete';
  return c;
}
export function applyCompleteScanTrack(c,tr,duration){
  c.track=structuredClone(tr.track);
  c.precisionCritical=true;c.userEnded=false;
  return finalizeFullTrack(c,duration);
}
