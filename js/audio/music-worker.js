// Fully on-device Silero VAD + UVR MDX-Net vocal-isolation worker.
// No microphone, server endpoint, API token, or media upload is used.
// Workers have their own module realm: the document import map does not apply here.
const RELEASE=new URL(import.meta.url).searchParams.get('v')||'1.5';
const {MODELS,ORT_BASE,VAD_URL}=await import(`./models.js?v=${RELEASE}`);
const {resample,stftChunk,istftChunk,blendChunks,deriveGate,HOP,FRAMES}=await import(`./dsp.js?v=${RELEASE}`);
const AUDIO_CACHE='halalframe-audio-models-v1.5';
let ort=null, vadSession=null, stemSession=null,stemKey=null,stemDelegate=null;
const pct=(stage,ratio,message,job)=>postMessage({type:'progress',job,stage,ratio,detail:message});
const secs=()=>performance.now()/1000;
async function loadRuntime(){
  if(ort)return ort;
  try{ort=await import(`${ORT_BASE}ort.webgpu.min.mjs`);}catch(e){
    // Same version, classic wasm-only implementation when WebGPU module import is blocked.
    ort=await import(`${ORT_BASE}ort.wasm.min.mjs`);
  }
  ort.env.wasm.wasmPaths=ORT_BASE;ort.env.wasm.numThreads=1;
  return ort;
}
async function fetchPinned(url,bytesExpected,job,label,sha){
  const cache=await caches.open(AUDIO_CACHE);
  let cached=await cache.match(url);
  if(cached){pct('models',1,`${label}: cached`,job);return new Uint8Array(await cached.arrayBuffer());}
  const response=await fetch(url,{cache:'no-store'});
  if(!response.ok)throw new Error(`${label} download failed: HTTP ${response.status}. Check the internet for first use.`);
  if(response.type==='opaque')throw new Error(`${label} host does not allow browser downloads (CORS).`);
  const reader=response.body?.getReader();let data;
  if(reader){const pieces=[];let count=0;
    while(true){const {value,done}=await reader.read();if(done)break;pieces.push(value);count+=value.byteLength;
      pct('models',Math.min(.99,count/Math.max(1,bytesExpected||2300000)),`Downloading ${label}: ${(count/1048576).toFixed(1)} / ${(bytesExpected/1048576).toFixed(1)} MB`,job);
    }
    data=new Uint8Array(count);let at=0;for(const piece of pieces){data.set(piece,at);at+=piece.length;}
  }else{data=new Uint8Array(await response.arrayBuffer());}
  if(bytesExpected&&Math.abs(data.length-bytesExpected)>2000)throw new Error(`${label} downloaded an unexpected file size; refusing to run it.`);
  if(sha){const hex=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data))).map(b=>b.toString(16).padStart(2,'0')).join('');
    if(hex!==sha)throw new Error(`${label} failed the SHA-256 verification. Do not use this model.`);
  }
  await cache.put(url,new Response(data,{headers:{'content-type':'application/octet-stream'}})).catch(()=>{});
  pct('models',1,`${label}: downloaded and cached`,job);
  return data;
}
async function sessionFrom(url,size,job,name,sha,{preferGPU=true}={}){
  await loadRuntime();const bytes=await fetchPinned(url,size,job,name,sha);
  let gpuError='';
  if(preferGPU&&navigator.gpu){try{return {session:await ort.InferenceSession.create(bytes,{executionProviders:['webgpu'],graphOptimizationLevel:'all'}),delegate:'WebGPU'};}
    catch(e){gpuError=e.message;}}
  try{return {session:await ort.InferenceSession.create(bytes,{executionProviders:['wasm'],graphOptimizationLevel:'all'}),delegate:'WASM'};}
  catch(e){throw new Error(`${name} cannot run on this phone: ${e.message}${gpuError?' · WebGPU: '+gpuError:''}`);}
}
async function voiceActivity(audio,rate,job){
  const mono=new Float32Array(audio[0].length);
  for(let i=0;i<mono.length;i++)mono[i]=audio.length===1?audio[0][i]:(audio[0][i]+audio[1][i])*.5;
  const data=resample(mono,rate,16000),hop=512;
  if(!vadSession){const r=await sessionFrom(VAD_URL,0,job,'Silero voice detector','1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3',{preferGPU:false});vadSession=r.session;}
  const session=vadSession,state=new Float32Array(2*1*128),scores=[],context=new Float32Array(64);
  for(let begin=0;begin<data.length;begin+=hop){
    const sample=new Float32Array(hop);sample.set(data.subarray(begin,begin+hop));
    // Silero v5 expects 64 previous samples + the new 512-sample frame.
    const withContext=new Float32Array(hop+64);withContext.set(context);withContext.set(sample,64);context.set(sample.subarray(hop-64));
    const input=new ort.Tensor('float32',withContext,[1,hop+64]);
    const s=new ort.Tensor('float32',state,[2,1,128]);
    const sr=new ort.Tensor('int64',new BigInt64Array([16000n]),[]);
    const names=session.inputNames;
    const feeds={};for(const name of names){if(name==='input'||name==='x')feeds[name]=input;else if(name==='state')feeds[name]=s;else if(name==='sr')feeds[name]=sr;}
    const output=await session.run(feeds),prob=output.output||output.prob||output[session.outputNames[0]];
    scores.push(Math.max(0,Math.min(1,Number(prob?.data?.[0]||0))));
    const next=output.stateN||output.state||output[session.outputNames[1]];
    if(next?.data?.length===state.length)state.set(next.data);
    if(scores.length%24===0)pct('vad',Math.min(1,(begin+hop)/data.length),`Listening for speech · ${(begin/16000).toFixed(1)} s`,job);
  }
  return scores;
}
async function isolateStem(audio,rate,quality,job){
  const cfg=MODELS[quality];if(!cfg)throw new Error('Unsupported separation quality');
  if(!stemSession||stemKey!==quality){if(stemSession)await stemSession.release().catch(()=>{});
    const r=await sessionFrom(cfg.url,cfg.size,job,cfg.name,cfg.sha256);stemSession=r.session;stemKey=quality;stemDelegate=r.delegate;
    postMessage({type:'delegate',job,delegate:r.delegate});
  }
  const input=audio.map(ch=>resample(ch,rate,44100));
  if(input.length===1)input.push(input[0]);
  const length=input[0].length,block=HOP*FRAMES,stride=HOP*128;
  const chunks=[];const total=Math.max(1,Math.ceil(Math.max(1,length-block)/stride)+1);
  let start=0;
  for(let step=0;step<total;step++,start+=stride){
    const spectrum=stftChunk(input,start,cfg);
    const tensor=new ort.Tensor('float32',spectrum,[1,4,cfg.dimF,cfg.dimT]);
    let prediction;
    try{prediction=await stemSession.run({[stemSession.inputNames[0]]:tensor});}
    catch(error){
      if(stemDelegate!=='WebGPU')throw error;
      pct('separate',step/total,'WebGPU inference unsupported for this model — falling back to CPU',job);
      await stemSession.release().catch(()=>{});stemSession=null;
      const cpu=await sessionFrom(cfg.url,cfg.size,job,cfg.name,cfg.sha256,{preferGPU:false});
      stemSession=cpu.session;stemDelegate='WASM';postMessage({type:'delegate',job,delegate:'WASM (GPU inference fallback)'});
      prediction=await stemSession.run({[stemSession.inputNames[0]]:tensor});
    }
    const output=prediction[stemSession.outputNames[0]];
    if(!output?.data?.length)throw new Error('Vocal model did not return any audio spectrum');
    const waveform=istftChunk(output.data,start,cfg,block);
    chunks.push({start,data:waveform});
    pct('separate',(step+1)/total,`Separating voice · ${step+1}/${total} chunks`,job);
  }
  const vocals=blendChunks(chunks,length);
  // On models that output vocals directly, do not subtract from the input.
  // Keep all samples in their native 44.1 kHz domain until final resampling.
  return vocals.map(ch=>resample(ch,44100,rate));
}
export function applyGateAndStrict({original,vocals,gate,rate,strength,strict}){
  const result=original.map((ch,c)=>new Float32Array(ch.length));
  const mix=strength==='gentle'?.12:strength==='maximum'?0:0; // Gentle blends a small original portion; Strong/Maximum use vocals only.
  const block=Math.max(1,Math.round(rate*.25));
  for(let pos=0;pos<gate.length;pos+=block){
    const end=Math.min(pos+block,gate.length);let musicRatio=0;
    if(strict){let orig=0,residual=0;
      for(let i=pos;i<end;i++){
        const o=(original[0][i]+(original[1]?.[i]??original[0][i]))*.5;
        const v=(vocals[0][i]+(vocals[1]?.[i]??vocals[0][i]))*.5;
        orig+=o*o;residual+=(o-v)*(o-v);
      }
      musicRatio=residual/Math.max(orig,1e-6);
    }
    // This is a conservative residual-energy heuristic, NOT a music classifier.
    const silence=!!(strict&&musicRatio>(strength==='maximum'?.09:.18));
    for(let i=pos;i<end;i++)for(let c=0;c<original.length;c++){
      const base=vocals[Math.min(c,vocals.length-1)][i];
      result[c][i]=silence?0:gate[i]*(base*(1-mix)+original[c][i]*mix);
    }
  }
  return result;
}
async function processAudio(message){
  const {job,sampleRate,quality,strength,strict}=message;
  const input=message.channels.map(x=>new Float32Array(x));
  if(!input.length||!input[0].length)throw new Error('No audio samples were decoded');
  if(input.length>2)throw new Error('At most stereo audio supported');
  const max=(quality==='best'&&navigator.deviceMemory&&navigator.deviceMemory<=4)?45:120;if(input[0].length/sampleRate>max)throw new Error(`For phone stability, music cleaning is limited to ${max} seconds per edit. No audio and original audio are unrestricted.`);
  const started=secs();pct('start',0,'Checking for speech locally…',job);
  const scores=await voiceActivity(input,sampleRate,job);
  const gate=deriveGate(scores,sampleRate,input[0].length,{strength});
  const speechEnergy=gate.reduce((n,v)=>n+(v>.5?1:0),0)/Math.max(1,gate.length);
  let result;
  if(speechEnergy<.005){
    // Music/silence only: do not download a heavy separator needlessly.
    result=input.map(x=>new Float32Array(x.length));
    pct('separate',1,'No speech detected — muted all audio',job);
  }else{
    const vocals=await isolateStem(input,sampleRate,quality,job);
    result=applyGateAndStrict({original:input,vocals,gate,rate:sampleRate,strength,strict});
  }
  const transfer=result.map(x=>x.buffer);
  postMessage({type:'complete',job,channels:transfer,sampleRate,speechPercent:Math.round(100*speechEnergy),elapsed:secs()-started},transfer);
}
self.onmessage=async({data})=>{
  if(data?.type!=='process')return;
  try{await processAudio(data);}catch(e){postMessage({type:'error',job:data.job,message:e?.message||String(e)});}
};
