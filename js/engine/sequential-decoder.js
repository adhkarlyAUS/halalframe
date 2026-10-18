// HalalFrame v1.9 — decode compressed MP4/MOV samples in DTS order.
// No HTMLVideoElement seeking. B-frames are reordered by VideoDecoder; the
// emitted VideoFrames carry their original composition timestamps for VFR.
import {getMP4Box,parseTrack,MediaError,isMP4} from './media-probe.js';
const nextTick=()=>new Promise(r=>setTimeout(r,1));
const cancelled=signal=>{if(signal?.aborted)throw new DOMException('Cancelled','AbortError');};
export async function* sequentialVideoFrames(file,{signal,onProgress=()=>{},maxQueue=12}={}){
  if(!isMP4(file))throw new MediaError('HF_UNSUPPORTED_CONTAINER','This format cannot be demuxed by MP4Box. Convert to MP4 first.');
  if(typeof VideoDecoder==='undefined')throw new MediaError('HF_NO_WEBCODECS','WebCodecs VideoDecoder is not available. Try the real-time export fallback.');
  let MP4Box;try{MP4Box=await getMP4Box();}catch(e){throw new MediaError('HF_DEMUX_LOAD','Cannot load MP4Box library.',{cause:e.message});}
  const mp4=MP4Box.createFile();let track=null,decoder=null,failed=null,producerDone=false,decodeDone=false,disposed=false;
  const samples=[],frames=[];let frameCount=0,firstTimestamp=null,deliveredCount=0;
  const fail=e=>{failed=e instanceof Error?e:new Error(String(e));};
  mp4.onReady=info=>{
    try{
      track=parseTrack(mp4,info,MP4Box);
      const config={codec:track.codec,codedWidth:track.width,codedHeight:track.height,hardwareAcceleration:'prefer-hardware'};
      if(track.description?.byteLength)config.description=track.description;
      decoder=new VideoDecoder({
        output:frame=>{if(disposed){frame.close();return;}frames.push(frame);},
        error:e=>fail(new MediaError('HF_VIDEO_DECODER','The hardware/software decoder failed.',{cause:e?.message||String(e)}))
      });
      decoder.configure(config);
      mp4.setExtractionOptions(track.trackId,null,{nbSamples:8});mp4.start();
    }catch(e){fail(e);}
  };
  mp4.onError=e=>fail(new MediaError('HF_MP4_PARSE','Could not demux the input MP4.',{cause:String(e)}));
  mp4.onSamples=(id,user,batch)=>{
    if(!track||id!==track.trackId)return;
    for(const sample of batch)samples.push(sample);
  };
  const produce=async()=>{
    try{
      const chunkBytes=1024*1024;
      for(let offset=0;offset<file.size&&!disposed;offset+=chunkBytes){
        cancelled(signal);if(failed)throw failed;
        // Backpressure: avoid buffering an entire 3-minute video as samples.
        while((samples.length>96||frames.length>=maxQueue)&&!failed&&!disposed){cancelled(signal);await nextTick();}
        const chunk=await file.slice(offset,offset+chunkBytes).arrayBuffer();chunk.fileStart=offset;
        mp4.appendBuffer(chunk);onProgress(Math.min(1,(offset+chunk.byteLength)/file.size));
        await nextTick();
      }
      mp4.flush();
      if(!track)throw new MediaError('HF_MP4_NO_MOOV','Video metadata could not be read from MP4/MOV.');
    }catch(e){fail(e);}finally{producerDone=true;}
  };
  const decode=async()=>{
    try{
      while((!producerDone||samples.length)&&!disposed){
        cancelled(signal);if(failed)throw failed;
        if(!decoder||!samples.length||frames.length>=maxQueue){await nextTick();continue;}
        const sample=samples.shift();
        const timestamp=Math.round(sample.cts*1e6/(sample.timescale||track?.timescale||1000));
        const duration=Math.max(1,Math.round((sample.duration||1)*1e6/(sample.timescale||1000)));
        const chunk=new EncodedVideoChunk({type:(sample.is_sync ?? sample.is_rap)?'key':'delta',timestamp,duration,data:sample.data});
        decoder.decode(chunk);frameCount++;
        // Release parsed samples as soon as their bytes have been copied into
        // EncodedVideoChunk; an ISOFile may otherwise retain large sample data.
        deliveredCount++;
        mp4.releaseUsedSamples?.(track.trackId,Number.isInteger(sample.number)?sample.number+1:deliveredCount);
        while(decoder.decodeQueueSize>=8&&!disposed){cancelled(signal);if(failed)throw failed;await nextTick();}
      }
      if(decoder&&!disposed)await decoder.flush();
    }catch(e){fail(e);}finally{decodeDone=true;}
  };
  const producer=produce(),consumer=decode();
  try{
    while(!decodeDone||frames.length){
      cancelled(signal);if(failed)throw failed;
      if(!frames.length){await nextTick();continue;}
      const frame=frames.shift();
      if(firstTimestamp===null)firstTimestamp=frame.timestamp;
      const time=Math.max(0,(frame.timestamp-firstTimestamp)/1e6);
      yield {frame,time,timestampUs:frame.timestamp-firstTimestamp,meta:track};
      // Ownership belongs to the caller; exporter and tracker close each frame.
    }
    if(failed)throw failed;
    if(!frameCount)throw new MediaError('HF_DECODE_EMPTY','No decoded frames were produced. Try conversion to H.264.');
  }finally{
    disposed=true;
    while(frames.length)frames.shift().close();
    try{decoder?.close();}catch{}
    try{mp4.stop();}catch{}
    await Promise.allSettled([producer,consumer]);
  }
}
// Normalize portrait MOV display-transform metadata. VideoFrames from WebCodecs
// are raw (unrotated). Canvas used by MediaPipe and renderFrame is always in
// the same orientation as the visual editor's HTMLVideoElement.
export function drawOrientedFrame(ctx,frame,{width,height,rotation=0}={},displayWidth,displayHeight){
  const sw=frame.displayWidth||frame.codedWidth,sh=frame.displayHeight||frame.codedHeight;
  const W=displayWidth||width||sw,H=displayHeight||height||sh;
  if(ctx.canvas.width!==W)ctx.canvas.width=W;
  if(ctx.canvas.height!==H)ctx.canvas.height=H;
  ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,W,H);
  const rot=(rotation%360+360)%360;
  if(rot===90&&W/H>sw/sh*.9&&W/H<sw/sh*1.1){ctx.drawImage(frame,0,0,W,H);return;}
  if(rot===90){ctx.translate(W,0);ctx.rotate(Math.PI/2);ctx.drawImage(frame,0,0,H,W);}
  else if(rot===270){ctx.translate(0,H);ctx.rotate(-Math.PI/2);ctx.drawImage(frame,0,0,H,W);}
  else if(rot===180){ctx.translate(W,H);ctx.rotate(Math.PI);ctx.drawImage(frame,0,0,W,H);}
  else ctx.drawImage(frame,0,0,W,H);
  ctx.setTransform(1,0,0,1,0,0);
}
