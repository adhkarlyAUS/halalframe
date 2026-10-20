// Pinned MP4Box.js metadata probe. Media is read locally; nothing is uploaded.
// All large media reads are chunked; parsing is completed on the user's device.
export const MP4BOX_URL='https://cdn.jsdelivr.net/npm/mp4box@2.4.1/dist/mp4box.all.mjs';
let libraryPromise;
export const getMP4Box=()=>libraryPromise??=import(MP4BOX_URL);
const clamp=(x,min,max)=>Math.max(min,Math.min(max,x));
export class MediaError extends Error {
  constructor(code,message,details={}){super(message);this.name='MediaError';this.code=code;this.details=details;}
}
export const isMP4=file=>/\.(mp4|mov|m4v)$/i.test(file?.name||'')||/^(video\/mp4|video\/quicktime|video\/x-m4v)$/i.test(file?.type||'');
function rotationFromTrack(mp4,track){
  const t=mp4.getTrackById?.(track.id),m=t?.tkhd?.matrix;
  if(Number.isFinite(track?.video?.rotation))return ((track.video.rotation%360)+360)%360;
  if(Number.isFinite(track?.rotation))return ((track.rotation%360)+360)%360;
  if(!m)return 0;
  // ISO BMFF tkhd transformation: a,b,u,c,d,v,x,y,w; fixed-point 16.16.
  const a=Number(m[0]??m.a??0),b=Number(m[1]??m.b??0),c=Number(m[3]??m.c??0),d=Number(m[4]??m.d??0);
  if(Math.abs(a)<Math.max(2,Math.abs(b)*.15)&&Math.abs(d)<Math.max(2,Math.abs(c)*.15))return b<0||c>0?90:270;
  if(a<0&&d<0)return 180;
  return 0;
}
function codecDescription(mp4,track,MP4Box){
  const trak=mp4.getTrackById(track.id);
  for(const e of trak?.mdia?.minf?.stbl?.stsd?.entries||[]){
    const box=e.avcC||e.hvcC||e.vpcC||e.av1C;
    if(!box)continue;
    const stream=new MP4Box.DataStream(undefined,0,MP4Box.DataStream.BIG_ENDIAN);
    box.write(stream);
    return new Uint8Array(stream.buffer.slice(8,stream.position||undefined));
  }
  return undefined;
}
export function parseTrack(mp4,info,MP4Box){
  const video=info.videoTracks?.[0];
  if(!video)throw new MediaError('HF_NO_VIDEO','The selected file has no video track.');
  const duration=(video.samples_duration||video.duration||info.duration)/(video.timescale||info.timescale||1000);
  const fps=video.nb_samples&&duration?video.nb_samples/duration:30;
  const width=video.video?.width||video.track_width,height=video.video?.height||video.track_height;
  const rotation=rotationFromTrack(mp4,video);
  const c=String(video.codec||'');
  return {trackId:video.id,codec:c,width,height,timescale:video.timescale||1000,displayWidth:rotation%180?height:width,displayHeight:rotation%180?width:height,
    duration,fps,rotation,frames:video.nb_samples||0,bitDepth:/^(hvc1|hev1)/i.test(c)&&/\.2\./.test(c)?10:/^(av01|vp09)/i.test(c)&&/\.(10|12)(\.|$)/.test(c)?10:8,
    description:codecDescription(mp4,video,MP4Box),audioCodec:info.audioTracks?.[0]?.codec||null,
    container:'MP4/MOV',fileSize:0,variableFrameRate:'unknown'};
}
// Probe until the moov atom becomes available (may be near the end of a phone MOV).
export async function inspectVideoFile(file,{signal,onProgress=()=>{}}={}){
  if(!isMP4(file))return {container:(file.name.split('.').pop()||'unknown').toUpperCase(),codec:'unknown',supported:null,probeUnavailable:true,
    fileSize:file.size};
  let MP4Box;try{MP4Box=await getMP4Box();}catch(e){throw new MediaError('HF_DEMUX_LOAD','Cannot load the MP4 inspector. Check internet for the first launch.',{cause:e.message});}
  const mp4=MP4Box.createFile();let found=null,parseError=null;
  mp4.onReady=info=>{try{found=parseTrack(mp4,info,MP4Box);}catch(e){parseError=e;}};
  mp4.onError=e=>{parseError=new MediaError('HF_MP4_PARSE','The MP4/MOV structure could not be inspected.',{cause:String(e)});};
  const chunkSize=1024*1024;
  for(let offset=0;offset<file.size&&!found&&!parseError;offset+=chunkSize){
    if(signal?.aborted)throw new DOMException('Cancelled','AbortError');
    const ab=await file.slice(offset,offset+chunkSize).arrayBuffer();ab.fileStart=offset;mp4.appendBuffer(ab);
    onProgress(clamp((offset+ab.byteLength)/file.size,0,1));
  }
  if(!found&&!parseError)mp4.flush();
  if(parseError)throw parseError;
  if(!found)throw new MediaError('HF_MP4_NO_MOOV','The video track metadata was not found. The MOV may be incomplete.');
  found.fileSize=file.size;
  if(typeof VideoDecoder==='undefined'){found.supported=false;found.unsupportedReason='WebCodecs VideoDecoder is unavailable';return found;}
  const config={codec:found.codec,codedWidth:found.width,codedHeight:found.height};
  if(found.description?.byteLength)config.description=found.description;
  const support=await VideoDecoder.isConfigSupported(config).catch(e=>({supported:false,reason:e.message}));
  found.supported=Boolean(support?.supported);found.unsupportedReason=support?.reason||(!found.supported?'This browser cannot decode the source codec':'');
  return found;
}
export async function supportedEncoderChoices({width=1280,height=720,fps=30}={}){
  const candidates={h264:'avc1.4d002a',hevc:'hvc1.1.6.L123.B0',av1:'av01.0.08M.08',vp9:'vp09.00.31.08'};
  const result={};
  for(const [key,codec] of Object.entries(candidates)){
    if(typeof VideoEncoder==='undefined'){result[key]=false;continue;}
    result[key]=!!(await VideoEncoder.isConfigSupported({codec,width:Math.min(width,1280),height:Math.min(height,720),framerate:Math.min(fps,30),bitrate:1500000}).catch(()=>({supported:false}))).supported;
  }
  return result;
}
export const browserDiagnostics=(file,probe={},extra={})=>({
  appVersion:'1.11',name:file?.name||'',fileBytes:file?.size||0,container:probe?.container||'unknown',
  codec:probe?.codec||'unknown',audioCodec:probe?.audioCodec||'unknown',bitDepth:probe?.bitDepth||'unknown',
  resolution:`${probe?.displayWidth||probe?.width||'?'}x${probe?.displayHeight||probe?.height||'?'}`,
  frameRate:probe?.fps||'unknown',rotation:probe?.rotation??'unknown',duration:probe?.duration??'unknown',
  browser:typeof navigator==='undefined'?'unknown':navigator.userAgent,
  webCodecs:typeof VideoDecoder!=='undefined'&&typeof VideoEncoder!=='undefined',
  videoDecoderSupported:probe?.supported??'unknown',...extra
});
