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
  async detect(source, t, fps=30,{force=false}={}) {
    await this.init();
    const key=Math.round(t*fps);
    if(!force&&this.frameCache.has(key))return this.frameCache.get(key);
    const w=source.videoWidth||source.naturalWidth||source.width||512;
    const h=source.videoHeight||source.naturalHeight||source.height||288;
    const W=Math.min(512,w),H=Math.max(1,Math.round(W*h/w));
    if(inputCanvas.width!==W)inputCanvas.width=W;if(inputCanvas.height!==H)inputCanvas.height=H;
    inputCtx.drawImage(source,0,0,W,H);
    // MediaPipe VIDEO expects increasing timestamps even during backwards seeks.
    this.lastTime=Math.max(this.lastTime+1,Math.round(performance.now()));
    let res;
    try{res=this.detector.detectForVideo(inputCanvas,this.lastTime);}
    catch(e){if(this.delegate!=='CPU'){this.onStatus('GPU inference failed; switching to CPU…');await this.switchToCPU();this.lastTime+=1;res=this.detector.detectForVideo(inputCanvas,this.lastTime);}else throw e;}
    const boxes=personBoxes(res,W,H);
    this.frameCache.set(key,boxes);
    if(this.frameCache.size>1800){this.frameCache.delete(this.frameCache.keys().next().value);}
    return boxes;
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
          this.pose=await pkg.PoseLandmarker.createFromOptions(vision,{baseOptions:{modelAssetPath:MODELS.pose,delegate},runningMode:'VIDEO',numPoses:5,outputSegmentationMasks:true,minPoseDetectionConfidence:.35,minPosePresenceConfidence:.35});
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
      this.pose.detectForVideo(cv,this.poseLastTime,result=>{
        instances=(result.landmarks||[]).map((landmarks,i)=>{
          const visible=landmarks.filter(p=>(p.visibility??1)>.28&&p.x>=0&&p.x<=1&&p.y>=0&&p.y<=1);
          if(visible.length<5)return null;
          const bx=Math.min(...visible.map(p=>p.x)),by=Math.min(...visible.map(p=>p.y));
          const right=Math.max(...visible.map(p=>p.x)),bottom=Math.max(...visible.map(p=>p.y));
          const mask=result.segmentationMasks?.[i];
          return {box:{x:bx,y:by,w:right-bx,h:bottom-by},landmarks,
            mask:mask?{width:mask.width,height:mask.height,data:new Float32Array(mask.getAsFloat32Array())}:null};
        }).filter(Boolean);
      });
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
