// Optional on-device Music check. MediaPipe AudioClassifier/YAMNet labels
// audible content probabilistically; it cannot certify that music is absent.
// An uninitialized/failed classifier produces an explicit UNVERIFIED status.
export const AUDIO_PACKAGE_VERSION='0.10.22-rc.20250304';
export const AUDIO_PACKAGE=`https://cdn.jsdelivr.net/npm/@mediapipe/tasks-audio@${AUDIO_PACKAGE_VERSION}`;
export const YAMNET_MODEL='https://storage.googleapis.com/mediapipe-models/audio_classifier/yamnet/float32/1/yamnet.tflite';
let classifier=null,initializing=null;
export async function initMusicClassifier(){
  if(classifier)return classifier;
  if(initializing)return initializing;
  initializing=(async()=>{
    const pkg=await import(`${AUDIO_PACKAGE}/audio_bundle.mjs`);
    const files=await pkg.FilesetResolver.forAudioTasks(`${AUDIO_PACKAGE}/wasm`);
    classifier=await pkg.AudioClassifier.createFromOptions(files,{baseOptions:{modelAssetPath:YAMNET_MODEL},maxResults:-1,scoreThreshold:.01});
    return classifier;
  })().finally(()=>{initializing=null;});
  return initializing;
}
export function interpretYamnet(result){
  const all=[],visit=x=>{
    if(!x||typeof x!=='object')return;
    if(Array.isArray(x)){x.forEach(visit);return;}
    if(typeof x.score==='number'&&(x.categoryName||x.displayName)){all.push({name:String(x.categoryName||x.displayName),score:x.score});return;}
    for(const [key,value] of Object.entries(x))if(key!=='headIndex'&&key!=='headName')visit(value);
  };visit(result);
  const maxOf=pattern=>Math.max(0,...all.filter(x=>pattern.test(x.name)).map(x=>x.score));
  return {music:maxOf(/music|musical instrument|singing|drum|piano|keyboard|guitar|bass guitar|synthesizer|orchestra|percussion|violin|cello|trumpet|harp|flute|chord/i),
    speech:maxOf(/speech|narration|conversation|speaking|whispering|male voice|female voice/i),top:all.sort((a,b)=>b.score-a.score).slice(0,3)};
}
export function smoothRiskGate(audio,rate,riskRanges,{fadeMs=35}={}){
  const fade=Math.max(1,Math.round(rate*fadeMs/1000));
  const gain=new Float32Array(audio[0].length).fill(1);
  for(const {start,end} of riskRanges){
    const lo=Math.max(0,Math.floor(start*rate)),hi=Math.min(gain.length,Math.ceil(end*rate));
    for(let i=lo;i<hi;i++)gain[i]=0;
    for(let i=Math.max(0,lo-fade);i<lo;i++)gain[i]=Math.min(gain[i],(lo-i)/fade);
    for(let i=hi;i<Math.min(gain.length,hi+fade);i++)gain[i]=Math.min(gain[i],(i-hi)/fade);
  }
  return audio.map(ch=>{const out=new Float32Array(ch);for(let i=0;i<out.length;i++)out[i]*=gain[i];return out;});
}
export async function verifyMusic({original,cleaned,rate,strict=false,onProgress=()=>{}}){
  const task=await initMusicClassifier();
  const n=Math.max(1,Math.ceil(original[0].length/rate)),blocks=[];
  function monoChunk(channels,index){
    const lo=Math.round(index*rate),duration=Math.max(1,Math.round(rate*.975)),out=new Float32Array(duration);
    for(let k=0;k<duration;k++){
      const j=lo+k;if(j>=channels[0].length)break;
      out[k]=channels.length>1?(channels[0][j]+channels[1][j])*.5:channels[0][j];
    }
    return out;
  }
  for(let i=0;i<n;i++){
    const before=interpretYamnet(task.classify(monoChunk(original,i),rate));
    const after=interpretYamnet(task.classify(monoChunk(cleaned,i),rate));
    blocks.push({start:i,end:Math.min((i+1),original[0].length/rate),before:before.music,after:after.music,speech:Math.max(before.speech,after.speech),
      state:after.music>=.34?'risk':before.music>=.34?'removed':'speech'});
    onProgress((i+1)/n);
  }
  const risky=blocks.filter(x=>x.state==='risk');
  return {verified:risky.length===0,method:'YAMNet probabilistic classifier',blocks,remainingRisk:risky.length,total:n,muted:risky.filter(x=>strict||x.speech<.34).length};
}
