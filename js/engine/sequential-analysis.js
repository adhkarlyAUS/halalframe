// Forward analysis sampler using the same sequential decoder as export.
// A single 512px downscaled canvas is reused for PersonAI, keeping model input
// bounded on ordinary phones; full-res preview and output remain untouched.
import {sequentialVideoFrames,drawOrientedFrame} from './sequential-decoder.js';
import {isMP4} from './media-probe.js';
export const canSequentialAnalyse=file=>!!file&&isMP4(file)&&typeof VideoDecoder!=='undefined';
export function sequentialSampler(file,project,{signal,onProgress=()=>{}}={}){
  const iterator=sequentialVideoFrames(file,{signal,onProgress})[Symbol.asyncIterator]();
  const source=document.createElement('canvas'),ctx=source.getContext('2d',{alpha:false});
  const maxSide=512,ratio=Math.min(1,maxSide/Math.max(project.video.width,project.video.height));
  source.width=Math.max(2,Math.round(project.video.width*ratio));source.height=Math.max(2,Math.round(project.video.height*ratio));
  let sourceTime=-Infinity,completed=false;
  return {
    source,
    async at(t){
      if(completed)return null;
      if(sourceTime>=t-0.005)return source;
      while(true){
        if(signal?.aborted)throw new DOMException('Cancelled','AbortError');
        const next=await iterator.next();
        if(next.done){completed=true;return sourceTime>=0?source:null;}
        const {frame,time,meta}=next.value;
        try{drawOrientedFrame(ctx,frame,meta,source.width,source.height);}finally{frame.close();}
        sourceTime=time;
        if(time+0.5/Math.max(1,project.video.fps)>=t)return source;
      }
    },
    get time(){return sourceTime;},
    async close(){completed=true;await iterator.return?.();}
  };
}
