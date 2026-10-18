// HalalFrame service worker. One version source: registration URL ?v=APP_VERSION
// Every editor document/module is network-first and bypasses the HTTP cache.
// The pinned AI weights/wasm remain available offline once downloaded.
const VERSION=new URL(self.location.href).searchParams.get('v')||'unversioned';
const SHELL=`halalframe-shell-v${VERSION}`,AI='halalframe-ai-v1.1';
const ROOT=new URL('./',self.location.href);
const SHELL_FILES=['./','index.html','manifest.json','css/styles.css','js/main.js','js/state.js','js/engine/ai.js','js/engine/render.js','js/engine/segmentation.js','js/engine/export.js','js/engine/ffmpeg-worker.js','js/engine/tracker.js','js/ui/canvas-input.js','js/ui/timeline.js','assets/logo.png','assets/icon-192.png','assets/icon-512.png','assets/test-person.jpg'];
const PACKAGE='https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22-rc.20250304';
const AI_FILES=[`${PACKAGE}/vision_bundle.mjs`,...['vision_wasm_internal.js','vision_wasm_internal.wasm','vision_wasm_nosimd_internal.js','vision_wasm_nosimd_internal.wasm'].map(x=>`${PACKAGE}/wasm/${x}`),'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite','https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float32/1/efficientdet_lite0.tflite','https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite'];
const versioned=path=>new URL(path+( /\.(?:js|css|json)$/.test(path)?`?v=${VERSION}`:''),ROOT);
self.addEventListener('install',e=>e.waitUntil((async()=>{
  const c=await caches.open(SHELL);
  await c.addAll(SHELL_FILES.map(path=>new Request(versioned(path),{cache:'reload'})));
  await self.skipWaiting();
})()));
self.addEventListener('activate',e=>e.waitUntil((async()=>{
  await Promise.all((await caches.keys()).filter(x=>x.startsWith('halalframe-')&&![SHELL,AI].includes(x)).map(x=>caches.delete(x)));
  await self.clients.claim();
  for(const client of await self.clients.matchAll({type:'window',includeUncontrolled:true}))
    client.postMessage({type:'SW_ACTIVATED',version:VERSION});
})()));
async function cachedNetworkFirst(request,cacheName){
  const cache=await caches.open(cacheName);
  try{
    // Must bypass GitHub Pages/Chrome HTTP cache as well as the SW cache.
    const response=await fetch(request,{cache:'no-store'});
    if(response.ok)await cache.put(request,response.clone());
    return response;
  }catch(err){const fallback=await cache.match(request,{ignoreSearch:false});if(fallback)return fallback;throw err;}
}
async function aiResponse(request,cacheFirst){
  const cache=await caches.open(AI);
  if(cacheFirst){const hit=await cache.match(request);if(hit)return hit;}
  try{const res=await fetch(request,{cache:'no-store'});if(res.ok||res.type==='opaque')await cache.put(request,res.clone());return res;}
  catch(err){const hit=await cache.match(request);if(hit)return hit;throw err;}
}
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET')return;
  const url=new URL(e.request.url);
  if(url.origin===ROOT.origin&&url.pathname.startsWith(ROOT.pathname)){
    e.respondWith(cachedNetworkFirst(e.request,SHELL));return;
  }
  if(AI_FILES.includes(e.request.url)){
    const bigAsset=/\.(?:wasm|tflite)$/.test(url.pathname);
    e.respondWith(aiResponse(e.request,bigAsset));
  }
});
self.addEventListener('message',e=>{
  if(e.data?.type==='AI_STATUS')e.waitUntil((async()=>{
    const c=await caches.open(AI);const keys=await Promise.all(AI_FILES.map(url=>c.match(url)));
    e.ports[0]?.postMessage({ready:keys.every(Boolean),count:keys.filter(Boolean).length,total:AI_FILES.length});
  })());
  if(e.data?.type==='WARM_AI')e.waitUntil((async()=>{
    const cache=await caches.open(AI);let completed=0;
    for(const url of AI_FILES){
      try{if(!(await cache.match(url))){const req=new Request(url,{mode:'cors'});const res=await fetch(req);if(!res.ok)throw new Error(String(res.status));await cache.put(req,res.clone());}completed++;}
      catch(err){/* Offline status stays incomplete; user can retry. */}
      e.ports[0]?.postMessage({progress:completed,total:AI_FILES.length,done:false});
    }
    e.ports[0]?.postMessage({progress:completed,total:AI_FILES.length,done:true,ready:completed===AI_FILES.length});
  })());
});
