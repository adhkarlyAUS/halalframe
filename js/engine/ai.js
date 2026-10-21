// MediaPipe runs in this tab; no media uploads or application backend.
// All third-party library URLs are version-pinned. Google model URLs use version 1.
export const MEDIAPIPE_VERSION='0.10.22-rc.20250304';
export const PACKAGE=`https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}`;
export const MODELS={
  detector16:'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite',
  detector32:'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float32/1/efficientdet_lite0.tflite',
  segmenter:'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite',
  pose:'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
  embedder:'https://storage.googleapis.com/mediapipe-models/image_embedder/mobilenet_v3_small/float32/1/mobilenet_v3_small.tflite'
};
const inputCanvas=document.createElement('canvas');
const inputCtx=inputCanvas.getContext('2d',{willReadFrequently:true});
const TILE_SIZE=320;
const tileCanvas=document.createElement('canvas');
const tileCtx=tileCanvas.getContext('2d',{willReadFrequently:true});
// Overlapping square tiles (normalized), each the full short side. 16:9 → 3
// tiles with >60% overlap, so anyone narrower than ~0.6 of the short side is
// wholly inside at least one tile. Near-square frames need no tiles.
export function tileLayout(w,h){
  const aspect=w/Math.max(1,h);
  if(aspect<1.25&&aspect>0.8)return [];
  const landscape=aspect>=1;
  const span=landscape?aspect:1/aspect; // long side in short-side units
  const count=Math.min(4,Math.max(2,Math.ceil((span-1)/.42)+1));
  const tiles=[];
  for(let i=0;i<count;i++){
    const start=count===1?0:(i*(span-1)/(count-1))/span;
    tiles.push(landscape?{x:start,y:0,w:1/span,h:1}:{x:0,y:start,w:1,h:1/span});
  }
  return tiles;
}
const overlapArea=(a,b)=>Math.max(0,Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y));
// Cross-pass merge of whole-frame + tile detections. Each detector pass already
// performs its own NMS, so two boxes from the SAME pass are always kept as two
// people (shoulder-to-shoulder subjects can overlap heavily). Only boxes from
// DIFFERENT passes that describe the same body are merged, into their union so
// coverage never shrinks.
export function mergeDetections(list){
  const sorted=[...list].sort((a,b)=>(b.confidence||0)-(a.confidence||0)),kept=[];
  for(const d of sorted){
    let target=null;
    for(const k of kept){
      if(k.passes.has(d.pass??'full'))continue;
      const inter=overlapArea(d,k),ad=d.w*d.h,ak=k.w*k.h;
      const iouV=inter/Math.max(1e-9,ad+ak-inter),contain=inter/Math.max(1e-9,Math.min(ad,ak));
      const sizeRatio=Math.min(ad,ak)/Math.max(ad,ak);
      const dc={x:d.x+d.w/2,y:d.y+d.h/2},kc={x:k.x+k.w/2,y:k.y+k.h/2};
      const centreClose=Math.abs(dc.x-kc.x)<.25*Math.min(d.w,k.w)&&Math.abs(dc.y-kc.y)<.25*Math.min(d.h,k.h);
      if((iouV>.6&&centreClose)||(contain>.9&&sizeRatio>.55&&centreClose)){target=k;break;}
    }
    if(target){
      const x=Math.min(target.x,d.x),y=Math.min(target.y,d.y);
      target.w=Math.max(target.x+target.w,d.x+d.w)-x;target.h=Math.max(target.y+target.h,d.y+d.h)-y;target.x=x;target.y=y;
      target.passes.add(d.pass??'full');
    }else kept.push({x:d.x,y:d.y,w:d.w,h:d.h,confidence:d.confidence,passes:new Set([d.pass??'full'])});
  }
  return kept.map(({passes,...b})=>b);
}
function personBoxes(result,width,height) {
  return (result?.detections||[]).filter(d=>d.categories?.some(x=>(x.categoryName||x.displayName||'').toLowerCase()==='person'))
    .map(d=>{
      const bb=d.boundingBox||{};
      const category=d.categories.find(x=>(x.categoryName||x.displayName||'').toLowerCase()==='person');
      return {x:Math.max(0,bb.originX/width),y:Math.max(0,bb.originY/height),w:Math.min(1,(bb.width||0)/width),h:Math.min(1,(bb.height||0)/height),confidence:category?.score||0};
    }).filter(d=>d.w>0.008&&d.h>0.008);
}
export class PersonAI {
  constructor({onStatus=()=>{}}={}){
    this.onStatus=onStatus;this.detector=null;this.segmenter=null;this.pose=null;this.posePromise=null;this.poseDelegate='uninitialized';this.poseCache=new Map();this.embedder=null;this.embedderPromise=null;this.delegate='uninitialized';this.frameCache=new Map();this.lastTime=0;this.segmentLastTime=0;this.segmentDelegate='uninitialized';this.running=false;
  }
  get ready(){return !!this.detector;}
  async init() {
    if(this.detector)return;
    if(this.running){while(this.running){await new Promise(r=>setTimeout(r,60));}if(!this.detector)throw new Error('AI initialization failed');return;}
    this.running=true;
    try{
      this.onStatus('Downloading on-device AI runtime…');
      const pkg=await import(`${PACKAGE}/vision_bundle.mjs`);
      const vision=await pkg.FilesetResolver.forVisionTasks(`${PACKAGE}/wasm`);
      let error=null;
      // Attempt float16 GPU first, then CPU, then documented float32 fallback.
      for(const [delegate,asset] of [['GPU',MODELS.detector16],['CPU',MODELS.detector16],['GPU',MODELS.detector32],['CPU',MODELS.detector32]]) {
        try{
          this.onStatus(`Loading person detector (${delegate})…`);
          this.detector=await pkg.ObjectDetector.createFromOptions(vision,{baseOptions:{modelAssetPath:asset,delegate},runningMode:'VIDEO',scoreThreshold:0.18,categoryAllowlist:['person'],maxResults:40});
          this.delegate=delegate;break;
        }catch(e){error=e;}
      }
      if(!this.detector)throw error||new Error('Could not load the person detector');
      this.onStatus(`AI ready on ${this.delegate}`);
    }finally{this.running=false;}
  }
  resetCache(){this.frameCache.clear();this.poseCache.clear();}
  async switchToCPU(){
    if(this.delegate==='CPU')throw new Error('CPU detector also failed');
    this.detector?.close();this.detector=null;this.delegate='uninitialized';
    const pkg=await import(`${PACKAGE}/vision_bundle.mjs`);
    const vision=await pkg.FilesetResolver.forVisionTasks(`${PACKAGE}/wasm`);
    for(const asset of [MODELS.detector16,MODELS.detector32]){
      try{this.detector=await pkg.ObjectDetector.createFromOptions(vision,{baseOptions:{modelAssetPath:asset,delegate:'CPU'},runningMode:'VIDEO',scoreThreshold:0.18,categoryAllowlist:['person'],maxResults:40});this.delegate='CPU';return;}
      catch{}
    }
    throw new Error('No compatible MediaPipe CPU detector');
  }
  async detect(source, t, fps=30,{force=false,tiles=true}={}) {
    await this.init();
    const key=Math.round(t*fps);
    // A cached whole-frame-only result is not good enough for a tiled request.
    if(!force&&this.frameCache.has(key)){const hit=this.frameCache.get(key);if(!tiles||hit?.tiled||!tileLayout(source.videoWidth||source.naturalWidth||source.width||1,source.videoHeight||source.naturalHeight||source.height||1).length)return hit;}
    const w=source.videoWidth||source.naturalWidth||source.width||512;
    const h=source.videoHeight||source.naturalHeight||source.height||288;
    const W=Math.min(512,w),H=Math.max(1,Math.round(W*h/w));
    if(inputCanvas.width!==W)inputCanvas.width=W;if(inputCanvas.height!==H)inputCanvas.height=H;
    inputCtx.drawImage(source,0,0,W,H);
    let boxes=personBoxes(await this._run(inputCanvas),W,H);
    // v1.12: EfficientDet-Lite0 sees a SQUARE 320px input. A 16:9 (or 9:16)
    // frame is squashed, so medium/small people fall below the score threshold
    // (measured 0.13–0.35 on clearly visible walkers). Overlapping square tiles
    // at native aspect raise the same people to 0.77–0.95. Whole-frame boxes are
    // kept for large/close-up subjects that cross tile borders.
    if(tiles){
      const tiled=await this._detectTiles(source,w,h);
      if(tiled.length)boxes=mergeDetections(boxes.concat(tiled));
      boxes.tiled=true;
    }
    const prev=this.frameCache.get(key);
    if(!(prev?.tiled&&!boxes.tiled&&!force))this.frameCache.set(key,boxes);
    if(this.frameCache.size>1800){this.frameCache.delete(this.frameCache.keys().next().value);}
    return boxes;
  }
  async _run(canvas){
    // MediaPipe VIDEO expects increasing timestamps even during backwards seeks.
    this.lastTime=Math.max(this.lastTime+1,Math.round(performance.now()));
    try{return this.detector.detectForVideo(canvas,this.lastTime);}
    catch(e){if(this.delegate!=='CPU'){this.onStatus('GPU inference failed; switching to CPU…');await this.switchToCPU();this.lastTime+=1;return this.detector.detectForVideo(canvas,this.lastTime);}throw e;}
  }
  async _detectTiles(source,w,h){
    const layout=tileLayout(w,h);if(!layout.length)return [];
    const side=TILE_SIZE;
    if(tileCanvas.width!==side)tileCanvas.width=side;if(tileCanvas.height!==side)tileCanvas.height=side;
    const out=[];
    for(const [ti,t] of layout.entries()){
      tileCtx.drawImage(source,t.x*w,t.y*h,t.w*w,t.h*h,0,0,side,side);
      const found=personBoxes(await this._run(tileCanvas),side,side);
      for(const b of found){
        // A person cut by an INTERIOR tile edge is complete in a neighbouring
        // overlapping tile (or in the whole-frame pass for large subjects).
        const edge=.012;
        if((b.x<edge&&t.x>0)||(b.x+b.w>1-edge&&t.x+t.w<1-1e-6)||(b.y<edge&&t.y>0)||(b.y+b.h>1-edge&&t.y+t.h<1-1e-6))continue;
        out.push({x:t.x+b.x*t.w,y:t.y+b.y*t.h,w:b.w*t.w,h:b.h*t.h,confidence:b.confidence,pass:'tile'+ti});
      }
    }
    return out;
  }
  // The crop-based ImageSegmenter is used by the Phase 3 mask cache and exporter.
  async initSegmenter(){
    if(this.segmenter)return this.segmenter;
    const pkg=await import(`${PACKAGE}/vision_bundle.mjs`);
    const vision=await pkg.FilesetResolver.forVisionTasks(`${PACKAGE}/wasm`);
    for(const delegate of ['GPU','CPU']){
      try{this.segmenter=await pkg.ImageSegmenter.createFromOptions(vision,{baseOptions:{modelAssetPath:MODELS.segmenter,delegate},runningMode:'VIDEO',outputCategoryMask:true,outputConfidenceMasks:false});this.segmentDelegate=delegate;return this.segmenter;}
      catch{}
    }
    throw new Error('Multiclass segmenter not supported on this device');
  }

  async segmentCrop(cropCanvas){
    await this.initSegmenter();
    const perform=()=>{
      // Always increment the MediaPipe VIDEO timestamp; seek/scrub time is not monotonic.
      this.segmentLastTime=Math.max(this.segmentLastTime+1,Math.round(performance.now()));
      let output=null;
      this.segmenter.segmentForVideo(cropCanvas,this.segmentLastTime,result=>{
        if(!result?.categoryMask)throw new Error('Segmenter produced no category mask');
        const m=result.categoryMask;
        // Copy while callback mask is valid; memory may be recycled after return.
        output={width:m.width,height:m.height,data:new Uint8Array(m.getAsUint8Array())};
      });
      if(!output)throw new Error('Segmenter returned no output');
      return output;
    };
    try{return perform();}
    catch(e){
      if(this.segmentDelegate!=='GPU')throw e;
      this.onStatus('Segmentation GPU failed, trying CPU…');
      try{this.segmenter?.close();}catch{}
      this.segmenter=null;this.segmentDelegate='uninitialized';
      // Explicit CPU fallback, never repeatedly select a failing GPU delegate.
      const pkg=await import(`${PACKAGE}/vision_bundle.mjs`);
      const vision=await pkg.FilesetResolver.forVisionTasks(`${PACKAGE}/wasm`);
      this.segmenter=await pkg.ImageSegmenter.createFromOptions(vision,{baseOptions:{modelAssetPath:MODELS.segmenter,delegate:'CPU'},runningMode:'VIDEO',outputCategoryMask:true,outputConfidenceMasks:false});
      this.segmentDelegate='CPU';
      return perform();
    }
  }
  // PoseLandmarker outputs a separate foreground probability mask for each pose.
  // The returned masks are copied in the callback before the native frame is freed.
  async initPose(){
    if(this.pose)return this.pose;
    if(this.posePromise)return this.posePromise;
    this.posePromise=(async()=>{
      const pkg=await import(`${PACKAGE}/vision_bundle.mjs`);
      const vision=await pkg.FilesetResolver.forVisionTasks(`${PACKAGE}/wasm`);
      let lastError;
      for(const delegate of ['GPU','CPU']){
        try{
          this.pose=await pkg.PoseLandmarker.createFromOptions(vision,{baseOptions:{modelAssetPath:MODELS.pose,delegate},runningMode:'IMAGE',numPoses:5,outputSegmentationMasks:true,minPoseDetectionConfidence:.35,minPosePresenceConfidence:.35});
          this.poseDelegate=delegate;this.onStatus(`Person-instance masks ready (${delegate})`);return this.pose;
        }catch(e){lastError=e;}
      }
      throw new Error('Per-person pose segmentation unavailable: '+lastError?.message);
    })().finally(()=>{this.posePromise=null;});
    return this.posePromise;
  }
  async poseInstances(source,t,fps=30){
    const idx=Math.round(t*fps);if(this.poseCache.has(idx))return this.poseCache.get(idx);
    await this.initPose();
    const w=source.videoWidth||source.naturalWidth||source.width||512,h=source.videoHeight||source.naturalHeight||source.height||288;
    const W=Math.min(512,w),H=Math.max(1,Math.round(W*h/w));
    const cv=document.createElement('canvas');cv.width=W;cv.height=H;
    cv.getContext('2d').drawImage(source,0,0,W,H);
    this.poseLastTime=Math.max((this.poseLastTime||0)+1,Math.round(performance.now()));
    let instances=[];
    const read=()=>{
      // v1.12: use the RETURN-VALUE form. With the GPU delegate the callback
      // form hands back all-zero segmentation masks (verified in Chrome),
      // which silently disabled every per-person outline and forced the
      // rectangular fallback. The returned result is copied, then closed.
      // v1.12: IMAGE mode runs the person detector on EVERY frame. VIDEO mode
      // only re-detects when its tracker is lost, so a second person standing
      // next to the first was never given a pose/mask (verified: IMAGE finds
      // 2 of 2 people, VIDEO 1 of 2, on the same frame).
      const result=this.pose.detect(cv);
      try{
        instances=(result.landmarks||[]).map((landmarks,i)=>{
          const visible=landmarks.filter(p=>(p.visibility??1)>.28&&p.x>=0&&p.x<=1&&p.y>=0&&p.y<=1);
          if(visible.length<5)return null;
          const bx=Math.min(...visible.map(p=>p.x)),by=Math.min(...visible.map(p=>p.y));
          const right=Math.max(...visible.map(p=>p.x)),bottom=Math.max(...visible.map(p=>p.y));
          const mask=result.segmentationMasks?.[i];
          return {box:{x:bx,y:by,w:right-bx,h:bottom-by},landmarks,
            mask:mask?{width:mask.width,height:mask.height,data:new Float32Array(mask.getAsFloat32Array())}:null};
        }).filter(Boolean);
      }finally{try{result.close?.();}catch{}}
    };
    try{read();}catch(error){
      if(this.poseDelegate!=='GPU')throw error;
      this.pose?.close();this.pose=null;this.poseDelegate='uninitialized';await this.initPose();
      this.poseLastTime++;read();
    }
    this.poseCache.set(idx,instances);
    if(this.poseCache.size>4)this.poseCache.delete(this.poseCache.keys().next().value);
    return instances;
  }
  // An optional CNN appearance descriptor for ambiguous crossings. Color
  // histograms remain available when this model cannot initialize on a phone.
  async embedPerson(source,box){
    if(!this.embedder){
      if(!this.embedderPromise)this.embedderPromise=(async()=>{
        const pkg=await import(`${PACKAGE}/vision_bundle.mjs`),vision=await pkg.FilesetResolver.forVisionTasks(`${PACKAGE}/wasm`);
        for(const delegate of ['CPU','GPU']){
          try{this.embedder=await pkg.ImageEmbedder.createFromOptions(vision,{baseOptions:{modelAssetPath:MODELS.embedder,delegate},runningMode:'IMAGE',l2Normalize:true});break;}catch{}
        }
        if(!this.embedder)throw new Error('MobileNet embedder unavailable');
      })().finally(()=>{this.embedderPromise=null;});
      await this.embedderPromise;
    }
    const cv=document.createElement('canvas');cv.width=cv.height=224;
    const W=source.videoWidth||source.naturalWidth||source.width||1,H=source.videoHeight||source.naturalHeight||source.height||1;
    cv.getContext('2d').drawImage(source,box.x*W,box.y*H,Math.max(1,box.w*W),Math.max(1,box.h*H),0,0,224,224);
    const result=this.embedder.embed(cv),e=result.embeddings?.[0];
    return e?.floatEmbedding?Array.from(e.floatEmbedding):null;
  }
  async selfCheck(image){
    await this.init();
    const boxes=await this.detect(image,0,1,{force:true});
    return {detected:boxes.length,delegate:this.delegate,model:'EfficientDet Lite0',message:boxes.length?'Person detected on bundled test image':'Bundled illustration is not a reliable detector benchmark; test with a real photo'};
  }
}
export function pointInBox(x,y,b){return x>=b.x&&x<=b.x+b.w&&y>=b.y&&y<=b.y+b.h;}
export function nearestPerson(boxes,x,y){
  const containing=boxes.filter(b=>pointInBox(x,y,b));
  if(containing.length)return containing.sort((a,b)=>a.w*a.h-b.w*b.h)[0];
  return boxes.map(b=>({b,d:Math.hypot(Math.max(b.x-x,0,x-(b.x+b.w)),Math.max(b.y-y,0,y-(b.y+b.h)))})).sort((a,b)=>a.d-b.d)[0]?.b||null;
}
