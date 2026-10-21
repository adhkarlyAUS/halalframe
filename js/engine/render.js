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
// Outline masks need room above the pose/detector's highest landmark:
// forehead landmarks often start BELOW the hairline. Preview and export share
// this exact geometry, so their masks cannot diverge.
export function concealmentRect(box,c,W,H){
  const r=pixelBox(box,c?.wholeFrame?0:(c?.padding??.12),W,H);
  if(c?.shape!=='outline'||c?.wholeFrame)return boundedPersonRect(r,box,c,W,H);
  const extraTop=box.h*H*.30,extraSide=box.w*W*.10;
  const x=Math.max(0,r.x-extraSide),y=Math.max(0,r.y-extraTop);
  return boundedPersonRect({x,y,w:Math.min(W-x,r.w+(r.x-x)+extraSide),h:Math.min(H-y,r.h+(r.y-y))},box,c,W,H);
}
export function relativePixelStep(boxHeightPx,strength=42){
  return clamp(Math.round(Math.max(4,boxHeightPx/10)*(Math.max(3,strength)/42)),4,60);
}
function boundedPersonRect(r,box,c,W,H){
  // v1.12 (GPT review P1-4): never shrink a rectangle below the current box.
  // A person walking towards the camera legitimately grows far beyond their
  // historic median. Oversized *uncertain* predictions are already bounded in
  // ByteTrack (cappedGapBox / results), so the renderer only pads.
  return r;
}
function maskImage(entry){
  size(maskCanvas,entry.width,entry.height);
  const img=maskCtx.createImageData(entry.width,entry.height);
  for(let i=0;i<entry.data.length;i++){img.data[i*4]=255;img.data[i*4+1]=255;img.data[i*4+2]=255;img.data[i*4+3]=entry.data[i];}
  maskCtx.putImageData(img,0,0);
  return maskCanvas;
}
export function renderFrame(ctx,source,project,time,{debug=false,detections=[],predictedBox=null,draft=null,maskCache=null,previewMask=false}={}){
  if(!project||!source)return;
  const W=ctx.canvas.width,H=ctx.canvas.height;
  ctx.save();ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,W,H);
  try{ctx.drawImage(source,0,0,W,H);}catch{ctx.fillStyle='#090a0b';ctx.fillRect(0,0,W,H);ctx.restore();return;}
  const idx=Math.round(time*Math.max(1,project.video.fps));
  for(const c of activeAt(project,time)){
    const b=c.wholeFrame?{x:0,y:0,w:1,h:1}:boxAt(c,time);if(!b)continue;
    const entry=(c.shape==='box'||c.wholeFrame)?null:maskCache?.get(c,idx);
    // v1.12: a precise mask carries its own (person-extent) rectangle, which can
    // be larger than the detector box (e.g. arms, long hair, lower body).
    const r=entry?.rect&&!entry.fallback?{x:entry.rect.x*W,y:entry.rect.y*H,w:entry.rect.w*W,h:entry.rect.h*H}:concealmentRect(b,c,W,H);
    if(r.w<1||r.h<1)continue;
    // Only two supported effects: legacy black/brand projects migrate to Pixelate.
    // Treat any unknown value as Pixelate defensively, including during undo/redo.
    const effect=c.effect==='blur'?'blur':'pixelate';
    const precise=entry&&!entry.fallback&&entry.data;
    const ew=Math.ceil(r.w),eh=Math.ceil(r.h);
    size(effectCanvas,ew,eh);
    effectCtx.setTransform(1,0,0,1,0,0);effectCtx.clearRect(0,0,ew,eh);
    if(effect==='pixelate'){
      // Pixel blocks scale with PERSON size; a small CCTV pedestrian must not
      // inherit a 42px full-frame mosaic block. Strength remains adjustable.
      const personPx=Math.max(1,b.h*H);
      const step=relativePixelStep(personPx,c.strength||42);
      size(pixelBuffer,Math.ceil(ew/step),Math.ceil(eh/step));
      const sw=source.videoWidth||source.naturalWidth||source.width||W,sh=source.videoHeight||source.naturalHeight||source.height||H;
      pixelCtx.imageSmoothingEnabled=true;pixelCtx.drawImage(source,r.x/W*sw,r.y/H*sh,r.w/W*sw,r.h/H*sh,0,0,pixelBuffer.width,pixelBuffer.height);
      effectCtx.imageSmoothingEnabled=false;effectCtx.drawImage(pixelBuffer,0,0,ew,eh);effectCtx.imageSmoothingEnabled=true;
    }else{
      effectCtx.save();effectCtx.filter=`blur(${clamp(c.strength||18,1,70)}px)`;
      effectCtx.drawImage(source,-r.x,-r.y,W,H);
      effectCtx.restore();
    }
    if(!precise&&c.precisionCritical&&!c.wholeFrame){
      // Before a unique pose mask is available, DO NOT pixelate the padded
      // multiclass crop. Restrict the provisional mask to the selected track
      // box; neighbouring people in padding stay visible.
      effectCtx.globalCompositeOperation='destination-in';effectCtx.fillStyle='#fff';
      const bx=Math.max(0,b.x*W-r.x),by=Math.max(0,b.y*H-r.y);
      effectCtx.fillRect(bx,by,Math.max(1,b.w*W),Math.max(1,b.h*H));
      effectCtx.globalCompositeOperation='source-over';
    }
    if(precise){
      const m=maskImage(entry);
      // Smooth cropped mask edges only; conservative dilation is applied before this stage.
      size(maskSmoothCanvas,ew,eh);maskSmoothCtx.clearRect(0,0,ew,eh);
      maskSmoothCtx.filter='blur(2px)';maskSmoothCtx.drawImage(m,0,0,ew,eh);maskSmoothCtx.filter='none';
      // Never let antialiasing reintroduce pixels into an excluded person.
      maskSmoothCtx.globalCompositeOperation='destination-in';
      maskSmoothCtx.drawImage(m,0,0,ew,eh);
      maskSmoothCtx.globalCompositeOperation='source-over';
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
  if(debug&&predictedBox){const r=pixelBox(predictedBox,0,W,H);ctx.save();ctx.strokeStyle='#63e8ff';ctx.lineWidth=2;ctx.setLineDash([5,4]);ctx.strokeRect(r.x,r.y,r.w,r.h);ctx.setLineDash([]);ctx.fillStyle='#63e8ff';ctx.font='11px monospace';ctx.fillText('PREDICTED',r.x,Math.max(12,r.y-5));ctx.restore();}
  if(draft){const r=pixelBox(draft,0,W,H);ctx.strokeStyle='#b8f451';ctx.lineWidth=Math.max(2,W/650);ctx.setLineDash([8,5]);ctx.strokeRect(r.x,r.y,r.w,r.h);ctx.setLineDash([]);}
  ctx.restore();
}
