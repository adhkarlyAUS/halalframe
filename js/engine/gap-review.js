// HalalFrame 1.11.1 — explicit review state for ambiguous *interior* intervals.
// An identity that simply exits or ceases to be visible has ended its track;
// it must not acquire an imaginary gap extending beyond the last observation.
const clamp=(x,a,b)=>Math.min(b,Math.max(a,x));
export function ensureGapIds(c){
  (c?.reviewGaps||[]).forEach((g,i)=>{if(!g.id)g.id=`gap-${Math.round(g.from*1000)}-${Math.round(g.to*1000)}-${i}`;});
  return c?.reviewGaps||[];
}
export const openReviewGaps=c=>ensureGapIds(c).filter(g=>g.resolved!==true && g.from<c.endTime-.001 && g.to>c.startTime+.001);
export function normalizeScanGaps(gaps=[],points=[],fps=30){
  const observed=(points||[]).filter(p=>(p.confidence??0)>.2).sort((a,b)=>a.t-b.t);
  if(!observed.length)return [];
  const first=observed[0].t,last=observed.at(-1).t,eps=Math.max(.025,1/fps);
  const interior=(gaps||[]).filter(g=>{
    const from=Number(g.from),to=Number(g.to);
    // Re-detection after the interval is essential: terminal track expiry is
    // not evidence of another person we should keep covering.
    return Number.isFinite(from)&&Number.isFinite(to)&&to>from+eps && from>first-eps && to<last+eps &&
      observed.some(p=>p.t>to-eps && p.t<last+eps);
  }).map(g=>({...g,from:clamp(g.from,first,last),to:clamp(g.to,first,last),resolved:g.resolved===true,kind:'interior'}))
    .sort((a,b)=>a.from-b.from||a.to-b.to);
  const merged=[];
  for(const gap of interior){const lastGap=merged.at(-1);
    if(lastGap&&gap.from<=lastGap.to+eps){lastGap.to=Math.max(lastGap.to,gap.to);lastGap.resolved=lastGap.resolved&&gap.resolved;lastGap.reason=lastGap.reason||gap.reason;}
    else merged.push(gap);
  }
  return merged.map((g,i)=>({...g,id:g.id||`review-${Math.round(g.from*1000)}-${Math.round(g.to*1000)}-${i}`}));
}
export function markGapReviewed(concealment,gap,how='confirmed'){
  const target=concealment?.reviewGaps?.find(g=>g===gap||g.id===gap?.id&&g.id);
  if(!target)return false;
  target.resolved=true;target.resolution=how;target.reviewedAt=Date.now();
  if(!openReviewGaps(concealment).length)concealment.trackingStatus='complete';
  return true;
}
export function finishCoverAtGap(concealment,gap){
  if(!concealment||!gap)return false;
  concealment.endTime=clamp(gap.from,concealment.startTime,concealment.endTime);
  concealment.userEnded=true;concealment.trackingStatus='complete';
  // Earlier gaps must still have been reviewed. Do not silently approve them.
  return true;
}
