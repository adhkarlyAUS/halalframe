import {renderFrame} from './render.js';
import {seekFrame} from './tracker.js';
import {activeAt} from '../state.js';
const MP4_MUXER_URL='https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.2/build/mp4-muxer.mjs';
const FFMPEG_VERSION='0.12.15';
const FFMPEG_URL=`https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@${FFMPEG_VERSION}/dist/esm`;
const CORE_URL='https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd';
const UTIL_URL='https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.2/dist/esm/index.js';
const delay=()=>new Promise(resolve=>setTimeout(resolve,0));
const abortIf=(signal)=>{if(signal?.aborted)throw new DOMException('Export cancelled','AbortError');};
export const outputDimensions=(w,h,preset='720')=>{
  const limit=preset==='original'?Infinity:preset==='1080'?1080:720;
  const factor=Math.min(1,limit/Math.max(1,h));
  let width=Math.max(2,Math.round(w*factor/2)*2),height=Math.max(2,Math.round(h*factor/2)*2);
  return {width,height};
};
export const estimateSize=({width,height,duration,fps},preset='720')=>{
  const {width:w,height:h}=outputDimensions(width,height,preset);
  const bitRate=Math.min(8_000_000,Math.max(650_000,Math.round(w*h*Math.min(60,fps||30)*0.085)));
  return {bitRate,bytes:Math.round(duration*(bitRate+128000)/8),width:w,height:h};
};
function blobFromCanvas(canvas,type,quality){return new Promise((res,rej)=>canvas.toBlob(x=>x?res(x):rej(new Error('Failed to encode image')),type,quality));}
export async function exportPhoto(source,project,{type='image/jpeg',quality=.88,maskCache=null,ai=null}={}){
  const c=document.createElement('canvas');c.width=project.video.width;c.height=project.video.height;
  if(maskCache&&ai)await maskCache.ensureActive({source,project,time:0,ai});
  renderFrame(c.getContext('2d'),source,project,0,{maskCache});
  return blobFromCanvas(c,type,quality);
}
export function downloadBlob(blob,name){const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60_000);}
export async function shareBlob(blob,name){
  const file=new File([blob],name,{type:blob.type});
  if(navigator.share&&navigator.canShare?.({files:[file]})){await navigator.share({files:[file],title:'Edited with HalalFrame'});return true;}
  return false;
}
async function sourceVideo(file){
  const video=document.createElement('video');video.muted=true;video.preload='auto';video.playsInline=true;
  const url=URL.createObjectURL(file);video.src=url;
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Timed out decoding source video')),15000);
    const loaded=()=>{clearTimeout(timer);resolve();},bad=()=>{clearTimeout(timer);reject(new Error('Cannot decode selected video'));};
    video.addEventListener('loadeddata',loaded,{once:true});video.addEventListener('error',bad,{once:true});video.load();
  });
  return {video,close:()=>{video.pause();video.src='';URL.revokeObjectURL(url);}};
}
async function decodeAudioBuffer(file){
  const ctx=new (window.AudioContext||window.webkitAudioContext)();
  try{return await ctx.decodeAudioData(await file.arrayBuffer());}finally{await ctx.close();}
}
async function encodeAudio(muxer,audio,{signal,onProgress=()=>{}}={}){
  if(typeof AudioEncoder==='undefined'||typeof AudioData==='undefined')return {ok:false,reason:'AudioEncoder unavailable'};
  const channels=Math.min(2,audio.numberOfChannels),sampleRate=48000,bitrate=128000;
  const cfg={codec:'mp4a.40.2',sampleRate,numberOfChannels:channels,bitrate};
  const supported=await AudioEncoder.isConfigSupported(cfg).catch(()=>({supported:false}));
  if(!supported?.supported)return {ok:false,reason:'AAC AudioEncoder unsupported'};
  // Resample to 48 kHz without capturing a microphone or uploading media.
  const frames=Math.ceil(audio.duration*sampleRate);
  let buffer=audio;
  if(audio.sampleRate!==sampleRate){
    const offline=new OfflineAudioContext(channels,frames,sampleRate);
    const node=offline.createBufferSource();node.buffer=audio;node.connect(offline.destination);node.start();buffer=await offline.startRendering();
  }
  let encodeError=null;
  const encoder=new AudioEncoder({output:(chunk,meta)=>muxer.addAudioChunk(chunk,meta),error:e=>{encodeError=e;}});
  encoder.configure(cfg);
  const total=buffer.length,hop=1024;
  try{
    for(let start=0;start<total;start+=hop){
      abortIf(signal);if(encodeError)throw encodeError;
      const count=Math.min(hop,total-start),planar=new Float32Array(count*channels);
      for(let ch=0;ch<channels;ch++)planar.set(buffer.getChannelData(ch).subarray(start,start+count),ch*count);
      const audioFrame=new AudioData({format:'f32-planar',sampleRate,numberOfFrames:count,numberOfChannels:channels,timestamp:Math.round(start*1e6/sampleRate),data:planar});
      encoder.encode(audioFrame);audioFrame.close();
      while(encoder.encodeQueueSize>12){abortIf(signal);await delay();}
      if(start%(hop*60)===0)onProgress(start/total);
    }
    await encoder.flush();if(encodeError)throw encodeError;
    return {ok:true};
  }finally{encoder.close();}
}
// Silence-free muxing: when AAC is unavailable, first create a video-only MP4, then
// use the original compressed audio from the source through single-thread ffmpeg.wasm.
async function toBlobURL(url,type){const res=await fetch(url);if(!res.ok)throw new Error(`Library download failed (${res.status})`);return URL.createObjectURL(new Blob([await res.blob()],{type}));}
async function loadFFmpeg(){
  const [{FFmpeg},{fetchFile}]=await Promise.all([import(`${FFMPEG_URL}/index.js`),import(UTIL_URL)]);
  const ffmpeg=new FFmpeg();
  const coreURL=await toBlobURL(`${CORE_URL}/ffmpeg-core.js`,'text/javascript');
  const wasmURL=await toBlobURL(`${CORE_URL}/ffmpeg-core.wasm`,'application/wasm');
  const workerURL=new URL('./ffmpeg-worker.js',import.meta.url).href;
  try{await ffmpeg.load({coreURL,wasmURL,classWorkerURL:workerURL});}
  finally{URL.revokeObjectURL(coreURL);URL.revokeObjectURL(wasmURL);}
  return {ffmpeg,fetchFile};
}
// Lossless PCM bridge for browser configurations without AAC AudioEncoder.
// The source file is deliberately NOT used when Cleaned Audio is selected.
export function audioBufferToWAV(buffer){
  const channels=Math.min(2,buffer.numberOfChannels),rate=buffer.sampleRate,length=buffer.length;
  const out=new ArrayBuffer(44+length*channels*2),view=new DataView(out);
  const put=(offset,str)=>{for(let i=0;i<str.length;i++)view.setUint8(offset+i,str.charCodeAt(i));};
  put(0,'RIFF');view.setUint32(4,36+length*channels*2,true);put(8,'WAVE');put(12,'fmt ');
  view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,channels,true);
  view.setUint32(24,rate,true);view.setUint32(28,rate*channels*2,true);view.setUint16(32,channels*2,true);
  view.setUint16(34,16,true);put(36,'data');view.setUint32(40,length*channels*2,true);
  let at=44;const data=Array.from({length:channels},(_,c)=>buffer.getChannelData(c));
  for(let i=0;i<length;i++)for(let c=0;c<channels;c++){
    const n=Math.max(-1,Math.min(1,data[c][i]));view.setInt16(at,n<0?Math.round(n*32768):Math.round(n*32767),true);at+=2;
  }
  return new Blob([out],{type:'audio/wav'});
}
export async function muxCleanAudio(videoBlob,cleanedAudio,{signal,onStatus=()=>{}}={}){
  if(!cleanedAudio)throw new Error('No cleaned audio buffer supplied');
  abortIf(signal);onStatus('Encoding locally cleaned voice with FFmpeg…');
  const {ffmpeg,fetchFile}=await loadFFmpeg(),abort=()=>ffmpeg.terminate();
  signal?.addEventListener('abort',abort,{once:true});
  try{
    await ffmpeg.writeFile('video.mp4',await fetchFile(videoBlob));
    await ffmpeg.writeFile('cleaned.wav',await fetchFile(audioBufferToWAV(cleanedAudio)));
    const code=await ffmpeg.exec(['-y','-i','video.mp4','-i','cleaned.wav','-map','0:v:0','-map','1:a:0','-c:v','copy','-c:a','aac','-b:a','128k','-movflags','+faststart','-shortest','clean.mp4']);
    if(code!==0)throw new Error('AAC cleaned-audio muxing failed');
    return new Blob([await ffmpeg.readFile('clean.mp4')],{type:'video/mp4'});
  }finally{signal?.removeEventListener('abort',abort);ffmpeg.terminate();}
}
export async function muxOriginalAudio(videoBlob,original,{signal,onStatus=()=>{}}={}){
  abortIf(signal);onStatus('Loading offline audio muxer (first use downloads ~32 MB)…');
  const {ffmpeg,fetchFile}=await loadFFmpeg();
  const onAbort=()=>ffmpeg.terminate();signal?.addEventListener('abort',onAbort,{once:true});
  try{
    await ffmpeg.writeFile('video.mp4',await fetchFile(videoBlob));
    await ffmpeg.writeFile('source',await fetchFile(original));
    const attempts=[
      ['-i','video.mp4','-i','source','-map','0:v:0','-map','1:a:0','-c:v','copy','-c:a','copy','-movflags','+faststart','joined.mp4'],
      ['-i','video.mp4','-i','source','-map','0:v:0','-map','1:a:0','-c:v','copy','-c:a','aac','-b:a','128k','-movflags','+faststart','joined.mp4']
    ];
    let resultCode=-1;
    for(const argv of attempts){abortIf(signal);resultCode=await ffmpeg.exec(['-y',...argv]);if(resultCode===0)break;}
    if(resultCode!==0)throw new Error('Original audio could not be muxed');
    const result=await ffmpeg.readFile('joined.mp4');
    return new Blob([result],{type:'video/mp4'});
  }finally{signal?.removeEventListener('abort',onAbort);ffmpeg.terminate();}
}
export async function exportVideo({file,project,maskCache,ai,preset='720',audioMode='original',cleanedAudio=null,signal,onProgress=()=>{},onStatus=()=>{}}){
  if(!['original','none','clean'].includes(audioMode))throw new Error('Unrecognised audio mode');
  if(audioMode==='clean'&&!cleanedAudio)throw new Error('Process cleaned audio before exporting.');
  abortIf(signal);
  if(typeof VideoEncoder==='undefined'||typeof VideoFrame==='undefined'){
    return await fallbackVideo({file,project,maskCache,ai,preset,audioMode,cleanedAudio,signal,onProgress,onStatus});
  }
  let muxerLibrary;
  try{muxerLibrary=await import(MP4_MUXER_URL);}catch(e){onStatus('MP4 library unavailable; trying browser recorder.');return fallbackVideo({file,project,maskCache,ai,preset,audioMode,cleanedAudio,signal,onProgress,onStatus});}
  const {width,height,bitRate}=estimateSize(project.video,preset),fps=preset==='original'?Math.min(60,project.video.fps||30):Math.min(30,project.video.fps||30);
  const candidates=['avc1.4d002a','avc1.42001f'];
  let cfg=null;
  for(const codec of candidates){const test={codec,width,height,bitrate:bitRate,framerate:fps,hardwareAcceleration:'prefer-hardware'};
    if((await VideoEncoder.isConfigSupported(test).catch(()=>({supported:false}))).supported){cfg=test;break;}}
  if(!cfg){onStatus('H.264 WebCodecs unsupported; using recorder fallback.');return fallbackVideo({file,project,maskCache,ai,preset,audioMode,cleanedAudio,signal,onProgress,onStatus});}
  const inputAudio=audioMode==='none'?null:audioMode==='clean'?cleanedAudio:await decodeAudioBuffer(file).catch(()=>null);
  const audioConfig={codec:'mp4a.40.2',sampleRate:48000,numberOfChannels:Math.min(2,inputAudio?.numberOfChannels||2),bitrate:128000};
  const audioSupported=typeof AudioEncoder!=='undefined'&&(await AudioEncoder.isConfigSupported(audioConfig).catch(()=>({supported:false}))).supported;
  const audioPossible=!!inputAudio&&audioSupported;
  const target=new muxerLibrary.ArrayBufferTarget();
  const opts={target,video:{codec:'avc',width,height,frameRate:fps},fastStart:'in-memory',firstTimestampBehavior:'offset'};
  if(audioPossible)opts.audio={codec:'aac',numberOfChannels:Math.min(2,inputAudio.numberOfChannels),sampleRate:48000};
  const muxer=new muxerLibrary.Muxer(opts);
  let encodeError=null,lock=null,handle=null,encoder=null;
  const timeStart=performance.now();
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
  const ctx=canvas.getContext('2d',{alpha:false});
  try{
    if(navigator.wakeLock?.request){try{lock=await navigator.wakeLock.request('screen');}catch{}}
    handle=await sourceVideo(file);
    encoder=new VideoEncoder({output:(chunk,metadata)=>muxer.addVideoChunk(chunk,metadata),error:e=>{encodeError=e;}});
    encoder.configure(cfg);
    const total=Math.max(1,Math.ceil(project.video.duration*fps));
    for(let i=0;i<total;i++){
      abortIf(signal);if(encodeError)throw encodeError;
      const time=i/fps;
      await seekFrame(handle.video,time,{signal});
      await maskCache?.ensureActive({source:handle.video,project,time,ai,signal});
      // Single source of truth for the preview and encoded frame.
      renderFrame(ctx,handle.video,project,time,{maskCache});
      const frame=new VideoFrame(canvas,{timestamp:Math.round(i*1_000_000/fps),duration:Math.round(1_000_000/fps)});
      encoder.encode(frame,{keyFrame:i===0||i%Math.max(1,Math.round(fps*2))===0});frame.close();
      while(encoder.encodeQueueSize>8){abortIf(signal);await delay();}
      if(i%Math.max(1,Math.round(fps/3))===0||i===total-1){
        const elapsed=(performance.now()-timeStart)/1000,eta=elapsed/Math.max(1,i+1)*(total-i-1);
        onProgress(.8*(i+1)/total,`Rendering ${i+1}/${total} frames · ~${Math.ceil(eta)}s remaining`);
        await delay();
      }
    }
    await encoder.flush();if(encodeError)throw encodeError;
    let soundOK=false,reason='';
    if(audioPossible){
      onStatus('Encoding original audio locally…');
      // encodeAudio decodes source and resamples to 48k while preserving original channels.
      const result=await encodeAudio(muxer,inputAudio,{signal,onProgress:p=>onProgress(.8+.17*p,'Encoding original audio…')});
      soundOK=result.ok;reason=result.reason||'';
      if(!soundOK)throw new Error('AAC encoding failed after muxer initialization: '+reason);
    }
    muxer.finalize();
    let blob=new Blob([target.buffer],{type:'video/mp4'});
    if(audioMode==='original'&&!soundOK){
      onStatus('Trying original-audio stream mux…');
      try{blob=await muxOriginalAudio(blob,file,{signal,onStatus});soundOK=true;}
      catch(e){reason='Original audio could not be verified or muxed: '+e.message;}
    }else if(audioMode==='clean'&&!soundOK){
      // Never substitute original music for a requested cleaned soundtrack.
      blob=await muxCleanAudio(blob,cleanedAudio,{signal,onStatus});soundOK=true;
    }

    onProgress(1,'Export complete');
    return {blob,format:'mp4',audio:audioMode==='none'?false:(inputAudio?soundOK:false),warning:audioMode==='none'?null:!soundOK?reason||'No verified audio track in source or export':audioMode==='clean'?'AI voice separation may leave music; listen to the exported result.':null};
  }finally{
    try{encoder?.close();}catch{}
    handle?.close();try{await lock?.release();}catch{}
  }
}
// Browser fallback: records canvas frames in realtime. Prefer MP4 remux through ffmpeg.wasm;
// if it fails, a WebM is offered only with a clearly identified format/sound warning.
async function fallbackVideo({file,project,maskCache,ai,preset,audioMode='original',cleanedAudio=null,signal,onProgress,onStatus}){
  if(typeof MediaRecorder==='undefined'||!HTMLCanvasElement.prototype.captureStream)throw new Error('Neither WebCodecs nor MediaRecorder is supported by this browser');
  const {width,height}=outputDimensions(project.video.width,project.video.height,preset),fps=Math.min(30,project.video.fps||30);
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
  const ctx=canvas.getContext('2d',{alpha:false});const handle=await sourceVideo(file);
  const stream=canvas.captureStream(fps);let mediaAudio=null;
  const chunks=[];const mime=['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm'].find(x=>MediaRecorder.isTypeSupported(x));
  if(!mime)throw new Error('MediaRecorder does not support WebM');
  const recorder=new MediaRecorder(stream,{mimeType:mime});
  recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
  const complete=new Promise((resolve,reject)=>{recorder.onstop=resolve;recorder.onerror=e=>reject(e.error||new Error('Recording failed'));});
  const video=handle.video,started=performance.now();
  try{
    video.currentTime=0;await seekFrame(video,0,{signal});
    // Audio capture is browser-dependent; ffmpeg muxes the original file after recording.
    recorder.start(1000);await video.play();
    while(!video.ended){abortIf(signal);const t=video.currentTime;
      await maskCache?.ensureActive({source:video,project,time:t,ai,signal});
      renderFrame(ctx,video,project,t,{maskCache});
      const fraction=Math.min(1,t/project.video.duration);
      onProgress(.7*fraction,`Realtime encoding ${Math.round(fraction*100)}%`);
      await new Promise(resolve=>setTimeout(resolve,Math.max(12,1000/fps)));
    }
    recorder.stop();await complete;video.pause();
    const webm=new Blob(chunks,{type:'video/webm'});
    onStatus('Converting WebM to MP4 and restoring original audio…');
    try{
      const mp4=await convertRecordedWebM(webm,file,{signal,onStatus,audioMode,cleanedAudio});
      onProgress(1,'Export complete');return {blob:mp4,format:'mp4',audio:audioMode!=='none'};
    }catch(e){if(audioMode==='clean')throw new Error('Cleaned-audio MP4 conversion failed: '+e.message+'. We will NOT substitute the original soundtrack. Try No audio.');onStatus('MP4 conversion failed: '+e.message+'. WebM video available without guaranteed original audio.');onProgress(1,'WebM fallback ready');return {blob:webm,format:'webm',audio:false,warning:'MP4/audio conversion unavailable. This WebM has no original sound; do not treat it as WhatsApp-compatible MP4.'};}
  }finally{
    if(recorder.state!=='inactive')recorder.stop();
    for(const track of stream.getTracks())track.stop();handle.close();
  }
}
async function convertRecordedWebM(webm,file,{signal,onStatus,audioMode,cleanedAudio}){
  const {ffmpeg,fetchFile}=await loadFFmpeg();const onAbort=()=>ffmpeg.terminate();signal?.addEventListener('abort',onAbort,{once:true});
  try{
    await ffmpeg.writeFile('mask.webm',await fetchFile(webm));
    if(audioMode==='original')await ffmpeg.writeFile('src',await fetchFile(file));
    else if(audioMode==='clean')await ffmpeg.writeFile('clean.wav',await fetchFile(audioBufferToWAV(cleanedAudio)));
    const inputName=audioMode==='clean'?'clean.wav':'src';
    const command=audioMode==='none'?
      ['-y','-i','mask.webm','-map','0:v:0','-an','-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart','result.mp4']:
      ['-y','-i','mask.webm','-i',inputName,'-map','0:v:0','-map','1:a:0','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-b:a','128k','-movflags','+faststart','-shortest','result.mp4'];
    const rc=await ffmpeg.exec(command);
    if(rc!==0)throw new Error('Offline conversion codec unavailable');
    return new Blob([await ffmpeg.readFile('result.mp4')],{type:'video/mp4'});
  }finally{signal?.removeEventListener('abort',onAbort);ffmpeg.terminate();}
}
