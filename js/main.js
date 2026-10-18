import {createProject,newConcealment,addPoint,boxAt,clamp,clone,History,seconds,saveProject,loadSavedProject,clearSavedProject,migrateProjectEffects} from './state.js';
import {renderFrame} from './engine/render.js';
import {MaskCache} from './engine/segmentation.js';
import {appearanceSignature,iou} from './engine/identity.js';
import {PersonAI,nearestPerson} from './engine/ai.js';
import {seekFrame,trackDirection,findAllPeople,personThumbnail} from './engine/tracker.js';
import {exportPhoto,downloadBlob,exportVideo,estimateSize,shareBlob} from './engine/export.js';
import {CanvasInput} from './ui/canvas-input.js';
import {Timeline} from './ui/timeline.js';
import {activeAt} from './state.js';
import {initFirstRun,initExportReview} from './ui/first-run.js';
import {takeSharedFile} from './ui/share-target.js';
import {AudioPanel} from './ui/audio-panel.js';
const $=id=>document.getElementById(id);
let project=null,media=null,kind='video',sourceURL=null,selectedId=null,tool='select',draft=null;
let busyController=null,reviewResolve=null,fixResolve=null,aiBoxes=[],trackingActive=false,scanResults=[];
let lastFrameRendered=-1,toastTimer=null,saveTimer=null,frameCounter=0,fpsWindowStart=performance.now(),measuredFPS=0;
let exportResult=null,sourceFile=null;const requestExportReview=initExportReview();const maskCache=new MaskCache();const maskTasks=new Set();
let temporaryReveal=false;let seekPending=null,seekRunning=false;let frameTimes=[],lastMeasuredMediaTime=null;const FPS_VALUES=[24,25,30,50,60];
let hiddenVideo=$('source-video'),canvas=$('preview'),ctx=canvas.getContext('2d',{alpha:false});
const history=new History();
const ai=new PersonAI({onStatus:s=>{$('ai-status').textContent=s;}});
const audioPanel=new AudioPanel({getFile:()=>sourceFile,getVideo:()=>hiddenVideo,getTime:()=>currentTime(),toast,onChange:()=>{if(project){exportResult=null;$('export-result').classList.add('hidden');refreshEstimate();}}});
function toast(msg){const el=$('toast');el.textContent=msg;el.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('show'),3600);}
function currentTime(){return kind==='photo'?0:(hiddenVideo.currentTime||0);}
function selected(){return project?.concealments.find(x=>x.id===selectedId)||null;}
function dims(source){return {width:source.videoWidth||source.naturalWidth||source.width||640,height:source.videoHeight||source.naturalHeight||source.height||360};}
function maskKey(c,t){return `${c.id}:${Math.round(t*project.video.fps)}:${c.shape}`;}
function requestMasks(t){
  if(!project||!media||maskTasks.size>0)return;
  const pending=activeAt(project,t).filter(c=>c.shape!=='box'&&!maskCache.get(c,Math.round(t*project.video.fps)));
  if(!pending.length)return;
  const key=maskKey(pending[0],t);maskTasks.add(key);
  maskCache.ensureActive({source:media,project,time:t,ai}).then(()=>{
    if(project&&Math.abs(t-currentTime())<Math.max(.035,1/project.video.fps))render();
  }).catch(err=>{$('ai-status').textContent='Precise mask failed; using full box: '+err.message;})
    .finally(()=>maskTasks.delete(key));
}
function render(){
  frameCounter++;const now=performance.now();if(now-fpsWindowStart>1000){measuredFPS=Math.round(frameCounter*1000/(now-fpsWindowStart));frameCounter=0;fpsWindowStart=now;}
  if(!media||!project)return;
  if(kind==='video'&&hiddenVideo.readyState<2)return;
  const t=currentTime();
  const displayed=temporaryReveal&&fixResolve?{...project,concealments:project.concealments.filter(c=>c.id!==selectedId)}:project;
  renderFrame(ctx,media,displayed,t,{debug:$('debug').checked,detections:aiBoxes,draft,maskCache,previewMask:$('preview-mask').checked});
  if(!temporaryReveal)requestMasks(t);
  $('time-display').textContent=kind==='photo'?'PHOTO':`${seconds(t)} / ${seconds(project.video.duration)}`;
  timeline.setPlayhead(t);
  $('play').textContent=hiddenVideo.paused?'▶':'❚❚';
  if($('debug').checked){
    ctx.save();ctx.fillStyle='#b8f451';ctx.font='12px monospace';ctx.fillText(`frame ${Math.round(t*project.video.fps)} · ${measuredFPS}fps · D:${ai.delegate} S:${ai.segmentDelegate} · ${maskCache.size} masks`,10,Math.max(18,canvas.height-12));ctx.restore();
  }
}
function cycle(){if(kind==='video'&&media&&project&&(!hiddenVideo.paused||trackingActive))render();requestAnimationFrame(cycle);}
function refresh({renderOnly=false}={}){
  render();if(renderOnly)return;
  timeline.update(project,selectedId,currentTime());
  const c=selected(),has=!!c;
  $('selection-panel').classList.toggle('hidden',!has);$('no-selection').classList.toggle('hidden',has);
  for(const id of ['delete-mask','track-forward','track-backward','whole-video'])$(id).disabled=!has || (id.startsWith('track')&&kind==='photo');
  $('undo').disabled=!history.canUndo;$('redo').disabled=!history.canRedo;
  if(c){
    $('mask-enabled').checked=c.enabled!==false;
    $('mask-label').value=c.label;$('effect').value=c.effect;$('shape').value=c.shape;
    $('strength').value=c.strength;$('padding').value=Math.round(c.padding*100);$('padding-label').textContent=Math.round(c.padding*100)+'%';
    $('start-time').value=c.startTime.toFixed(2);$('end-time').value=c.endTime.toFixed(2);
    $('feather').value=c.feather||0;$('feather-label').textContent=(c.feather||0)+'px';
    $('safety-margin').value=c.safetyMargin??8;$('safety-label').textContent=(c.safetyMargin??8)+'px';
    $('include-face').checked=!!c.includeFace;$('whole-frame').checked=!!c.wholeFrame;
  }
}
function snapshot(){if(!project)return;maskCache.clear();history.record(project);refresh();scheduleSave();}
// Deletes and Clear must be durable before another deferred autosave can run.
async function persistNow(){clearTimeout(saveTimer);if(!project)return false;try{await saveProject(project);return true;}catch(e){toast('Could not save edits: '+e.message);return false;}}
async function chooseSavedProject(saved){
  $('restore-description').textContent=`${saved.project.concealments.length} saved region(s) were found for this video. Restore them, or start fresh with a clean timeline.`;
  $('restore-modal').classList.remove('hidden');
  return await new Promise(resolve=>{
    $('restore-yes').onclick=()=>{$('restore-modal').classList.add('hidden');resolve(true);};
    $('restore-fresh').onclick=()=>{$('restore-modal').classList.add('hidden');resolve(false);};
  });
}
async function clearProject(){
  if(!project||busyController)return;
  $('clear-changes-modal').classList.remove('hidden');
}
async function confirmClearProject(){
  $('clear-changes-modal').classList.add('hidden');if(!project||busyController)return;
  clearTimeout(saveTimer);
  const before=clone(project);
  project=createProject(project.video);
  // Exactly one-step undo: restore the complete pre-clear editing session.
  history.reset(before);history.record(project);
  selectedId=null;scanResults=[];aiBoxes=[];maskCache.clear();ai.resetCache();exportResult=null;
  $('export-result').classList.add('hidden');
  try{await clearSavedProject();toast('All concealments removed. Press Undo to restore the previous edits.');}
  catch(e){toast('Could not clear the saved project: '+e.message);}
  refresh();
}
$('clear-changes-cancel').onclick=()=>$('clear-changes-modal').classList.add('hidden');
$('clear-changes-yes').onclick=confirmClearProject;

function scheduleSave(){clearTimeout(saveTimer);saveTimer=setTimeout(()=>saveProject(project).catch(()=>{}),500);}
function updateDirect(fn,{save=false,refreshUI=true}={}){if(!project)return;fn();if(save)snapshot();else if(refreshUI)refresh();else render();}
function selectMask(id){selectedId=id;refresh();}
function setTool(mode){tool=mode;input.setMode(mode==='key'?'draw':mode==='draw'?'draw':'select');
  ['select','draw','key','exclude'].forEach(n=>$(`mode-${n}`).classList.toggle('selected',n===mode));
  $('mode-help').textContent={select:'Tap a person on the paused video. The local AI will suggest a body box.',draw:'Drag directly on the paused video to create a new time-limited region. Drawing does not move the playhead.',key:'Select a region, scrub to a new time, then draw its updated location. The region moves smoothly between keyframes.',exclude:'Tap someone you do NOT want concealed. The app will track their position and exclude them from unrelated masks.'}[mode];
  hiddenVideo.pause();
}
async function openFile(file){
  if(!file)return;
  if(!/^image\//.test(file.type)&&!/^video\//.test(file.type)){toast('Choose an image or video');return;}
  clearTimeout(saveTimer);busyController?.abort();if(reviewResolve){reviewResolve({action:'end'});reviewResolve=null;}
  if(sourceURL)URL.revokeObjectURL(sourceURL);
  sourceURL=URL.createObjectURL(file);kind=file.type.startsWith('image/')?'photo':'video';
  ai.resetCache();maskCache.clear();aiBoxes=[];selectedId=null;hiddenVideo.pause();
  $('file-input').value='';
  $('filename').textContent=file.name;
  let info;
  try{
    if(kind==='photo'){
      const img=new Image();img.src=sourceURL;await img.decode();media=img;
      info={duration:0,fps:1,width:img.naturalWidth,height:img.naturalHeight,fileName:file.name,fileSize:file.size,fileLastModified:file.lastModified};
    } else {
      media=hiddenVideo;hiddenVideo.src=sourceURL;hiddenVideo.load();
      await new Promise((resolve,reject)=>{
        if(hiddenVideo.readyState>=2){resolve();return;}
        const timer=setTimeout(()=>reject(new Error('Video metadata timed out')),18000);
        const ok=()=>{clearTimeout(timer);hiddenVideo.removeEventListener('error',bad);resolve();};
        const bad=()=>{clearTimeout(timer);hiddenVideo.removeEventListener('loadeddata',ok);reject(new Error('Video could not be decoded by this browser'));};
        hiddenVideo.addEventListener('loadeddata',ok,{once:true});hiddenVideo.addEventListener('error',bad,{once:true});
      });
      const d=dims(hiddenVideo);
      info={duration:Number(hiddenVideo.duration)||0,fps:30,width:d.width,height:d.height,fileName:file.name,fileSize:file.size,fileLastModified:file.lastModified};
      if(!Number.isFinite(info.duration)||info.duration<=0)throw new Error('The video duration is not available. Try an MP4 file.');
      if(info.duration>180)toast('Videos over 3 minutes may be slow or use substantial memory.');
    }
    project=createProject(info);sourceFile=file;exportResult=null;$('export-result').classList.add('hidden');audioPanel.reset(kind==='video');
    const saved=await loadSavedProject().catch(()=>null);
    const old=saved?.project?.video;
    const isSameVideo=old?.fileName===file.name&&old?.fileSize===file.size&&old?.width===info.width&&old?.height===info.height&&
      (!old.fileLastModified||old.fileLastModified===file.lastModified);
    if(isSameVideo&&saved.project.concealments?.length){
      if(await chooseSavedProject(saved)){
        project=clone(saved.project);project.video.duration=info.duration;
      }else{
        // Don't leave an older draft behind when the user explicitly starts fresh.
        await clearSavedProject();
      }
    }
    const migrated=migrateProjectEffects(project);
    if(migrated.changed&&isSameVideo)await saveProject(project).catch(()=>{});
    history.reset(project);
    canvas.width=Math.min(960,info.width);canvas.height=Math.max(1,Math.round(canvas.width*info.height/info.width));
    canvas.style.width='auto';canvas.style.height='auto';$('preview').parentElement.style.aspectRatio=`${info.width}/${info.height}`;
    $('viewer-empty').classList.add('hidden');$('editor').classList.remove('hidden');
    $('upload-panel').classList.add('hidden');$('new-file').classList.remove('hidden');
    $('media-details').textContent=`${info.width} × ${info.height} · ${kind==='photo'?'Still photo':seconds(info.duration)} · ${(file.size/1024/1024).toFixed(1)} MB`;
    $('fps-controls').classList.toggle('hidden',kind==='photo');$('fps-input').value='auto';$('tracking-accuracy').value=info.duration<30?'best':'fast';frameTimes=[];lastMeasuredMediaTime=null;
    $('timeline-card').classList.toggle('hidden',kind==='photo');
    $('video-export').classList.toggle('hidden',kind==='photo');$('photo-export').classList.toggle('hidden',kind!=='photo');
    $('audio-toggle').disabled=kind==='photo';hiddenVideo.muted=false;$('audio-toggle').textContent='🔊';
    $('play').disabled=kind==='photo';for(const id of ['back-sec','back-frame','next-frame','next-sec','scrubber'])$(id).disabled=kind==='photo';
    refreshEstimate();setTool('select');refresh();$('editor').scrollIntoView({behavior:'smooth',block:'start'});
    toast('File opened locally. Nothing uploaded.');
  }catch(e){toast('Unable to open: '+e.message);console.error(e);}
}
function onDraw(box){
  if(fixResolve){const fix=fixResolve;fixResolve=null;temporaryReveal=false;$('temporary-reveal').classList.add('hidden');setTool('select');fix(box);return;}
  if(!project)return;
  hiddenVideo.pause();const t=currentTime();
  if(tool==='key'){
    const c=selected();if(!c){toast('Select a region first, then draw the new position.');return;}
    addPoint(c,t,box,'manual');c.startTime=Math.min(c.startTime,t);c.endTime=Math.max(c.endTime,t);
    toast('Position keyframe saved at '+seconds(t));
  }else{
    const c=newConcealment(project,box,t,{label:`Region ${project.concealments.length+1}`});
    project.concealments.push(c);selectedId=c.id;toast(`Region saved from ${seconds(c.startTime)} to ${seconds(c.endTime)}.`);
  }
  snapshot();
}
async function excludeTappedPerson(x,y){
  if(!project||busyController)return;
  hiddenVideo.pause();const when=currentTime();
  const controller=beginBusy('Identifying excluded person','Tracking the person you want left visible.');
  try{
    const boxes=await ai.detect(media,when,project.video.fps),picked=nearestPerson(boxes,x,y);
    if(!picked)throw new Error('No person found at that point. Try another frame.');
    let matching=null;
    if(kind==='video'){
      const tracks=scanResults.length?scanResults:await findAllPeople({video:hiddenVideo,project,ai,accuracy:$('tracking-accuracy').value,signal:controller.signal,onProgress:(p,t)=>progress(p,`${Math.round(100*p)}% · ${seconds(t)}`)});
      matching=tracks.map(tr=>({tr,overlap:iou(boxAt(tr,when)||tr.track[0],picked)})).sort((a,b)=>b.overlap-a.overlap)[0];
    }
    const region=matching?.overlap>.10?matching.tr:newConcealment(project,picked,when,{label:'Do not cover',source:'manual'});
    const exception={id:`exclude-${crypto.randomUUID()}`,label:'Don’t cover this person',track:clone(region.track),startTime:kind==='photo'?0:region.startTime,endTime:kind==='photo'?0:region.endTime};
    project.exclusions??=[];project.exclusions.push(exception);
    // Do not simultaneously conceal a near-identical track selected earlier.
    for(const c of project.concealments){if(iou(boxAt(c,when)||c.track[0],picked)>.50)c.enabled=false;}
    snapshot();toast('Person marked “Don’t cover”. The other masks will avoid them when separate.');
  }catch(error){if(error.name!=='AbortError')toast('Could not exclude person: '+error.message);}
  finally{endBusy();setTool('select');}
}
async function onTap(x,y){
  if(fixResolve){const b={x:clamp(x-.09,0,.99),y:clamp(y-.14,0,.99),w:.18,h:.28};onDraw(b);return;}
  if(tool==='key'){toast('Draw a rectangle for the new keyframe.');return;}
  if(tool==='draw'){toast('Drag to draw a rectangle, not just tap.');return;}
  if(!project||busyController){toast('Finish the current operation first.');return;}
  if(tool==='exclude'){await excludeTappedPerson(x,y);return;}
  hiddenVideo.pause();
  try{
    const controller=beginBusy('Detecting people','The model runs locally after downloading.');
    aiBoxes=await ai.detect(media,currentTime(),project.video.fps);
    if(controller.signal.aborted)throw new DOMException('Cancelled','AbortError');
    render();
    const b=nearestPerson(aiBoxes,x,y);
    if(!b){toast('No person found at this frame. Use Draw new box.');return;}
    const c=newConcealment(project,b,currentTime(),{label:`Person ${project.concealments.filter(c=>c.label.startsWith('Person')).length+1}`,source:'ai'});
    c.track[0].confidence=b.confidence;c.identitySignature=appearanceSignature(media,b);c.precisionCritical=true;c.thumbnail=personThumbnail(media,b);
    project.concealments.push(c);selectedId=c.id;snapshot();toast(`${c.label} selected. Press Track → to follow them.`);
  }catch(e){if(e.name==='AbortError')toast('AI selection cancelled.');else{console.error(e);toast('AI unavailable: '+e.message+'. Manual drawing still works.');}}
  finally{endBusy();}
}
const input=new CanvasInput(canvas,{onDraw,onTap,onDraft:b=>{draft=b;render();}});
const timeline=new Timeline({slider:$('scrubber'),lanes:$('timeline-lanes'),onSeek:seekTo,onSelect:selectMask,
  onRange:(id,edge,t)=>{const c=project.concealments.find(x=>x.id===id);if(!c)return;if(edge==='start')c.startTime=clamp(t,0,c.endTime);else c.endTime=clamp(t,c.startTime,project.video.duration);refresh({renderOnly:true});},
  onCommit:()=>snapshot(),onMenu:(id,rect)=>{selectMask(id);const menu=$('mask-menu');menu.style.left=`${Math.min(window.innerWidth-170,rect.left)}px`;menu.style.top=`${Math.min(window.innerHeight-100,rect.bottom+4)}px`;menu.classList.remove('hidden');}
});
async function seekTo(time){
  if(kind==='photo'||!project||trackingActive)return;hiddenVideo.pause();
  seekPending=clamp(time,0,project.video.duration);if(seekRunning)return;
  seekRunning=true;try{while(seekPending!==null){const goal=seekPending;seekPending=null;await seekFrame(hiddenVideo,goal);if(seekPending===null)render();}}
  catch(e){toast(e.message);}finally{seekRunning=false;render();}
}
function beginBusy(title,subtitle){busyController=new AbortController();$('busy').classList.remove('hidden');$('busy-title').textContent=title;$('busy-copy').textContent=subtitle;$('busy-progress').style.width='0%';return busyController;}
function progress(p,text){$('busy-progress').style.width=(clamp(p,0,1)*100).toFixed(1)+'%';if(text)$('busy-copy').textContent=text;}
function endBusy(){busyController=null;$('busy').classList.add('hidden');}
function abortAll(){temporaryReveal=false;$('temporary-reveal').classList.add('hidden');busyController?.abort();if(reviewResolve){reviewResolve({action:'end'});reviewResolve=null;hideReview();}if(fixResolve){fixResolve(null);fixResolve=null;}}
function hideReview(){$('review-modal').classList.add('hidden');}
async function askTracking({time,reason,detections,proposed,direction,expectedThumb,candidateThumb}){
  $('busy').classList.add('hidden');
  $('review-modal').classList.remove('hidden');$('review-description').textContent=`At ${seconds(time)}: ${reason}. Confirm, adjust, or stop. The previous region remains covered until you choose.`;
  const thumbs=$('review-identity-thumbs');if(thumbs){thumbs.classList.toggle('hidden',!expectedThumb&&!candidateThumb);
    if(expectedThumb)$('review-target-thumb').src=expectedThumb;
    if(candidateThumb)$('review-candidate-thumb').src=candidateThumb;
  }
  try{$('review-shot').src=canvas.toDataURL('image/jpeg',.7);}catch{$('review-shot').removeAttribute('src');}
  const action=await new Promise(resolve=>{reviewResolve=resolve;});
  reviewResolve=null;hideReview();
  if(action.action==='fix'){
    toast('Draw a new box. You may temporarily reveal the original if you need to locate the subject.');
    temporaryReveal=false;$('temporary-reveal').classList.remove('hidden');setTool('draw');
    const box=await new Promise(resolve=>{fixResolve=resolve;});
    fixResolve=null;temporaryReveal=false;$('temporary-reveal').classList.add('hidden');
    if(box){setTool('select');$('busy').classList.remove('hidden');return {action:'fix',box};}
    return {action:'end'};
  }
  $('busy').classList.remove('hidden');return action;
}
async function runTracking(direction){
  const c=selected();if(!c||kind!=='video'||busyController)return;
  const controller=beginBusy(direction>0?'Tracking forwards…':'Tracking backwards…','Analysing frames locally. Tap Cancel to stop.');
  trackingActive=true;hiddenVideo.pause();
  try{
    await ai.init();
    await trackDirection({video:hiddenVideo,project,concealment:c,ai,direction,checkEvery:Number($('check-interval').value),accuracy:$('tracking-accuracy').value,signal:controller.signal,
      onProgress:(p,t)=>progress(p,`${Math.round(p*100)}% · ${seconds(t)} · ${c.track.length} positions`),
      onFrame:(t,boxes)=>{aiBoxes=boxes;render();},onReview:askTracking});
    toast(`Tracking completed: ${c.track.length} saved positions. Review before sharing.`);
  }catch(e){if(e.name==='AbortError')toast('Tracking cancelled; existing positions kept.');else{console.error(e);toast('Tracking stopped: '+e.message);}}
  finally{trackingActive=false;endBusy();snapshot();refresh();}
}
async function runScan(coverAll=false){
  if(!project||busyController)return;
  const controller=beginBusy('Scanning for people','Analysing frames on this device; larger clips take longer.');trackingActive=true;hiddenVideo.pause();
  try{
    await ai.init();
    if(kind==='photo'){
      const boxes=await ai.detect(media,0,project.video.fps);
      scanResults=boxes.map((b,i)=>({id:`person-${i+1}`,label:`Person ${i+1}`,thumbnail:personThumbnail(media,b),track:[{t:0,...b,source:'ai'}],startTime:0,endTime:0}));
    }else{
      scanResults=await findAllPeople({video:hiddenVideo,project,ai,accuracy:$('tracking-accuracy').value,signal:controller.signal,onProgress:(p,t,count)=>progress(p,`${Math.round(p*100)}% · ${seconds(t)} · ${count} tracks`) });
    }
    endBusy();render();
    if(coverAll){applyScan(scanResults);toast(`Added ${scanResults.length} person tracks. Review identity changes.`);}
    else showScan();
  }catch(e){if(e.name==='AbortError')toast('Scan cancelled.');else{console.error(e);toast('Scan failed: '+e.message);}}
  finally{trackingActive=false;endBusy();}
}
function showScan(){const list=$('scan-list');list.replaceChildren();$('scan-all').checked=true;
  if(!scanResults.length){const p=document.createElement('p');p.textContent='No people detected. You can still draw a selection manually.';list.append(p);}
  for(const tr of scanResults){const row=document.createElement('div');row.className='scan-person';
    const thumb=document.createElement('img');thumb.className='thumb';thumb.alt=tr.label+' at initial detection';thumb.src=tr.thumbnail;
    const info=document.createElement('div');const name=document.createElement('strong');name.textContent=tr.label;
    const sub=document.createElement('span');sub.className='dim';sub.textContent=`${seconds(tr.startTime)}–${seconds(tr.endTime)} · ${tr.track.length} positions`;info.append(name,sub);
    const group=document.createElement('div');group.className='choice-group';
    for(const [value,caption] of [['cover','Cover'],['exclude','Don’t cover'],['skip','Skip']]){
      const label=document.createElement('label'),input=document.createElement('input');input.type='radio';input.name='choice-'+tr.id;input.value=value;input.checked=value==='cover';label.append(input,document.createTextNode(caption));group.append(label);
    }
    info.append(group);row.append(thumb,info);list.append(row);
  }
  $('scan-modal').classList.remove('hidden');
}
function applyScan(tracks,excluded=[]){
  if(!project)return;
  for(const tr of tracks){const c=newConcealment(project,tr.track[0],tr.startTime,{label:`Person ${project.concealments.filter(c=>c.label.startsWith('Person')).length+1}`,source:'ai'});
    c.track=clone(tr.track);c.startTime=tr.startTime;c.endTime=tr.endTime;c.precisionCritical=true;c.identitySignature=tr.identitySignature||null;
    project.concealments.push(c);selectedId=c.id;
  }
  project.exclusions??=[];
  for(const tr of excluded)project.exclusions.push({id:`exclude-${crypto.randomUUID()}`,label:'Don’t cover '+tr.label,track:clone(tr.track),startTime:tr.startTime,endTime:tr.endTime});
  snapshot();$('scan-modal').classList.add('hidden');
}
function editSelection(field,value){const c=selected();if(!c)return;
  if(field==='effect'&&!['pixelate','blur'].includes(value))value='pixelate';
  if(field==='startTime')value=clamp(Number(value),0,c.endTime);
  if(field==='endTime')value=clamp(Number(value),c.startTime,project.video.duration);
  c[field]=value;snapshot();}
function duplicateMask(){const c=selected();if(!c)return;const newC=clone(c);newC.id=crypto.randomUUID();newC.label=`${c.label} copy`;project.concealments.push(newC);selectedId=newC.id;snapshot();}
function deleteMask(){const c=selected();if(!c)return;project.concealments=project.concealments.filter(x=>x.id!==c.id);selectedId=null;snapshot();void persistNow().then(ok=>{if(ok)toast('Region removed and saved.');});}
function restore(value){if(!value)return;maskCache.clear();project=value;migrateProjectEffects(project);if(!project.concealments.some(c=>c.id===selectedId))selectedId=null;refresh();scheduleSave();}
// Transport controls, UI, keyboard shortcuts
$('file-input').addEventListener('change',e=>openFile(e.target.files[0]));$('new-file').onclick=()=>$('file-input').click();$('clear-project').onclick=clearProject;
$('audio-toggle').onclick=()=>{hiddenVideo.muted=!hiddenVideo.muted;$('audio-toggle').textContent=hiddenVideo.muted?'🔇':'🔊';};
$('play').onclick=async()=>{if(kind!=='video'||!project)return;if(hiddenVideo.paused){try{await hiddenVideo.play();}catch(e){toast('Playback unavailable: '+e.message);}}else hiddenVideo.pause();render();};
for(const [id,dt] of [['back-sec',-1],['next-sec',1],['back-frame',-1/30],['next-frame',1/30]]){
  $(id).onclick=()=>seekTo(currentTime()+(id.includes('frame')?dt*30/Math.max(1,project.video.fps):dt));
}
hiddenVideo.addEventListener('seeked',render);hiddenVideo.addEventListener('pause',render);
hiddenVideo.addEventListener('ended',render);
// Estimate source FPS from decoded frame timestamps when the browser supports it.
// The user may override the estimate for variable-frame-rate or heavily dropped videos.
if(hiddenVideo.requestVideoFrameCallback){
  const observe=(_now,metadata)=>{
    if(project&&kind==='video'&&!hiddenVideo.paused&&!trackingActive&&$('fps-input').value==='auto'){
      if(lastMeasuredMediaTime!==null){const dt=metadata.mediaTime-lastMeasuredMediaTime;if(dt>0.009&&dt<0.18){frameTimes.push(dt);if(frameTimes.length>25)frameTimes.shift();}}
      lastMeasuredMediaTime=metadata.mediaTime;
      if(frameTimes.length>=7){
        const minInterval=Math.min(...frameTimes);
        const estimated=FPS_VALUES.reduce((best,n)=>Math.abs(1/n-minInterval)<Math.abs(1/best-minInterval)?n:best,30);
        if(project.video.fps!==estimated){project.video.fps=estimated;ai.resetCache();refresh();}
      }
    }
    hiddenVideo.requestVideoFrameCallback(observe);
  };hiddenVideo.requestVideoFrameCallback(observe);
}
$('fps-input').addEventListener('change',e=>{if(!project)return;
  project.video.fps=e.target.value==='auto'?30:Number(e.target.value);
  frameTimes=[];lastMeasuredMediaTime=null;ai.resetCache();snapshot();
});
$('mode-select').onclick=()=>setTool('select');$('mode-draw').onclick=()=>setTool('draw');$('mode-key').onclick=()=>setTool('key');$('mode-exclude').onclick=()=>setTool('exclude');
$('find-people').onclick=()=>runScan(false);$('cover-everyone').onclick=()=>runScan(true);
$('track-forward').onclick=()=>runTracking(1);$('track-backward').onclick=()=>runTracking(-1);
$('cancel-task').onclick=abortAll;
$('temporary-reveal').onclick=()=>{temporaryReveal=!temporaryReveal;$('temporary-reveal').classList.toggle('active',temporaryReveal);$('temporary-reveal').textContent=temporaryReveal?'Hide original again':'Temporarily show original';render();};
for(const [id,action] of [['review-continue','continue'],['review-fix','fix'],['review-end','end'],['review-skip','skip']]){
  $(id).onclick=()=>{if(reviewResolve)reviewResolve({action});};
}
$('scan-all').onchange=e=>{if(e.target.checked)for(const cb of $('scan-list').querySelectorAll('input[type=radio][value=cover]'))cb.checked=true;};
$('scan-apply').onclick=()=>{
  const covered=[],excluded=[];
  for(const tr of scanResults){const choice=$('scan-list').querySelector(`[name="choice-${tr.id}"]:checked`)?.value||'skip';
    if(choice==='cover')covered.push(tr);else if(choice==='exclude')excluded.push(tr);
  }
  applyScan(covered,excluded);
};
$('scan-close').onclick=()=>$('scan-modal').classList.add('hidden');
$('delete-mask').onclick=deleteMask;$('mask-duplicate').onclick=()=>{duplicateMask();$('mask-menu').classList.add('hidden');};$('mask-delete-menu').onclick=()=>{deleteMask();$('mask-menu').classList.add('hidden');};
document.addEventListener('pointerdown',e=>{if(!$('mask-menu').classList.contains('hidden')&&!$('mask-menu').contains(e.target))$('mask-menu').classList.add('hidden');});
$('mask-enabled').onchange=e=>editSelection('enabled',e.target.checked);
$('mask-label').onchange=e=>editSelection('label',e.target.value.trim()||'Region');
$('effect').onchange=e=>editSelection('effect',e.target.value);
$('shape').onchange=e=>editSelection('shape',e.target.value);
$('strength').oninput=e=>{if(selected())selected().strength=Number(e.target.value);render();};$('strength').onchange=()=>snapshot();
$('padding').oninput=e=>{if(selected())selected().padding=Number(e.target.value)/100;$('padding-label').textContent=e.target.value+'%';render();};$('padding').onchange=()=>snapshot();
for(const [field,input,label] of [['feather','feather','feather-label'],['safetyMargin','safety-margin','safety-label']]){
  $(input).oninput=e=>{if(!selected())return;selected()[field]=Number(e.target.value);$(label).textContent=e.target.value+'px';maskCache.clear();render();};
  $(input).onchange=()=>snapshot();
}
$('include-face').onchange=e=>{if(!selected())return;selected().includeFace=e.target.checked;snapshot();};
$('preview-mask').onchange=()=>render();

$('start-time').onchange=e=>editSelection('startTime',e.target.value);$('end-time').onchange=e=>editSelection('endTime',e.target.value);
$('whole-video').onclick=()=>{const c=selected();if(!c)return;c.startTime=0;c.endTime=project.video.duration;snapshot();toast('Whole-video time range applied.');};
$('whole-frame').onchange=e=>{const c=selected();if(!c)return;c.wholeFrame=e.target.checked;snapshot();toast(c.wholeFrame?'Entire frame selected intentionally.':'Region-only masking restored.');};
$('undo').onclick=()=>restore(history.undo());$('redo').onclick=()=>restore(history.redo());
$('debug').onchange=()=>{$('self-check-tools').classList.toggle('hidden',!$('debug').checked);render();};
async function performPhotoExport(type){
  if(kind!=='photo'||!project||busyController)return;
  beginBusy('Exporting photo','Applying masks…');
  try{
    const blob=await exportPhoto(media,project,{type,quality:.88,maskCache,ai});
    downloadBlob(blob,`${project.video.fileName.replace(/\.[^.]+$/,'')}-halalframe.${type==='image/png'?'png':'jpg'}`);
  }catch(e){toast('Photo export failed: '+e.message);}finally{endBusy();}
}
$('jpg-export').onclick=()=>{if(kind==='photo')requestExportReview(()=>performPhotoExport('image/jpeg'));};
$('png-export').onclick=()=>{if(kind==='photo')requestExportReview(()=>performPhotoExport('image/png'));};
$('about-open').onclick=()=>showInfo('about');$('ruling-open').onclick=()=>showInfo('ruling');$('help-btn').onclick=()=>showInfo('help');$('info-close').onclick=()=>$('info-modal').classList.add('hidden');
$('social-media-help').onclick=()=>showInfo('social');$('footer-social-help').onclick=()=>showInfo('social');
$('footer-disclaimer').onclick=()=>firstRun.showDisclaimer();
let installEvent=null;
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();installEvent=e;});
window.addEventListener('appinstalled',()=>{installEvent=null;toast('HalalFrame installed.');});
async function installApp(){
  if(window.matchMedia('(display-mode:standalone)').matches){toast('HalalFrame is already installed.');return;}
  if(installEvent){const prompt=installEvent;installEvent=null;await prompt.prompt();return;}
  if(/iphone|ipad|ipod/i.test(navigator.userAgent))toast('On iPhone: tap Share in Safari → Add to Home Screen.');
  else toast('In Chrome: open the ⋮ menu → Install app / Add to Home screen.');
}
$('install-app').onclick=installApp;
$('info-content').addEventListener('click',e=>{
  if(e.target.closest('#info-disclaimer-link')){$('info-modal').classList.add('hidden');firstRun.showDisclaimer();}
  if(e.target.closest('#info-social-link'))showInfo('social');
  if(e.target.closest('#info-install-link')){ $('info-modal').classList.add('hidden'); void installApp(); }
});
function showInfo(type){const title={about:'About HalalFrame',ruling:'The Amanah of Sharing',help:'How HalalFrame works',social:'Getting videos from social media'}[type];$('info-title').textContent=title;
  const content={
    about:`<h3>Developed by Adhkarly Team</h3><p>We are software developers creating practical, beneficial software to serve the Muslim Ummah, in shaa Allah. HalalFrame is built to help people conceal visual content before sharing it, with privacy, simplicity, and accessibility at its heart.</p><h3>Special thanks</h3><p>Special thanks to my friend Mustapha (Muzzy) for inspiring this idea. I ask Allah that the reward for this goes to him and to all the muwahhideen who are trying to uphold the seriousness of forbidding munkar and encouraging goodness.</p><p>All media editing takes place in the browser. No sign-in, app server or uploaded media. AI model files download from the model provider on first use.</p><h3>Discover Adhkarly</h3><p>Daily adhkar, Qur'an and Islamic learning. Our download links will be added later.</p><p><button id="info-install-link" class="text-btn">Install HalalFrame ↗</button> · <button id="info-disclaimer-link" class="text-btn">View disclaimer again ↗</button> · <button id="info-social-link" class="text-btn">Getting social media videos ↗</button></p>`,
    ruling:`<p><strong>Before you share, remember Allah.</strong> A photo or video can be forwarded and viewed far beyond the original audience. We should avoid knowingly encouraging or spreading sin.</p><blockquote>“Whoever calls to misguidance will have a burden of sin like that of those who follow him, without that detracting from their sins in the slightest.” <strong>— Sahih Muslim 2674</strong></blockquote><p>Allah warns about those who love immorality to spread among the believers (Surah An-Nur 24:19). Not every accidental appearance necessarily makes someone responsible for every later viewer's actions; intention, knowledge and what is being promoted matter.</p><p><strong>AI can make mistakes.</strong> Check your complete edited media before sharing. This app does not guarantee that all exposed awrah has been found.</p>`,
    social:`<p><strong>HalalFrame does not download videos from YouTube, Facebook, Instagram or TikTok links.</strong></p><p>When a creator and the platform permit saving a video, use that app's own Save or Download option, or use footage you recorded yourself. Then open the saved media in HalalFrame using <strong>Choose a file</strong>.</p><p>On Android, install HalalFrame as an app. From Gallery or Files, tap <strong>Share → HalalFrame</strong> to send a video or image file directly into the editor. Some apps share only a webpage link instead of the media file, which cannot be imported automatically.</p><p>Respect the creator's permissions and applicable platform terms. No external downloader links are used.</p>`,
    help:`<p><strong>1.</strong> Open a local video or photo. <strong>2.</strong> Pause at the moment you want. Tap a person to load the AI detector, or choose “Draw new box” and drag on the video. <strong>3.</strong> A new region starts at that moment and lasts three seconds by default. Move the scrubber to a later moment, select “Add keyframe” and draw its new position. <strong>4.</strong> Tap Track → or ← to let AI follow it, stopping to ask you when uncertain. <strong>5.</strong> Review the full timeline before sharing.</p><p>Photo JPG/PNG export is included. Video MP4/audio output uses hardware WebCodecs when available and single-thread FFmpeg or WebM fallback, depending on browser support; check the result before sharing.</p>`
  };$('info-content').innerHTML=content[type];$('info-modal').classList.remove('hidden');}

function refreshEstimate(){
  if(!project||kind!=='video')return;
  const est=estimateSize(project.video,$('export-preset').value);
  $('export-estimate').textContent=`${est.width}×${est.height} · approx ${(est.bytes/1024/1024).toFixed(1)} MB · actual size varies with motion`;
}
$('export-preset').onchange=refreshEstimate;
async function performVideoExport(){
  if(kind!=='video'||!project||!sourceFile||busyController)return;
  let audioOptions;
  try{audioOptions=audioPanel.exportOptions();}catch(error){toast(error.message);audioPanel.tab('audio');return;}
  const controller=beginBusy('Exporting MP4','Rendering every frame on this device. Keep the app open.');
  const previousTime=currentTime();hiddenVideo.pause();$('export-result').classList.add('hidden');
  try{
    const result=await exportVideo({file:sourceFile,project,maskCache,ai,preset:$('export-preset').value,...audioOptions,signal:controller.signal,onProgress:(p,message)=>progress(p,message),onStatus:message=>$('busy-copy').textContent=message});
    if(controller.signal.aborted)throw new DOMException('Cancelled','AbortError');
    exportResult={...result,name:`${project.video.fileName.replace(/\.[^.]+$/,'')}-halalframe.${result.format}`};
    $('export-result').classList.remove('hidden');
    $('export-result-title').textContent=`${result.format.toUpperCase()} ready · ${(result.blob.size/1024/1024).toFixed(1)} MB`;
    $('export-result-message').textContent=result.warning||`Edited video ready (${audioOptions.audioMode==='none'?'silent':audioOptions.audioMode==='clean'?'cleaned voice':'original soundtrack'}). Review playback before sharing.`;
    toast('Export finished. Test playback and sound before sharing.');
  }catch(e){if(e.name==='AbortError')toast('Export cancelled.');else{console.error(e);toast('Export failed: '+e.message);}}
  finally{endBusy();await seekTo(previousTime);}
}
$('mp4-export').onclick=()=>{if(kind==='video'&&project&&sourceFile&&!busyController){try{audioPanel.exportOptions();requestExportReview(performVideoExport);}catch(e){toast(e.message);audioPanel.tab('audio');}}};
$('download-video').onclick=()=>{if(exportResult)downloadBlob(exportResult.blob,exportResult.name);};
$('share-video').onclick=async()=>{
  if(!exportResult)return;
  try{if(!(await shareBlob(exportResult.blob,exportResult.name))){downloadBlob(exportResult.blob,exportResult.name);toast('Sharing files is not supported here; downloaded instead.');}}
  catch(e){if(e.name!=='AbortError')toast('Sharing failed: '+e.message);}
};
async function runModelSelfCheck(){
  const status=$('model-test-status');status.textContent='AI self-check: downloading model and testing…';
  try{const img=new Image();img.src='assets/test-person.jpg';await img.decode();const result=await ai.selfCheck(img);
    status.textContent=`Self-check: ${result.message} · ${result.delegate}`;
    warmAI();
  }catch(e){status.textContent='Model failed to load — check internet for first run. '+e.message;}
}
$('run-self-check').onclick=runModelSelfCheck;
// Share Target accepts files, NOT remote video URLs. The service worker puts
// shared media in local IndexedDB for the short redirect, and this removes it.
async function consumeIncomingShare(){
  const params=new URL(location.href).searchParams;
  const id=params.get('shared'),error=params.get('share-error');
  if(!id&&!error)return;
  try{window.history.replaceState(null,'',location.pathname+location.hash);}catch{}
  if(error){toast(error==='no-file'?'The app shared a link, not a media file. Use its Save option first.':'Could not receive the shared file. Try Choose a file.');return;}
  try{
    const file=await takeSharedFile(id);
    if(!file){toast('Shared media expired or unavailable. Please share again.');return;}
    // Some file managers supply no MIME type; infer from its extension.
    const originalType=file.type||'';
    const type=/^(video|image)\//.test(originalType)?originalType:({mp4:'video/mp4',mov:'video/quicktime',webm:'video/webm',m4v:'video/mp4',jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',gif:'image/gif'}[file.name.split('.').pop().toLowerCase()]||'');
    const imported=type===file.type?file:new File([file],file.name,{type,lastModified:file.lastModified});
    await openFile(imported);
  }catch(e){console.error('Shared media import',e);toast('Could not open the shared media: '+e.message);}
}
const firstRun=initFirstRun({initAI:()=>ai.init(),onAIReady:()=>warmAI(),onReady:()=>{void consumeIncomingShare();}});
let swRegistration=null,swWarmStarted=false;
function swMessage(data){return new Promise(resolve=>{
  if(!navigator.serviceWorker.controller)return resolve(null);
  const ch=new MessageChannel();ch.port1.onmessage=e=>resolve(e.data);
  navigator.serviceWorker.controller.postMessage(data,[ch.port2]);
  setTimeout(()=>resolve(null),15000);
});}
async function checkAIReady(){
  const r=await swMessage({type:'AI_STATUS'});
  if(r?.ready){$('offline-status').textContent='AI ready offline ✓';$('offline-status').classList.add('ready');}
  else $('offline-status').textContent=`AI cache ${r?.count||0}/${r?.total||8} files`;
}
async function warmAI(){
  if(!navigator.serviceWorker.controller||swWarmStarted)return;
  swWarmStarted=true;
  const channel=new MessageChannel();
  channel.port1.onmessage=e=>{if(e.data?.done){if(!e.data.ready)swWarmStarted=false;checkAIReady();channel.port1.close();}};
  navigator.serviceWorker.controller.postMessage({type:'WARM_AI'},[channel.port2]);
}
// Only show "Update ready" for a GENUINELY waiting, newer service worker.
// The old controllerchange/SW_ACTIVATED handler showed a permanent false toast
// because skipWaiting activates the worker immediately on every deployment.
const updateBanner=$('update-banner');
const swVersion=worker=>{try{return new URL(worker?.scriptURL||'').searchParams.get('v');}catch{return null;}};
const isNewer=(remote,local=APP_VERSION)=>{
  if(!remote)return false;
  const a=remote.split('.').map(Number),b=local.split('.').map(Number);
  for(let i=0;i<Math.max(a.length,b.length);i++){
    if((a[i]||0)!==(b[i]||0))return (a[i]||0)>(b[i]||0);
  }
  return false;
};
function hideUpdate(){updateBanner.classList.add('hidden');}
function showUpdateIfWaiting(){
  const waiting=swRegistration?.waiting;
  const nextVersion=swVersion(waiting);
  if(!waiting||!isNewer(nextVersion)){hideUpdate();return false;}
  updateBanner.classList.remove('hidden');
  return true;
}
async function initPWA(){
  hideUpdate();
  if(!('serviceWorker'in navigator)||location.protocol==='file:')return;
  const previous=navigator.serviceWorker.controller;
  try{
    navigator.serviceWorker.addEventListener('controllerchange',()=>{
      hideUpdate();checkAIReady();
      const current=swVersion(navigator.serviceWorker.controller);
      // An empty editor can reload immediately. Never drop an open project.
      if(previous&&isNewer(current)&&!project&&!busyController&&!trackingActive&&!document.body.classList.contains('hf-locked')){
        const key='halalframe-auto-reloaded-'+current;
        if(!sessionStorage.getItem(key)){sessionStorage.setItem(key,'1');location.reload();}
      }
    });
    swRegistration=await navigator.serviceWorker.register(`./sw.js?v=${APP_VERSION}`,{scope:'./',updateViaCache:'none'});
    await navigator.serviceWorker.ready;
    if(!navigator.serviceWorker.controller)await new Promise(resolve=>{navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true});setTimeout(resolve,2500);});
    swRegistration.addEventListener('updatefound',()=>{
      const installing=swRegistration.installing;
      installing?.addEventListener('statechange',()=>{if(installing.state==='installed')showUpdateIfWaiting();});
    });
    showUpdateIfWaiting();await checkAIReady();void warmAI();
    swRegistration.update().then(showUpdateIfWaiting).catch(()=>{});
  }catch(e){hideUpdate();$('offline-status').textContent='Offline install unavailable';}
}
$('update-reload').onclick=()=>{hideUpdate();location.reload();};
// A tab left open for days should discover an update even if the browser does
// not immediately check for a new SW. Only the tiny HTML file is fetched.
async function checkForNewRelease(){
  if(location.protocol==='file:')return;
  try{
    const response=await fetch(`./index.html?version-check=${Date.now()}`,{cache:'no-store'});
    if(!response.ok)return;
    const found=(await response.text()).match(/const APP_VERSION=['"]([^'"]+)['"]/);
    if(found&&isNewer(found[1])){await swRegistration?.update();showUpdateIfWaiting();}else hideUpdate();
  }catch{} // Do not show a false update when offline.
}
window.addEventListener('visibilitychange',()=>{if(!document.hidden)checkForNewRelease();});
setInterval(checkForNewRelease,180000);
initPWA();void firstRun.start();
window.addEventListener('keydown',e=>{if(e.target.matches('input,select,textarea'))return;
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();restore(e.shiftKey?history.redo():history.undo());}
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='y'){e.preventDefault();restore(history.redo());}
  if(e.code==='Space'&&project&&kind==='video'){e.preventDefault();$('play').click();}
});
// Small accessible test probe, read-only; debug data only and not part of user features.
Object.defineProperty(window,'__halalframeTest',{get:()=>({project:clone(project),time:currentTime(),tool,delegate:ai.delegate})});
setTool('select');requestAnimationFrame(cycle);
