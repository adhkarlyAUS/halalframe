// Explicit user-controlled, on-device source conversion. No network upload.
// FFmpeg single-thread core may not contain an HEVC decoder on every release;
// failure is reported with an actionable diagnostic, never misrepresented.
import {loadFFmpeg} from './export.js';
import {MediaError} from './media-probe.js';
const aborted=signal=>{if(signal?.aborted)throw new DOMException('Conversion cancelled','AbortError');};
export async function convertSourceToH264(file,{signal,onProgress=()=>{},onStatus=()=>{},hdr=false}={}){
  aborted(signal);onStatus('Loading offline FFmpeg converter (first use approximately 32 MB)…');
  let ffmpeg,fetchFile;
  try{({ffmpeg,fetchFile}=await loadFFmpeg());}
  catch(e){throw new MediaError('HF_CONVERTER_LOAD','The on-device converter could not load. Check internet and available phone memory.',{cause:e.message});}
  const abort=()=>ffmpeg.terminate();signal?.addEventListener('abort',abort,{once:true});
  const maxInput=900*1024*1024;
  try{
    if(file.size>maxInput)throw new MediaError('HF_CONVERTER_MEMORY','This file is too large for the in-browser converter. Convert it on a computer to H.264 8-bit MP4.');
    ffmpeg.on('progress',({progress,time})=>{
      if(progress>=0&&Number.isFinite(progress))onProgress(Math.min(.98,progress));
      if(time>0)onStatus(`Converting locally · ${(time/1e6).toFixed(1)} seconds encoded`);
    });
    await ffmpeg.writeFile('input.mov',await fetchFile(file));
    // Smaller dimension capped at 1080; 2-pixel alignment; rotation metadata is
    // applied by FFmpeg auto-rotate and removed from transcoded stream.
    const scale='scale=w=if(gte(iw\\,ih)\\,-2\\,min(1080\\,iw)):h=if(gte(iw\\,ih)\\,min(1080\\,ih)\\,-2),format=yuv420p';
    const hdrFilter=`zscale=matrixin=bt2020nc:transferin=smpte2084:primariesin=bt2020:transfer=linear:matrix=gbr:primaries=bt2020,format=gbrpf32le,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:p=bt709:r=tv,${scale}`;
    let toneMapped=false,rc=-1;
    const base=['-y','-autorotate','-i','input.mov','-map','0:v:0','-map','0:a?','-vsync','cfr',
      '-r','30','-c:v','libx264','-preset','ultrafast','-crf','24','-g','60','-pix_fmt','yuv420p',
      '-c:a','aac','-b:a','96k','-movflags','+faststart'];
    if(hdr){
      onStatus('Trying HDR-to-SDR tone mapping locally…');
      rc=await ffmpeg.exec([...base.slice(0,base.indexOf('-c:v')),'-vf',hdrFilter,...base.slice(base.indexOf('-c:v')),'converted.mp4']);
      toneMapped=rc===0;
    }
    if(rc!==0){
      if(hdr)onStatus('Advanced tone mapping unavailable in this FFmpeg core. Trying basic 8-bit conversion (colours may differ)…');
      rc=await ffmpeg.exec([...base.slice(0,base.indexOf('-c:v')),'-vf',scale,...base.slice(base.indexOf('-c:v')),'converted.mp4']);
    }
    if(rc!==0)throw new MediaError('HF_CONVERT_UNSUPPORTED','This device cannot decode/convert the video with the available FFmpeg core. Use the phone’s compatibility export or a desktop converter to H.264 MP4.',{hdr});
    aborted(signal);
    const bytes=await ffmpeg.readFile('converted.mp4');onProgress(1);
    return {file:new File([bytes],file.name.replace(/\.[^.]+$/,'')+'-compatible.mp4',{type:'video/mp4',lastModified:Date.now()}),
      warning:hdr&&!toneMapped?'HDR colours were converted without advanced tone mapping; check the result.':null};
  }catch(e){
    if(e instanceof MediaError||e.name==='AbortError')throw e;
    throw new MediaError('HF_CONVERT_FAILED','Local video conversion failed. Try a shorter clip or convert using your phone’s Compatibility/H.264 setting.',{cause:e.message});
  }finally{signal?.removeEventListener('abort',abort);ffmpeg.terminate();}
}
