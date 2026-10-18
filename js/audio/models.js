// Pinned, public, MIT-licensed weights. Downloads are never performed without
// a user click. The actual media stays in the tab/worker and is never uploaded.
export const ORT_VERSION='1.22.0';
export const ORT_BASE=`https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
export const VAD_URL='https://raw.githubusercontent.com/snakers4/silero-vad/60b7ffa243625ebdc1070275a29f18c87843786a/src/silero_vad/data/silero_vad.onnx';
const REV='8cc4418db60d96e501f42889370b8bf3eb6df2d2';
const ROOT=`https://huggingface.co/Politrees/UVR_resources/resolve/${REV}/models/MDXNet/`;
export const MODELS={
  quick:{name:'Quick · MDX-Net 9482',url:ROOT+'UVR_MDXNET_9482.onnx',size:29704436,sha256:'f4f365207c56deb115bceedff3ad8fe98a751c745f9e370cecec6226b8b47184',nfft:4096,dimF:2048,hop:1024,dimT:256,compensation:1},
  best:{name:'Best · MDX-Net Voc FT',url:ROOT+'UVR-MDX-NET-Voc_FT.onnx',size:66762490,sha256:'534b2070fcc7df514b13ef660dc8bb328679c2374d04354a5c42bb14ecce111',nfft:6144,dimF:3072,hop:1024,dimT:256,compensation:1}
};
export const AUDIO_MODEL_URLS=[VAD_URL,MODELS.quick.url,MODELS.best.url];
export const displayMB=bytes=>(bytes/1024/1024).toFixed(1)+' MB';

// Optional advanced separation: the 181 MB HTDemucs ONNX export is not shipped
// in the ZIP. Compatibility and model-weight rights must be reviewed before
// advertising this as a production-grade music-free guarantee.
export const DEMUCS={
 name:'Studio · HTDemucs v4',
 url:'https://huggingface.co/timcsy/demucs-web-onnx/resolve/92e33df/htdemucs_embedded.onnx',
 size:180534758,
 sha256:'e5e425c17683f163a472462eb5f5a4ffcd11c31858d57fbd0833b012d8b88077',
 packageUrl:'https://esm.sh/demucs-web@1.0.2?bundle'
};
