// HalalFrame v1.12 regression tests (node --test tests/regression/)
import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.document??={createElement:()=>({getContext:()=>({}),width:0,height:0})};
const {tileLayout,mergeDetections}=await import('../js/engine/ai.js');
const {ByteTrack}=await import('../js/engine/bytetrack.js');
const {instanceExtent,coverRect,addTargetPersonPixels}=await import('../js/engine/segmentation.js');
const {summariseGender,femaleProbability}=await import('../js/engine/gender.js');

test('16:9 frames use 3 overlapping square tiles; square frames none',()=>{
  const t=tileLayout(1920,1080);assert.equal(t.length,3);
  for(const x of t){assert.ok(Math.abs(x.w-1080/1920)<1e-9);assert.equal(x.h,1);}
  assert.ok(Math.abs(t.at(-1).x+t.at(-1).w-1)<1e-9,'last tile reaches the right edge');
  assert.equal(tileLayout(1000,1000).length,0);
  const p=tileLayout(720,1280);assert.equal(p.length,3);assert.equal(p[0].w,1);
});
test('tile + whole-frame duplicates merge to the larger extent',()=>{
  const m=mergeDetections([{x:.30,y:.20,w:.10,h:.50,confidence:.9,pass:'full'},{x:.29,y:.18,w:.12,h:.54,confidence:.3,pass:'tile0'},{x:.70,y:.2,w:.1,h:.5,confidence:.8,pass:'full'}]);
  assert.equal(m.length,2);
  const a=m.find(b=>b.x<.5);assert.ok(a.y<=.18+1e-9&&a.y+a.h>=.72-1e-9&&a.x<=.29+1e-9&&a.x+a.w>=.41-1e-9);
});
test('two overlapping people from the same pass are never merged',()=>{
  const m=mergeDetections([{x:.10,y:.2,w:.30,h:.6,confidence:.9,pass:'full'},{x:.20,y:.2,w:.30,h:.6,confidence:.8,pass:'full'}]);
  assert.equal(m.length,2);
});
test('shoulder-to-shoulder people seen by different passes stay separate',()=>{
  const m=mergeDetections([{x:.10,y:.2,w:.30,h:.6,confidence:.9,pass:'full'},{x:.20,y:.2,w:.30,h:.6,confidence:.8,pass:'tile1'}]);
  assert.equal(m.length,2,'centres 0.10 apart (> 1/4 width) are different people');
});
test('close-up subject is not capped to 20% of the frame',()=>{
  const W=720,H=1280,bt=new ByteTrack({width:W,height:H,fps:12,minHits:1});
  for(let f=0;f<10;f++)bt.update([{x:.01,y:.18,w:.98,h:.81,confidence:.92}],f);
  const tr=bt.tracks[0];assert.ok(tr.box.w*tr.box.h>.7*W*H,`area ${tr.box.w*tr.box.h/(W*H)}`);
});
test('mid-confidence walker starts a track (birth >= 0.30)',()=>{
  const bt=new ByteTrack({width:768,height:432,fps:12,minHits:4});
  for(let f=0;f<8;f++)bt.update([{x:(200+f*6)/768,y:150/432,w:100/768,h:220/432,confidence:.34}],f);
  assert.equal(bt.results({minHits:4}).length,1);
});
test('instance extent uses the pose mask, not only landmarks',()=>{
  const W=100,H=100,data=new Float32Array(W*H);
  for(let y=10;y<99;y++)for(let x=20;x<80;x++)data[y*W+x]=.9;
  const e=instanceExtent({box:{x:.4,y:.3,w:.2,h:.2},landmarks:[{x:.5,y:.4,visibility:1}],mask:{width:W,height:H,data}});
  assert.ok(e.x<=.21&&e.x+e.w>=.79&&e.y<=.11&&e.y+e.h>=.98);
});
test('isolated stray mask pixels do not inflate the extent (GPT P1-5)',()=>{
  const W=100,H=100,data=new Float32Array(W*H);
  for(let y=40;y<80;y++)for(let x=40;x<60;x++)data[y*W+x]=.9;
  for(let y=2;y<5;y++)for(let x=90;x<95;x++)data[y*W+x]=.9; // far-away blob
  const e=instanceExtent({box:{x:.42,y:.42,w:.16,h:.36},landmarks:[{x:.5,y:.5,visibility:1}],mask:{width:W,height:H,data}});
  assert.ok(e.x+e.w<.7&&e.y>.3,JSON.stringify(e));
});
test('cover rectangle never shrinks below the legacy track rectangle',()=>{
  const c={shape:'outline',padding:.15},b={x:.3,y:.2,w:.2,h:.3};
  const r=coverRect(b,b,c,1000,1000);assert.ok(r.x<=300&&r.y<=200&&r.x+r.w>=500&&r.y+r.h>=500);
});
test('person pixels are not taken from a competing person',()=>{
  const n=4,mask=new Uint8Array(n*n),cat=new Uint8Array(n*n).fill(4),other=new Uint8Array(n*n);other[0]=255;
  const out=addTargetPersonPixels(mask,cat,{x:0,y:0,w:4,h:4},4,4,{x:0,y:0,w:1,h:1},[other]);
  assert.equal(out[0],0);assert.equal(out[5],255);
});
test('gender: unclear stays covered, men need several strong unanimous faces',()=>{
  assert.equal(summariseGender([.585,.76,.78]).label,'woman');
  assert.equal(summariseGender([.33,.33]).label,'unknown','two weak male samples are NOT enough (GPT review P0-1)');
  assert.equal(summariseGender([.05,.06]).label,'unknown','two samples are not enough for video');
  assert.equal(summariseGender([.05,.06,.1]).label,'man');
  assert.equal(summariseGender([.05,.06,.1,.6]).label,'unknown','any non-male sample keeps them covered');
  assert.equal(summariseGender([.1],{minManSamples:1}).label,'man');
  assert.equal(summariseGender([]).label,'unknown');
  assert.equal(femaleProbability({gender:'female',genderScore:1}),1);
});
