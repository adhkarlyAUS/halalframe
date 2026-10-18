// Multi-object association and low-cost appearance re-identification.
// Coordinates use [0,1]. All appearance samples stay in the current tab.
import {clamp,normalizedBox} from '../state.js';
const EPS=1e-8;
export const centre=b=>({x:b.x+b.w/2,y:b.y+b.h/2});
export const iou=(a,b)=>{const w=Math.max(0,Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x)),h=Math.max(0,Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y));const intersect=w*h;return intersect/(a.w*a.h+b.w*b.h-intersect+EPS);};
const signatureCanvas=typeof document==='undefined'?null:document.createElement('canvas');
const signatureContext=signatureCanvas?.getContext('2d',{willReadFrequently:true});
export function appearanceSignature(source,b){
  if(!signatureContext?.getImageData||!source)return null;
  const W=source.videoWidth||source.naturalWidth||source.width||1,H=source.videoHeight||source.naturalHeight||source.height||1;
  signatureCanvas.width=32;signatureCanvas.height=48;
  try{signatureContext.drawImage(source,clamp(b.x,0,1)*W,clamp(b.y,0,1)*H,Math.max(1,b.w*W),Math.max(1,b.h*H),0,0,32,48);}catch{return null;}
  const image=signatureContext.getImageData(0,0,32,48).data,hist=new Float32Array(48);let total=0;
  // A chest/torso color signature; do not include the background beyond the person crop.
  for(let y=12;y<39;y+=2)for(let x=4;x<28;x+=2){const k=(y*32+x)*4;
    const r=image[k]/255,g=image[k+1]/255,b=image[k+2]/255,max=Math.max(r,g,b),min=Math.min(r,g,b),d=max-min;
    let h=0;if(d>1e-4){if(max===r)h=((g-b)/d+6)%6;else if(max===g)h=(b-r)/d+2;else h=(r-g)/d+4;h/=6;}
    const s=max?d/max:0,hue=s<.12?10:Math.min(9,Math.floor(h*10)),value=Math.min(3,Math.floor(max*4));
    hist[hue*4+value]++;total++;
  }
  if(!total)return null;
  for(let i=0;i<hist.length;i++)hist[i]/=total;
  return [...hist];
}
export function appearanceSimilarity(a,b){
  if(!a||!b||a.length!==b.length)return .5;
  let bc=0;for(let i=0;i<a.length;i++)bc+=Math.sqrt(Math.max(0,a[i]*b[i]));
  return clamp(bc,0,1);
}
// Two independent constant-velocity Kalman axes (position + velocity).
// Measurements are normalized video-frame centre coordinates.
export class ConstantVelocityKalman {
  constructor(box){const p=centre(box);this.axes=[this.makeAxis(p.x),this.makeAxis(p.y)];}
  makeAxis(position){return {p:position,v:0,p00:.03,p01:0,p10:0,p11:.12};}
  forecast(dt){return {x:this.axes[0].p+dt*this.axes[0].v,y:this.axes[1].p+dt*this.axes[1].v};}
  update(box,dt){
    const z=centre(box),q=.004,r=.0025,d=Math.max(0,Math.min(3,dt));
    for(const [axis,measurement] of [[this.axes[0],z.x],[this.axes[1],z.y]]){
      const position=axis.p+d*axis.v;
      const p00=axis.p00+d*(axis.p01+axis.p10)+d*d*axis.p11+q*d*d*d*d/4;
      const p01=axis.p01+d*axis.p11+q*d*d*d/2;
      const p10=axis.p10+d*axis.p11+q*d*d*d/2;
      const p11=axis.p11+q*d*d;
      const innovation=measurement-position,s=p00+r,k0=p00/s,k1=p10/s;
      axis.p=position+k0*innovation;axis.v=axis.v+k1*innovation;
      axis.p00=(1-k0)*p00;axis.p01=(1-k0)*p01;
      axis.p10=p10-k1*p00;axis.p11=p11-k1*p01;
    }
  }
}
export function poseBodySignature(landmarks){
  if(!landmarks?.length)return null;
  const get=i=>landmarks[i]&&((landmarks[i].visibility??1)>.35)?landmarks[i]:null;
  const pair=(a,b)=>{const x=get(a),y=get(b);return x&&y?Math.hypot(x.x-y.x,x.y-y.y):null;};
  const shoulders=pair(11,12),hips=pair(23,24);
  const torsoL=pair(11,23),torsoR=pair(12,24),legs=pair(23,25);
  const height=(torsoL&&torsoR)?(torsoL+torsoR)/2:null;
  if(!height||!shoulders||!hips)return null;
  return [shoulders/height,hips/height,legs?legs/height:0];
}
export function poseSimilarity(a,b){if(!a||!b)return .5;return Math.exp(-a.reduce((n,x,i)=>n+Math.min(2,Math.abs(Math.log(Math.max(.01,x)/Math.max(.01,b[i])))),0)/a.length);}
// Hungarian assignment (minimum cost; rectangular matrices supported).
// Returns row/column pairs. Forbidden associations should carry a large cost.
export function hungarian(cost){
  const n=cost.length,m=cost[0]?.length||0;if(!n||!m)return [];
  const s=Math.max(n,m),a=Array.from({length:s},(_,i)=>Array.from({length:s},(_,j)=>i<n&&j<m?cost[i][j]:.90));
  const u=new Float64Array(s+1),v=new Float64Array(s+1),p=new Int32Array(s+1),way=new Int32Array(s+1);
  for(let i=1;i<=s;i++){
    p[0]=i;let j0=0;const minv=new Float64Array(s+1).fill(Infinity),used=new Uint8Array(s+1);
    do{used[j0]=1;const i0=p[j0];let delta=Infinity,j1=0;
      for(let j=1;j<=s;j++)if(!used[j]){
        const cur=a[i0-1][j-1]-u[i0]-v[j];if(cur<minv[j]){minv[j]=cur;way[j]=j0;}
        if(minv[j]<delta){delta=minv[j];j1=j;}
      }
      for(let j=0;j<=s;j++)if(used[j]){u[p[j]]+=delta;v[j]-=delta;}else minv[j]-=delta;
      j0=j1;
    }while(p[j0]);
    do{const j1=way[j0];p[j0]=p[j1];j0=j1;}while(j0);
  }
  const pairs=[];for(let j=1;j<=s;j++)if(p[j]&&p[j]<=n&&j<=m)pairs.push([p[j]-1,j-1]);return pairs;
}
export function associationCost(track,box,t,signature){
  const dt=Math.max(0,t-track.t),p=centre(track.box),q=centre(box);
  const predicted=track.kalman?.forecast(dt)||{x:p.x+(track.velocity?.x||0)*dt,y:p.y+(track.velocity?.y||0)*dt};
  const pred={x:clamp(predicted.x,0,1),y:clamp(predicted.y,0,1)};
  const distance=Math.hypot(pred.x-q.x,pred.y-q.y);
  const scale=Math.max(.08,Math.hypot(track.box.w,track.box.h));
  const motion=Math.min(1,distance/(scale*1.3));
  const size=Math.min(1,Math.abs(Math.log(Math.max(EPS,box.w*box.h)/Math.max(EPS,track.box.w*track.box.h)))/2);
  const app=1-appearanceSimilarity(track.appearance,signature);
  const overlap=1-iou(track.box,box);
  return .34*motion+.14*size+.40*app+.12*overlap;
}
export class MultiObjectAssociator {
  constructor({threshold=.66}={}){this.tracks=[];this.nextId=1;this.threshold=threshold;}
  update(source,boxes,t){
    const active=this.tracks.filter(x=>t-x.t<3),signatures=boxes.map(b=>appearanceSignature(source,b));
    const costs=active.map(tr=>boxes.map((b,j)=>associationCost(tr,b,t,signatures[j])));
    const pairs=hungarian(costs),used=new Set(),result=[];
    for(const [i,j] of pairs){if(costs[i][j]>this.threshold)continue;
      const tr=active[i],prev=centre(tr.box),next=centre(boxes[j]),dt=Math.max(.01,t-tr.t);
      tr.kalman?.update(boxes[j],dt);
      tr.velocity=tr.kalman?{x:tr.kalman.axes[0].v,y:tr.kalman.axes[1].v}:{x:clamp(.72*(next.x-prev.x)/dt+.28*(tr.velocity?.x||0),-1,1),y:clamp(.72*(next.y-prev.y)/dt+.28*(tr.velocity?.y||0),-1,1)};
      tr.box=normalizedBox(boxes[j]);tr.t=t;tr.seen++;
      if(signatures[j])tr.appearance=tr.appearance?tr.appearance.map((x,k)=>.93*x+.07*signatures[j][k]):signatures[j];
      result.push({id:tr.id,box:boxes[j],cost:costs[i][j],confidence:Math.max(0,1-costs[i][j]),appearance:signatures[j]});used.add(j);
    }
    for(let j=0;j<boxes.length;j++)if(!used.has(j)){
      const tr={id:`identity-${this.nextId++}`,box:normalizedBox(boxes[j]),t,seen:1,velocity:{x:0,y:0},kalman:new ConstantVelocityKalman(boxes[j]),appearance:signatures[j]};
      this.tracks.push(tr);result.push({id:tr.id,box:boxes[j],cost:0,confidence:1,appearance:signatures[j]});
    }
    this.tracks=this.tracks.filter(tr=>t-tr.t<5);
    return result;
  }
}

// Explicit target-identity re-acquisition, independent from the last drifting
// Kalman box. Designed for a selected person in a multi-person scene.
export function rankIdentityCandidates(source,boxes,reference,predicted,anchorBox){
  return (boxes||[]).map(box=>{
    const appearance=appearanceSimilarity(reference,appearanceSignature(source,box));
    const bc=centre(box),pc=centre(predicted||anchorBox||box);
    const radius=Math.max(.09,Math.hypot((anchorBox||box).w,(anchorBox||box).h));
    const distance=Math.hypot(bc.x-pc.x,bc.y-pc.y);
    const motion=Math.exp(-distance/(radius*1.6));
    const size=Math.exp(-Math.abs(Math.log(Math.max(EPS,box.w*box.h)/Math.max(EPS,(anchorBox||box).w*(anchorBox||box).h))));
    const score=(reference?.length?.40*appearance:0)+.32*motion+.23*size+.05*Math.min(1,(box.confidence||.35)/.35)+(reference?.length?0:.40*motion);
    return {box,appearance,motion,size,score,distance};
  }).sort((a,b)=>b.score-a.score);
}
export function chooseIdentityCandidate(ranked,{minimumAppearance=.46,minimumScore=.42}={}){
  const best=ranked?.[0],second=ranked?.[1];
  if(!best||best.score<minimumScore||best.size<.35)return null;
  if(best.appearance<minimumAppearance)return null;
  if(second&&best.score-second.score<.045&&best.appearance-second.appearance<.10)return null;
  return best;
}
