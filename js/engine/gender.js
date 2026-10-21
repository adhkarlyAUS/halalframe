// HalalFrame v1.12 — optional, on-device "likely woman / likely man" estimate.
// Uses the MIT-licensed Human library (vladmandic/human) face detector +
// FaceRes descriptor, pinned to a fixed version on jsDelivr. Only the small
// head-and-shoulders crops collected during the scan are analysed, in this tab.
// The estimate is a convenience for pre-selecting choices; it is never a
// guarantee, so an unclear result is treated like a woman (covered) by default.
export const HUMAN_VERSION='3.3.6';
export const HUMAN_URL=`https://cdn.jsdelivr.net/npm/@vladmandic/human@${HUMAN_VERSION}/dist/human.esm.js`;
export const HUMAN_MODELS=`https://cdn.jsdelivr.net/npm/@vladmandic/human@${HUMAN_VERSION}/models/`;
const CONFIG={
  modelBasePath:HUMAN_MODELS,backend:'webgl',warmup:'none',cacheSensitivity:0,debug:false,
  face:{enabled:true,detector:{maxDetected:3,minConfidence:.25,rotation:true,return:false},
    mesh:{enabled:false},iris:{enabled:false},emotion:{enabled:false},antispoof:{enabled:false},liveness:{enabled:false},
    description:{enabled:true,minConfidence:.1}},
  body:{enabled:false},hand:{enabled:false},object:{enabled:false},gesture:{enabled:false},segmentation:{enabled:false},filter:{enabled:false}
};
let humanPromise=null;
const MIN_FACE_SCORE=.55,MIN_FACE_PX=22;
export function loadGenderModel(){
  if(!humanPromise)humanPromise=(async()=>{
    const mod=await import(HUMAN_URL);
    const human=new mod.Human(CONFIG);
    await human.load();
    return human;
  })().catch(error=>{humanPromise=null;throw error;});
  return humanPromise;
}
// Probability-of-woman for one face result; genderScore is the classifier's
// confidence in its own label (0 = coin flip).
export function femaleProbability(face){
  if(!face||!face.gender||face.gender==='unknown')return null;
  const s=Math.max(0,Math.min(1,Number(face.genderScore)||0));
  return face.gender==='female'?.5+.5*s:.5-.5*s;
}
// Combine per-sample estimates. Deliberately asymmetric and conservative:
// the classifier score is NOT a calibrated probability, so "man" (the only
// label that can lead to a person being left uncovered, and only after the
// user presses "Cover women only") needs several strong, unanimous samples.
// Anything else - mixed, weak, few samples, no face - stays "unclear" and is
// treated like a woman (covered).
export function summariseGender(probabilities,{minManSamples=3}={}){
  const p=probabilities.filter(x=>Number.isFinite(x));
  if(!p.length)return {label:'unknown',samples:0};
  const mean=p.reduce((a,b)=>a+b,0)/p.length;
  const strongMale=p.every(x=>x<=.2);
  if(strongMale&&p.length>=minManSamples&&mean<=.15)return {label:'man',samples:p.length,mean};
  if(mean>=.56)return {label:'woman',samples:p.length,mean};
  return {label:'unknown',samples:p.length,mean};
}
export async function estimateTrackGender(samples,{signal}={}){
  if(!samples?.length)return {label:'unknown',confidence:0,samples:0};
  const human=await loadGenderModel();
  const probabilities=[];
  for(const sample of samples){
    if(signal?.aborted)throw new DOMException('Cancelled','AbortError');
    try{
      const res=await human.detect(sample.canvas);
      // The crop is centred on this person's head. Use the clear face nearest
      // that position; if two clear faces compete, ownership is ambiguous and
      // the sample is ignored (GPT review P1-10).
      const W=sample.canvas.width||1;
      const clear=(res.face||[]).filter(f=>(f.boxScore??f.score??0)>=MIN_FACE_SCORE&&(f.box?.[2]||0)>=MIN_FACE_PX);
      const central=clear.filter(f=>{const cx=(f.box[0]+f.box[2]/2)/W;return cx>.2&&cx<.8;});
      // Exactly ONE clear face in the whole crop, and it must be central.
      if(clear.length!==1||central.length!==1)continue;
      const face=central[0];
      const p=femaleProbability(face);if(p!==null)probabilities.push(p);
    }catch{}
  }
  // No single-image exception (GPT round-2 P0): one face prediction is never
  // enough to pre-select Skip, so a photo's people always stay covered unless
  // the user changes them by hand.
  return summariseGender(probabilities,{minManSamples:3});
}
export function genderCaption(g){
  if(!g)return 'Checking…';
  // No percentages: the face model's score is not a calibrated probability.
  if(g.label==='woman')return 'Likely woman';
  if(g.label==='man')return `Likely man (${g.samples} clear face${g.samples===1?'':'s'})`;
  return g.samples?'Unclear — kept covered':'Face not visible — kept covered';
}
