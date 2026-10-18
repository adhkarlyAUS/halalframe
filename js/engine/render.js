import {activeAt,boxAt,clamp} from '../state.js';
const effectCanvas=document.createElement('canvas'),effectCtx=effectCanvas.getContext('2d');
const maskCanvas=document.createElement('canvas'),maskCtx=maskCanvas.getContext('2d',{willReadFrequently:true});
const maskSmoothCanvas=document.createElement('canvas'),maskSmoothCtx=maskSmoothCanvas.getContext('2d');
const pixelBuffer=document.createElement('canvas'),pixelCtx=pixelBuffer.getContext('2d');
const highlightCanvas=document.createElement('canvas'),highlightCtx=highlightCanvas.getContext('2d');
function size(canvas,w,h){w=Math.max(1,Math.round(w));h=Math.max(1,Math.round(h));if(canvas.width!==w)canvas.width=w;if(canvas.height!==h)canvas.height=h;}
export function pixelBox(box,padding,W,H){
  const dx=box.w*padding,dy=box.h*padding;
  const x=clamp((box.x-dx)*W,0,W),y=clamp((box.y-dy)*H,0,H);
  return {x,y,w:clamp((box.w+2*dx)*W,0,W-x),h:clamp((box.h+2*dy)*H,0,H-y)};
}
function maskImage(entry){
  size(maskCanvas,entry.width,entry.height);
  const img=maskCtx.createImageData(entry.width,entry.height);
  for(let i=0;i<entry.data.length;i++){img.data[i*4]=255;img.data[i*4+1]=255;img.data[i*4+2]=255;img.data[i*4+3]=entry.data[i];}
  maskCtx.putImageData(img,0,0);
  return maskCanvas;
}
export function renderFrame(ctx,source,project,time,{debug=false,detections=[],draft=null,maskCache=null,previewMask=false}={}){
  if(!project||!source)return;
  const W=ctx.canvas.width,H=ctx.canvas.height;
  ctx.save();ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,W,H);
  try{ctx.drawImage(source,0,0,W,H);}catch{ctx.fillStyle='#090a0b';ctx.fillRect(0,0,W,H);ctx.restore();return;}
  const idx=Math.round(time*Math.max(1,project.video.fps));
  for(const c of activeAt(project,time)){
    const b=c.wholeFrame?{x:0,y:0,w:1,h:1}:boxAt(c,time);if(!b)continue;
    const r=pixelBox(b,c.wholeFrame?0:(c.padding??.12),W,H);if(r.w<1||r.h<1)continue;
    const entry=(c.shape==='box'||c.wholeFrame)?null:maskCache?.get(c,idx);
    // An old or oversized tracking mask may NEVER turn into full-screen
    // HalalFrame branding unless the user explicitly chose Whole Frame.
    // Solid black is the safe, non-branded fallback for that case.
    const effect=c.effect==='brand'&&!c.wholeFrame&&r.w>=W*.94&&r.h>=H*.94?'black':c.effect;
    // Cache miss or invalid/empty segmentation always covers the full padded box.
    const precise=entry&&!entry.fallback&&entry.data;
    const ew=Math.ceil(r.w),eh=Math.ceil(r.h);
    size(effectCanvas,ew,eh);
    effectCtx.setTransform(1,0,0,1,0,0);effectCtx.clearRect(0,0,ew,eh);
    if(effect==='black'){effectCtx.fillStyle='#000';effectCtx.fillRect(0,0,ew,eh);}
    else if(effect==='brand'){effectCtx.fillStyle='#000';effectCtx.fillRect(0,0,ew,eh);effectCtx.fillStyle='#b8f451';effectCtx.font=`${Math.max(10,Math.min(ew/7,24))}px sans-serif`;effectCtx.fillText('HalalFrame',8,Math.min(eh-5,26));}
    else if(effect==='pixelate'){
      const step=Math.max(3,Number(c.strength)||18);size(pixelBuffer,Math.ceil(ew/step),Math.ceil(eh/step));
      const sw=source.videoWidth||source.naturalWidth||source.width||W,sh=source.videoHeight||source.naturalHeight||source.height||H;
      pixelCtx.imageSmoothingEnabled=true;pixelCtx.drawImage(source,r.x/W*sw,r.y/H*sh,r.w/W*sw,r.h/H*sh,0,0,pixelBuffer.width,pixelBuffer.height);
      effectCtx.imageSmoothingEnabled=false;effectCtx.drawImage(pixelBuffer,0,0,ew,eh);effectCtx.imageSmoothingEnabled=true;
    }else if(effect==='blur'){
      // Draw a larger source region before blurring, to avoid transparent dark edges.
      const extra=Math.ceil(Math.max(3,Number(c.strength||18)*2));
      const sw=source.videoWidth||source.naturalWidth||source.width||W,sh=source.videoHeight||source.naturalHeight||source.height||H;
      effectCtx.save();effectCtx.filter=`blur(${clamp(c.strength||18,1,70)}px)`;
      effectCtx.drawImage(source,-r.x,-r.y,W,H);
      effectCtx.restore();
    }
    if(precise){
      const m=maskImage(entry);
      // Smooth cropped mask edges only; conservative dilation is applied before this stage.
      size(maskSmoothCanvas,ew,eh);maskSmoothCtx.clearRect(0,0,ew,eh);
      maskSmoothCtx.filter='blur(2px)';maskSmoothCtx.drawImage(m,0,0,ew,eh);maskSmoothCtx.filter='none';
      effectCtx.globalCompositeOperation='destination-in';
      effectCtx.drawImage(maskSmoothCanvas,0,0,ew,eh);
      effectCtx.globalCompositeOperation='source-over';

    }
    ctx.drawImage(effectCanvas,r.x,r.y,r.w,r.h);
    if(previewMask&&precise){
      size(highlightCanvas,ew,eh);highlightCtx.globalCompositeOperation='source-over';highlightCtx.fillStyle='#b8f451';highlightCtx.fillRect(0,0,ew,eh);
      highlightCtx.globalCompositeOperation='destination-in';highlightCtx.drawImage(maskSmoothCanvas,0,0,ew,eh);highlightCtx.globalCompositeOperation='source-over';
      ctx.save();ctx.globalAlpha=.48;ctx.drawImage(highlightCanvas,r.x,r.y,r.w,r.h);ctx.restore();
    }
    if(debug&&entry?.fallback){ctx.save();ctx.fillStyle='#ffcb77';ctx.font='11px sans-serif';ctx.fillText(`Box fallback: ${entry.reason}`,r.x,Math.max(12,r.y-3));ctx.restore();}
  }
  if(debug){
    for(const d of detections){const r=pixelBox(d,0,W,H);ctx.strokeStyle='#f0ce70';ctx.lineWidth=2;ctx.strokeRect(r.x,r.y,r.w,r.h);ctx.fillStyle='#f0ce70';ctx.font='11px sans-serif';ctx.fillText(`${Math.round((d.confidence||0)*100)}%`,r.x,r.y-3);}
  }
  if(draft){const r=pixelBox(draft,0,W,H);ctx.strokeStyle='#b8f451';ctx.lineWidth=Math.max(2,W/650);ctx.setLineDash([8,5]);ctx.strokeRect(r.x,r.y,r.w,r.h);ctx.setLineDash([]);}
  ctx.restore();
}
