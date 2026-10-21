import {renderFrame} from './render.js';
import {seekFrame} from './tracker.js';
import {sequentialVideoFrames,drawOrientedFrame} from './sequential-decoder.js';
import {inspectVideoFile,MediaError,supportedEncoderChoices,browserDiagnostics} from './media-probe.js';
import {activeAt} from '../state.js';
const MP4_MUXER_URL='https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.2/build/mp4-muxer.mjs';
const WEBM_MUXER_URL='https://cdn.jsdelivr.net/npm/webm-muxer@5.1.4/build/webm-muxer.mjs';
const FFMPEG_VERSION='0.12.15';
const FFMPEG_URL=`https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@${FFMPEG_VERSION}/dist/esm`;
// v1.12: the pinned ffmpeg worker is an ES module worker, where importScripts()
// is unavailable; it then dynamic-import()s the core, which only works with the
// ESM build. The UMD build failed with "failed to import ffmpeg-core.js",
// breaking every WebM/MediaRecorder export (silent WebM, or cleaned-audio error).
const CORE_URL='https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm';
const UTIL_URL='https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.2/dist/esm/index.js';
const delay=()=>new Promise(resolve=>setTimeout(resolve,0));
const abortIf=(signal)=>{if(signal?.aborted)throw new DOMException('Export cancelled','AbortError');};
export const EXPORT_PRESETS={
  whatsapp:{label:'WhatsApp',short:720,fps:30,videoBitrate:1800000,audioBitrate:96000,channels:2},
  small:{label:'Small',short:540,fps:30,videoBitrate:900000,audioBitrate:64000,channels:2},
  tiny:{label:'Tiny',short:360,fps:24,videoBitrate:450000,audioBitrate:48000,channels:1},
  hd:{label:'HD',short:1080,fps:30,videoBitrate:5000000,audioBitrate:128000,channels:2},
  original:{label:'Original',short:Infinity,fps:0,videoBitrate:6000000,audioBitrate:128000,channels:2},
  fit:{label:'Fit under',short:720,fps:30,videoBitrate:1200000,audioBitrate:96000,channels:2},
  // Legacy values are accepted for existing project settings.
  '720':{label:'WhatsApp',short:720,fps:30,videoBitrate:1800000,audioBitrate:96000,channels:2},
  '1080':{label:'HD',short:1080,fps:30,videoBitrate:5000000,audioBitrate:128000,channels:2}
};
export const outputDimensions=(w,h,preset='whatsapp')=>{
  const limit=EXPORT_PRESETS[preset]?.short??720;
  const shortSide=Math.max(1,Math.min(w,h));
  const factor=Number.isFinite(limit)?Math.min(1,limit/shortSide):1;
  return {width:Math.max(2,Math.round(w*factor/2)*2),height:Math.max(2,Math.round(h*factor/2)*2)};
};
export const estimateSize=(video,preset='whatsapp',{targetMB=16,codec='h264',fps='preset',audioBitrate=null,audioMode='original'}={})=>{
  const chosen=EXPORT_PRESETS[preset]||EXPORT_PRESETS.whatsapp;
  const {width,height}=outputDimensions(video.width,video.height,preset);
  const frameRate=fps==='original'?Math.min(120,Math.max(1,video.fps||30)):Number(fps)>0?Number(fps):(chosen.fps||Math.min(60,video.fps||30));
  const audioBps=audioMode==='none'?0:Number(audioBitrate)||chosen.audioBitrate;
  const duration=Math.max(0,video.duration||0);
  let bitRate=chosen.videoBitrate;
  if(preset==='original')bitRate=Math.min(14000000,Math.max(1200000,Math.round(width*height*frameRate*.09)));
  if(preset==='fit')bitRate=Math.max(250000,Math.floor((Math.max(.25,Number(targetMB)||16)*1024*1024*8/Math.max(1,duration)-audioBps)*.95));
  // Alternative codecs need less bitrate for similar quality, but are NOT WhatsApp defaults.
  if(codec==='hevc')bitRate=Math.round(bitRate*.65);
  if(codec==='vp9'||codec==='av1')bitRate=Math.round(bitRate*.60);
  return {bitRate,bytes:Math.round(duration*(bitRate+audioBps)/8*1.03),width,height,fps:frameRate,
    audioBitrate:audioBps,codec,canFit:preset!=='fit'||(duration*(bitRate+audioBps)/8)<=Math.max(.25,Number(targetMB)||16)*1024*1024};
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
// Exact, seek-driven frames for containers WebCodecs cannot demux (WebM, etc.).
// Each yielded VideoFrame is owned and closed by the consumer, like the
// sequential decoder's frames.
async function* seekedVideoFrames(file,{signal,fps=30,duration=0,onProgress=()=>{}}={}){
  const handle=await sourceVideo(file);const video=handle.video;
  try{
    const total=[duration,video.duration].find(d=>Number.isFinite(d)&&d>0)||0;
    if(!total)throw new MediaError('HF_DURATION','This video has no readable duration. Convert it to MP4 and try again.');
    // ceil(): the final partial frame interval is rendered too (no uncovered tail).
    const n=Math.max(1,Math.ceil(total*fps-1e-6));
    for(let i=0;i<n;i++){
      abortIf(signal);
      const t=Math.min(Math.max(0,total-.002),i/fps);
      await seekFrame(video,t,{signal});
      yield {frame:new VideoFrame(video,{timestamp:Math.round(t*1e6)}),time:t,meta:{width:video.videoWidth,height:video.videoHeight,rotation:0}};
    }
  }finally{handle.close();}
}
async function decodeAudioBuffer(file){
  const ctx=new (window.AudioContext||window.webkitAudioContext)();
  try{return await ctx.decodeAudioData(await file.arrayBuffer());}finally{await ctx.close();}
}
async function encodeAudio(muxer,audio,{signal,onProgress=()=>{},bitrate=128000,channelsWanted=2,codec='mp4a.40.2'}={}){
  if(typeof AudioEncoder==='undefined'||typeof AudioData==='undefined')return {ok:false,reason:'AudioEncoder unavailable'};
  const channels=Math.min(channelsWanted,audio.numberOfChannels),sampleRate=48000;
  const cfg={codec,sampleRate,numberOfChannels:channels,bitrate};
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
      for(let ch=0;ch<channels;ch++){
        if(channels===1&&buffer.numberOfChannels>1){const a=buffer.getChannelData(0),b=buffer.getChannelData(1);for(let k=0;k<count;k++)planar[k]=(a[start+k]+b[start+k])*.5;}
        else planar.set(buffer.getChannelData(ch).subarray(start,start+count),ch*count);
      }
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
export async function loadFFmpeg(){
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
// Sequential WebCodecs export: compressed samples are demuxed once and sent
// to VideoDecoder in decode order. Unlike v1.8 there is NO per-frame seeking.
export async function exportVideo({file,project,maskCache,ai,preset='whatsapp',audioMode='original',cleanedAudio=null,
    codec='h264',fps='preset',audioBitrate=null,channels='stereo',speed='balanced',targetMB=16,signal,
    onProgress=()=>{},onStatus=()=>{}}){
  if(!['original','none','clean'].includes(audioMode))throw new MediaError('HF_AUDIO_MODE','Unsupported audio mode');
  if(audioMode==='clean'&&!cleanedAudio)throw new MediaError('HF_AUDIO_NOT_READY','Process and check cleaned audio before exporting.');
  abortIf(signal);
  const options={file,project,maskCache,ai,preset,audioMode,cleanedAudio,codec,fps,audioBitrate,channels,speed,targetMB,signal,onProgress,onStatus};
  if(typeof VideoEncoder==='undefined'||typeof VideoDecoder==='undefined'||typeof VideoFrame==='undefined'){
    onStatus('WebCodecs unavailable; using realtime browser recording…');
    return fallbackVideo(options);
  }
  const container=(codec==='vp9'||codec==='av1')?'webm':'mp4';
  const libraryURL=container==='webm'?WEBM_MUXER_URL:MP4_MUXER_URL;
  let lib;
  try{lib=await import(libraryURL);}catch(e){
    if(container==='webm')throw new MediaError('HF_MUXER_LOAD','WebM encoder library could not be downloaded.',{cause:e.message});
    onStatus('MP4 library unavailable; using realtime recorder.');return fallbackVideo(options);
  }
  const choice=estimateSize(project.video,preset,{targetMB,codec,fps,audioBitrate,audioMode});
  let {width,height,bitRate}=choice;
  if(speed==='quality')bitRate=Math.round(bitRate*1.18);
  const codecStrings={h264:['avc1.64002a','avc1.4d002a','avc1.42001f'],hevc:['hvc1.1.6.L123.B0'],vp9:['vp09.00.31.08','vp09.00.10.08'],av1:['av01.0.08M.08']};
  if(!codecStrings[codec])throw new MediaError('HF_ENCODER_CHOICE','Choose a supported output codec.');
  let cfg=null;
  for(const id of codecStrings[codec]){
    const candidate={codec:id,width,height,bitrate:bitRate,framerate:choice.fps,latencyMode:speed==='fast'?'realtime':'quality',hardwareAcceleration:'prefer-hardware'};
    const check=await VideoEncoder.isConfigSupported(candidate).catch(()=>({supported:false}));
    if(check?.supported){cfg=candidate;break;}
  }
  if(!cfg)throw new MediaError('HF_ENCODER_UNSUPPORTED',`${codec.toUpperCase()} encoding is unsupported at this resolution. Choose H.264 or a lower quality preset.`);
  const probe=await inspectVideoFile(file,{signal,onProgress:p=>onProgress(.025*p,'Inspecting video codec…')});
  if(probe.supported===false)throw new MediaError('HF_SOURCE_CODEC',
    'This source codec cannot be decoded by Chrome. Use Convert for editing, then export again.',{codec:probe.codec,bitDepth:probe.bitDepth});
  // v1.12: WebM (and other non-MP4) sources no longer use the realtime
  // MediaRecorder path, whose masks lag behind a playing video and which
  // depended on ffmpeg for sound. Frames are produced by exact seeking instead
  // and go through the SAME WebCodecs encoder, mask cache and audio pipeline.
  const frameSource=probe.probeUnavailable?
    seekedVideoFrames(file,{signal,fps:Math.max(1,Math.min(60,project.video.fps||30)),duration:project.video.duration,onProgress:p=>onProgress(.04+.12*p,'Preparing frames…')}):
    null;
  if(probe.probeUnavailable)onStatus('Rendering frame-by-frame (non-MP4 source)…');
  let decodedAudio=null;
  if(audioMode==='clean')decodedAudio=cleanedAudio;
  if(audioMode==='original')decodedAudio=await decodeAudioBuffer(file).catch(()=>null);
  const requestedChannels=channels==='mono'?1:Math.min(2,decodedAudio?.numberOfChannels||2);
  const audioCodec=container==='webm'?'opus':'mp4a.40.2';
  const sampleRate=48000;
  const audioConfig={codec:audioCodec,sampleRate,numberOfChannels:requestedChannels,bitrate:choice.audioBitrate};
  const audioSupported=!!decodedAudio&&typeof AudioEncoder!=='undefined'&&
    !!(await AudioEncoder.isConfigSupported(audioConfig).catch(()=>({supported:false}))).supported;
  const dest=new lib.ArrayBufferTarget(),muxOpts={target:dest,firstTimestampBehavior:'offset'};
  if(container==='webm')muxOpts.video={codec:codec==='av1'?'V_AV1':'V_VP9',width,height};
  else{muxOpts.video={codec:codec==='hevc'?'hevc':'avc',width,height};muxOpts.fastStart='in-memory';}
  if(audioSupported)muxOpts.audio={codec:container==='webm'?'A_OPUS':'aac',numberOfChannels:requestedChannels,sampleRate};
  const muxer=new lib.Muxer(muxOpts);
  let videoEncoder=null,encoderError=null,lock=null,frameCount=0,firstFrameTime=null,previousFrameTime=-1;
  const outputCanvas=document.createElement('canvas');outputCanvas.width=width;outputCanvas.height=height;
  const outputCtx=outputCanvas.getContext('2d',{alpha:false});
  const stage=document.createElement('canvas'),stageCtx=stage.getContext('2d',{alpha:false});
  const started=performance.now(),targetInterval=1/choice.fps;
  let nextInputTime=0,lastTimestamp=-1;
  try{
    if(navigator.wakeLock?.request)try{lock=await navigator.wakeLock.request('screen');}catch{}
    videoEncoder=new VideoEncoder({output:(chunk,metadata)=>muxer.addVideoChunk(chunk,metadata),error:e=>{encoderError=e;}});
    videoEncoder.configure(cfg);
    for await(const {frame,time,meta} of (frameSource||sequentialVideoFrames(file,{signal,onProgress:p=>onProgress(.04+.12*p,'Reading compressed video sequentially…')}))){
      try{
        abortIf(signal);if(encoderError)throw encoderError;
        // Cap output frame rate by skipping source frames, preserving VFR PTS.
        if(fps!=='original'&&time+1/(choice.fps*4)<nextInputTime)continue;
        if(fps!=='original')nextInputTime=Math.floor((time+1e-5)/targetInterval+1)*targetInterval;
        drawOrientedFrame(stageCtx,frame,meta,project.video.width,project.video.height);
        await maskCache?.ensureActive({source:stage,project,time,ai,signal});
        // EXACT rendering function shared with the editor's live preview.
        renderFrame(outputCtx,stage,project,time,{maskCache});
        const timestampUs=Math.max(lastTimestamp+1,Math.round(time*1e6));
        const vf=new VideoFrame(outputCanvas,{timestamp:timestampUs,duration:Math.max(1,Math.round(1e6/choice.fps))});
        videoEncoder.encode(vf,{keyFrame:frameCount===0||time-(firstFrameTime||0)>=2&&frameCount%Math.max(1,Math.round(choice.fps*2))===0});
        vf.close();lastTimestamp=timestampUs;
        if(firstFrameTime===null)firstFrameTime=time;
        frameCount++;
        while(videoEncoder.encodeQueueSize>8){abortIf(signal);if(encoderError)throw encoderError;await delay();}
        if(frameCount%6===0){
          const ratio=Math.min(1,time/Math.max(.01,project.video.duration));
          const elapsed=(performance.now()-started)/1000,eta=ratio>.02?elapsed*(1-ratio)/ratio:null;
          onProgress(.16+.64*ratio,`Sequential rendering ${Math.round(ratio*100)}% · ${frameCount} frames${eta===null?'':` · ~${Math.round(eta)}s left`}`);
          await delay();
        }
      }finally{frame.close();}
    }
    if(frameCount===0)throw new MediaError('HF_NO_FRAMES','No video frames decoded. Convert to H.264 and try again.');
    onStatus('Finalizing encoded video…');await videoEncoder.flush();if(encoderError)throw encoderError;
    let audioEmbedded=false;
    if(audioSupported){
      const result=await encodeAudio(muxer,decodedAudio,{signal,bitrate:choice.audioBitrate,channelsWanted:requestedChannels,
        codec:audioCodec,onProgress:p=>onProgress(.82+.15*p,'Encoding audio…')});
      audioEmbedded=result.ok;
    }
    muxer.finalize();
    let blob=new Blob([dest.buffer],{type:container==='webm'?'video/webm':'video/mp4'});
    let warning=null;
    if(audioMode==='original'&&!audioEmbedded){
      if(container==='mp4'){
        onStatus('Copying original audio into the exported MP4…');
        try{blob=await muxOriginalAudio(blob,file,{signal,onStatus});audioEmbedded=true;}
        catch(e){warning='Original audio could not be included: '+e.message;}
      }else warning='WebM was exported without original audio because the browser cannot encode Opus.';
    }
    if(audioMode==='clean'&&!audioEmbedded){
      if(container==='mp4'){blob=await muxCleanAudio(blob,cleanedAudio,{signal,onStatus});audioEmbedded=true;}
      else throw new MediaError('HF_WEBM_CLEANED_AUDIO','This browser cannot encode cleaned Opus audio in WebM. Choose H.264 MP4 instead.');
    }
    if(codec==='hevc')warning=[warning,'HEVC may not play in WhatsApp and could be recompressed.'].filter(Boolean).join(' ');
    if(container==='webm')warning=[warning,'WebM is not recommended for WhatsApp; use H.264 MP4 for broad compatibility.'].filter(Boolean).join(' ');
    if(audioMode==='clean')warning=[warning,'AI separation may leave music. Review the output before sharing.'].filter(Boolean).join(' ');
    onProgress(1,'Export complete');
    return {blob,format:container,frames:frameCount,audio:audioMode!=='none'&&audioEmbedded,warning,
      stats:{elapsedSeconds:(performance.now()-started)/1000,frames:frameCount,codec:cfg.codec,fps:choice.fps,bytes:blob.size,sourceCodec:probe.codec}};
  }catch(e){
    if(e.name==='AbortError'||e instanceof MediaError)throw e;
    throw new MediaError('HF_SEQUENTIAL_EXPORT','Sequential export failed. Try H.264, a smaller preset or Convert for editing.',{cause:e.message});
  }finally{
    try{videoEncoder?.close();}catch{}
    try{await lock?.release();}catch{}
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
    }catch(e){const why=e?.message||String(e);if(audioMode==='clean')throw new Error('Cleaned-audio MP4 conversion failed: '+why+'. We will NOT substitute the original soundtrack. Try No audio.');onStatus('MP4 conversion failed: '+why+'. WebM video available without guaranteed original audio.');onProgress(1,'WebM fallback ready');return {blob:webm,format:'webm',audio:false,warning:'MP4/audio conversion unavailable. This WebM has no original sound; do not treat it as WhatsApp-compatible MP4.'};}
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
