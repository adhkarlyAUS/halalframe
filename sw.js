// HalalFrame service worker. One version source: registration URL ?v=APP_VERSION
// Every editor document/module is network-first and bypasses the HTTP cache.
// The pinned AI weights/wasm remain available offline once downloaded.
const VERSION=new URL(self.location.href).searchParams.get('v')||'unversioned';
const SHELL=`halalframe-shell-v${VERSION}`,AI='halalframe-ai-v1.1',AUDIO='halalframe-audio-models-v1.5';
const ROOT=new URL('./',self.location.href);
const SHELL_FILES=['./','index.html','manifest.json','css/styles.css','js/main.js','js/state.js','js/engine/ai.js','js/engine/render.js','js/engine/segmentation.js','js/engine/export.js','js/engine/ffmpeg-worker.js','js/engine/tracker.js','js/engine/identity.js','js/ui/canvas-input.js','js/ui/timeline.js','js/ui/first-run.js','js/ui/share-target.js','js/ui/audio-panel.js','js/audio/models.js','js/audio/dsp.js','js/audio/music-worker.js','js/audio/music-check.js','assets/logo.png','assets/logo-transparent.png',...['tap-person','track-person','export-video'].map(n=>`assets/onboarding/${n}.svg`),'assets/icon-192.png','assets/icon-512.png','assets/test-person.jpg','assets/favicon-32.png','assets/apple-touch-icon.png','assets/icon-maskable-512.png',...['48','72','96','128','256','384'].map(n=>`assets/icon-${n}.png`),...['welcome','editor','audio'].map(n=>`assets/screenshot-${n}.png`)];
const PACKAGE='https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22-rc.20250304';
const AI_FILES=[`${PACKAGE}/vision_bundle.mjs`,...['vision_wasm_internal.js','vision_wasm_internal.wasm','vision_wasm_nosimd_internal.js','vision_wasm_nosimd_internal.wasm'].map(x=>`${PACKAGE}/wasm/${x}`),'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite','https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float32/1/efficientdet_lite0.tflite','https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite','https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task','https://storage.googleapis.com/mediapipe-models/image_embedder/mobilenet_v3_small/float32/1/mobilenet_v3_small.tflite'];
// Optional audio weights are downloaded only after the user requests cleaning.
// A fixed revision preserves checksum-pinned, MIT-licensed model bytes.
const AUDIO_ROOT='https://huggingface.co/Politrees/UVR_resources/resolve/8cc4418db60d96e501f42889370b8bf3eb6df2d2/models/MDXNet/';
const AUDIO_WEIGHTS=[
  'https://raw.githubusercontent.com/snakers4/silero-vad/60b7ffa243625ebdc1070275a29f18c87843786a/src/silero_vad/data/silero_vad.onnx',
  AUDIO_ROOT+'UVR_MDXNET_9482.onnx',AUDIO_ROOT+'UVR-MDX-NET-Voc_FT.onnx'];
const ORT_RUNTIME='https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/';
const TASKS_AUDIO='https://cdn.jsdelivr.net/npm/@mediapipe/tasks-audio@0.10.22-rc.20250304';
const YAMNET='https://storage.googleapis.com/mediapipe-models/audio_classifier/yamnet/float32/1/yamnet.tflite';
const MUSIC_CHECK_ASSETS=[YAMNET,`${TASKS_AUDIO}/audio_bundle.mjs`,...['audio_wasm_internal.js','audio_wasm_internal.wasm','audio_wasm_nosimd_internal.js','audio_wasm_nosimd_internal.wasm'].map(n=>`${TASKS_AUDIO}/wasm/${n}`)];
const DEMUCS_MODEL='https://huggingface.co/timcsy/demucs-web-onnx/resolve/92e33df/htdemucs_embedded.onnx';
const versioned=path=>new URL(path+( /\.(?:js|css|json)$/.test(path)?`?v=${VERSION}`:''),ROOT);
self.addEventListener('install',e=>e.waitUntil((async()=>{
  const c=await caches.open(SHELL);
  await c.addAll(SHELL_FILES.map(path=>new Request(versioned(path),{cache:'reload'})));
  await self.skipWaiting();
})()));
self.addEventListener('activate',e=>e.waitUntil((async()=>{
  await Promise.all((await caches.keys()).filter(x=>x.startsWith('halalframe-')&&![SHELL,AI,AUDIO].includes(x)).map(x=>caches.delete(x)));
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
async function aiResponse(request,cacheFirst,cacheName=AI){
  const cache=await caches.open(cacheName);
  if(cacheFirst){const hit=await cache.match(request);if(hit)return hit;}
  try{const res=await fetch(request,{cache:'no-store'});if(res.ok||res.type==='opaque')await cache.put(request,res.clone());return res;}
  catch(err){const hit=await cache.match(request);if(hit)return hit;throw err;}
}
// Android installed-PWA Web Share Target: intercept a multipart POST entirely
// in this service worker. GitHub Pages cannot handle server-side POST, but the
// installed PWA service worker can store the shared File in local IndexedDB
// before redirecting into its own editor. The tab deletes the File on import.
const INBOX_DB='halalframe-shared-media-v1',INBOX_STORE='inbox';
function openInboxDB(){return new Promise((resolve,reject)=>{
  const req=indexedDB.open(INBOX_DB,1);
  req.onupgradeneeded=()=>{if(!req.result.objectStoreNames.contains(INBOX_STORE))req.result.createObjectStore(INBOX_STORE);};
  req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error||new Error('Share storage failed'));
});}
async function putSharedFile(file){
  const id=self.crypto.randomUUID();
  const db=await openInboxDB();
  try{await new Promise((resolve,reject)=>{
    const tx=db.transaction(INBOX_STORE,'readwrite');
    tx.objectStore(INBOX_STORE).put({blob:file,name:file.name||'shared-media',type:file.type,lastModified:file.lastModified||Date.now(),at:Date.now()},id);
    tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
  });}finally{db.close();}
  return id;
}
function guessMediaType(file){
  if(/^(image|video)\//i.test(file.type||''))return true;
  return /\.(?:mp4|mov|webm|m4v|jpg|jpeg|png|webp|gif)$/i.test(file.name||'');
}
async function handleSharePost(request){
  const redirect=(query)=>Response.redirect(new URL(`./?${query}`,ROOT),303);
  try{
    const body=await request.formData();
    const files=body.getAll('media');
    const file=files.find(item=>typeof item==='object'&&typeof item.arrayBuffer==='function'&&guessMediaType(item));
    if(!file)return redirect('share-error=no-file');
    const id=await putSharedFile(file);
    return redirect(`shared=${encodeURIComponent(id)}`);
  }catch(error){console.warn('Local share import failed',error);return redirect('share-error=storage');}
}
self.addEventListener('fetch',e=>{
  const url=new URL(e.request.url);
  if(e.request.method==='POST' && url.origin===ROOT.origin &&
      url.pathname.replace(/\/$/,'')===new URL('share-target',ROOT).pathname){
    e.respondWith(handleSharePost(e.request));return;
  }
  if(e.request.method!=='GET')return;
  if(url.origin===ROOT.origin&&url.pathname.startsWith(ROOT.pathname)){
    e.respondWith(cachedNetworkFirst(e.request,SHELL));return;
  }
  if(AUDIO_WEIGHTS.includes(e.request.url)||MUSIC_CHECK_ASSETS.includes(e.request.url)||e.request.url===DEMUCS_MODEL){
    e.respondWith(aiResponse(e.request,true,AUDIO));return;
  }
  if(url.origin==='https://cdn.jsdelivr.net'&&url.pathname.includes('onnxruntime-web@1.22.0/dist/')){
    e.respondWith(aiResponse(e.request,true,AUDIO));return;
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
