// HalalFrame 1.1. Local media is never sent to the service worker.
const SHELL='halalframe-shell-v1.1',AI='halalframe-ai-v1.1';
const ROOT=new URL('./',self.location.href);
const SHELL_FILES=['./','index.html','manifest.json','css/styles.css','js/main.js','js/state.js','js/engine/ai.js','js/engine/render.js','js/engine/segmentation.js','js/engine/export.js','js/engine/ffmpeg-worker.js','js/engine/tracker.js','js/ui/canvas-input.js','js/ui/timeline.js','assets/logo.png','assets/icon-192.png','assets/icon-512.png','assets/test-person.jpg'];
const PACKAGE='https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22-rc.20250304';
const AI_FILES=[`${PACKAGE}/vision_bundle.mjs`,...['vision_wasm_internal.js','vision_wasm_internal.wasm','vision_wasm_nosimd_internal.js','vision_wasm_nosimd_internal.wasm'].map(x=>`${PACKAGE}/wasm/${x}`),'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite','https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float32/1/efficientdet_lite0.tflite','https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite'];
self.addEventListener('install',e=>e.waitUntil((async()=>{const c=await caches.open(SHELL);await c.addAll(SHELL_FILES.map(x=>new URL(x,ROOT)));await self.skipWaiting();})()));
self.addEventListener('activate',e=>e.waitUntil((async()=>{const keep=[SHELL,AI];await Promise.all((await caches.keys()).filter(x=>x.startsWith('halalframe-')&&!keep.includes(x)).map(x=>caches.delete(x)));await self.clients.claim();})()));
self.addEventListener('fetch',e=>{
  const url=new URL(e.request.url);if(e.request.method!=='GET')return;
  if(url.origin===ROOT.origin&&url.pathname.startsWith(ROOT.pathname)){
    e.respondWith((async()=>{const cache=await caches.open(SHELL);const hit=await cache.match(e.request);if(hit)return hit;const res=await fetch(e.request);if(res.ok)cache.put(e.request,res.clone());return res;})());return;
  }
  if(AI_FILES.includes(e.request.url)){
    e.respondWith((async()=>{const cache=await caches.open(AI);const hit=await cache.match(e.request);if(hit)return hit;const res=await fetch(e.request);if(res.ok||res.type==='opaque')await cache.put(e.request,res.clone());return res;})());
  }
});
self.addEventListener('message',e=>{
  if(e.data?.type==='AI_STATUS')e.waitUntil((async()=>{const c=await caches.open(AI);const keys=await Promise.all(AI_FILES.map(url=>c.match(url)));e.ports[0]?.postMessage({ready:keys.every(Boolean),count:keys.filter(Boolean).length,total:AI_FILES.length});})());
  if(e.data?.type==='WARM_AI')e.waitUntil((async()=>{
    const cache=await caches.open(AI);let completed=0;
    for(const url of AI_FILES){
      try{if(!(await cache.match(url))){const req=new Request(url,{mode:'cors'});const res=await fetch(req);if(!res.ok)throw new Error(String(res.status));await cache.put(req,res.clone());}completed++;}
      catch(err){/* Uncached resource keeps AI offline indicator false. */}
      e.ports[0]?.postMessage({progress:completed,total:AI_FILES.length,done:false});
    }
    e.ports[0]?.postMessage({progress:completed,total:AI_FILES.length,done:true,ready:completed===AI_FILES.length});
  })());
});
