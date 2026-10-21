import {createProject,newConcealment,addPoint,boxAt,clamp,clone,History,seconds,saveProject,loadSavedProject,clearSavedProject,migrateProjectEffects} from './state.js';
import {renderFrame} from './engine/render.js';
import {debugFrameForFile} from './engine/real-footage-tracker.js';
import {MaskCache} from './engine/segmentation.js';
import {appearanceSignature,iou} from './engine/identity.js';
import {PersonAI,nearestPerson} from './engine/ai.js';
import {seekFrame,trackDirection,findAllPeople,personThumbnail} from './engine/tracker.js';
import {exportPhoto,downloadBlob,exportVideo,estimateSize,shareBlob,EXPORT_PRESETS} from './engine/export.js';
import {inspectVideoFile,supportedEncoderChoices,browserDiagnostics,MediaError} from './engine/media-probe.js';
import {convertSourceToH264} from './engine/conversion.js';
import {CanvasInput} from './ui/canvas-input.js';
import {Timeline} from './ui/timeline.js';
import {activeAt} from './state.js';
import {initFirstRun,initExportReview} from './ui/first-run.js';
import {takeSharedFile} from './ui/share-target.js';
import {AudioPanel} from './ui/audio-panel.js';
import {isPersonSelection,needsFullTracking,finalizeFullTrack,applyCompleteScanTrack} from './engine/auto-coverage.js';
import {openReviewGaps,markGapReviewed,finishCoverAtGap} from './engine/gap-review.js';
import {estimateTrackGender,genderCaption} from './engine/gender.js';
const $=id=>document.getElementById(id);
let project=null,media=null,kind='video',sourceURL=null,selectedId=null,tool='select',draft=null;
let busyController=null,reviewResolve=null,fixResolve=null,gapEditor=null,aiBoxes=[],trackingActive=false,scanResults=[];
let debugAnalysisPending=-1,lastDebugRequest=0;
let lastFrameRendered=-1,toastTimer=null,saveTimer=null,frameCounter=0,fpsWindowStart=performance.now(),measuredFPS=0;
let exportResult=null,sourceFile=null,videoProbe=null,pendingConversion=null,lastDiagnostic=null;
const recentExports=[];const RECENT_LIMIT=4;let autoDownloadAttempts=0;const requestExportReview=initExportReview();const maskCache=new MaskCache();const maskTasks=new Set();
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
  const debug=$('debug').checked,frameIndex=Math.round(t*project.video.fps);
  const cached=debug?ai.frameCache.get(frameIndex):null;
  const overlay=debug?debugFrameForFile(sourceFile,frameIndex,selected()?boxAt(selected(),t):null):null;
  // Always show CURRENT-frame detections. Never reuse detections captured at a
  // different playhead time (the original debug overlay did exactly that).
  renderFrame(ctx,media,displayed,t,{debug,detections:cached||overlay?.detections||[],predictedBox:overlay?.predicted||null,draft,maskCache,previewMask:$('preview-mask').checked});
  if(debug&&!cached&&!overlay&&!trackingActive&&kind==='video'&&ai.ready&&performance.now()-lastDebugRequest>180&&debugAnalysisPending!==frameIndex){
    debugAnalysisPending=frameIndex;lastDebugRequest=performance.now();
    ai.detect(media,t,project.video.fps).then(()=>{if(Math.round(currentTime()*project.video.fps)===frameIndex)render();}).catch(()=>{}).finally(()=>{debugAnalysisPending=-1;});
  }
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
    const trackingLabel=$('tracking-status');
    trackingLabel.classList.toggle('hidden',!isPersonSelection(c)||kind!=='video');
    if(isPersonSelection(c)&&kind==='video'){
      const done=!needsFullTracking(c,project.video.duration);
      trackingLabel.classList.toggle('complete',done);
      trackingLabel.textContent=openReviewGaps(c).length?`⚠ ${openReviewGaps(c).length} uncertain interval(s). Tap an amber timeline segment or Review gaps.`:
        c.userEnded?'Manual end point selected — review this time range.':
        done?`✓ AI followed this person across the full ${seconds(project.video.duration)} clip.`:
        '⚠ Following is unfinished. Export will ask you to complete tracking before saving.';
    }
    $('mask-enabled').checked=c.enabled!==false;
    $('mask-label').value=c.label;$('effect').value=c.effect;$('shape').value=c.shape;
    $('strength').value=c.strength;$('padding').value=Math.round(c.padding*100);$('padding-label').textContent=Math.round(c.padding*100)+'%';
    $('start-time').value=c.startTime.toFixed(2);$('end-time').value=c.endTime.toFixed(2);
    $('feather').value=c.feather||0;$('feather-label').textContent=(c.feather||0)+'px';
    $('safety-margin').value=c.safetyMargin??8;$('safety-label').textContent=(c.safetyMargin??8)+'px';
    $('include-face').checked=!!c.includeFace;$('whole-frame').checked=!!c.wholeFrame;
  }
  refreshGapPanel(c);
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
function refreshGapPanel(c){
  const panel=$('gap-review-panel'),list=$('gap-review-list');if(!panel||!list)return;
  const gaps=c?openReviewGaps(c):[];panel.classList.toggle('hidden',!gaps.length);list.replaceChildren();
  for(const gap of gaps){
    const row=document.createElement('div');row.className='gap-review-item';
    const label=document.createElement('span');label.textContent=`⚠ ${seconds(gap.from)}–${seconds(gap.to)}`;
    const button=document.createElement('button');button.type='button';button.className='btn outline small';button.textContent='Review';
    button.addEventListener('click',()=>{void reviewGap(c,gap);});row.append(label,button);list.append(row);
  }
}
function findGap(c,gapId){return c?.reviewGaps?.find(g=>g.id===gapId)||openReviewGaps(c)[0]||null;}
async function markGapWithConfirmation(c,gap){
  if(!gap)return false;
  selectMask(c.id);await seekTo((gap.from+gap.to)/2);
  const choice=await requestDecision('coverage-mark-modal',{
    detail:`${c.label}: ${seconds(gap.from)}–${seconds(gap.to)}. Confirm only after checking the video around this interval; the AI cannot prove identity during an occlusion.`,
    buttons:{'coverage-mark-confirm':'confirm','coverage-mark-back':'back'}
  });
  if(choice!=='confirm')return false;
  markGapReviewed(c,gap,'user-confirmed');snapshot();return true;
}
async function reviewGap(c,gap){
  if(!c||!gap||!project)return 'back';
  selectedId=c.id;refresh();hiddenVideo.pause();
  await seekTo(Math.min(project.video.duration,(gap.from+gap.to)/2));render();
  try{$('gap-action-shot').src=canvas.toDataURL('image/jpeg',.75);}catch{$('gap-action-shot').removeAttribute('src');}
  const choice=await requestDecision('gap-action-modal',{
    detail:`${c.label}, ${seconds(gap.from)}–${seconds(gap.to)}. Inspect the surrounding frames. If identity is uncertain, draw a box or re-tap the correct person.`,
    buttons:{'gap-confirm':'confirm','gap-draw':'draw','gap-retap':'retap','gap-end':'end','gap-back':'back'}
  });
  if(choice==='confirm'){await markGapWithConfirmation(c,gap);return 'confirm';}
  if(choice==='end'){finishCoverAtGap(c,gap);snapshot();return 'end';}
  if(choice==='draw'||choice==='retap'){
    // The on-canvas action is deliberately NOT auto-resolved. The next actual
    // pointer action supplies the user's correction, then clears the amber bar.
    gapEditor={cId:c.id,gapId:gap.id,mode:choice};setTool(choice==='draw'?'draw':'select');
    toast(choice==='draw'?'Draw around the correct person at this paused frame.':'Tap the correct person at this paused frame.');
    return choice;
  }
  return 'back';
}
function selectMask(id){selectedId=id;refresh();}
function setTool(mode){tool=mode;input.setMode(mode==='key'?'draw':mode==='draw'?'draw':'select');
  ['select','draw','key','exclude'].forEach(n=>$(`mode-${n}`).classList.toggle('selected',n===mode));
  $('mode-help').textContent={select:'Tap a person once — AI automatically tracks them to the start AND end of the video.',draw:'Drag directly on the paused video to create a new time-limited region. Drawing does not move the playhead.',key:'Select a region, scrub to a new time, then draw its updated location. The region moves smoothly between keyframes.',exclude:'Tap someone you do NOT want concealed. The app will track their position and exclude them from unrelated masks.'}[mode];
  hiddenVideo.pause();
}
function showCodecWarning(file,probe=null,error=null){
  pendingConversion=file;videoProbe=probe;
  const diagnostic=browserDiagnostics(file,probe||{},{errorCode:error?.code||'HF_SOURCE_CODEC',cause:error?.message||'Unsupported source codec'});
  lastDiagnostic=diagnostic;
  $('codec-warning').classList.remove('hidden');
  const codec=probe?.codec||'unknown',bitDepth=probe?.bitDepth||'unknown';
  $('codec-warning-message').textContent=`This video uses ${codec} (${bitDepth}-bit) or a container Chrome cannot decode. Convert it on your phone to H.264 8-bit SDR, then edit and export. Original videos never leave your device.`;
  $('codec-warning-error').textContent=error?.message||probe?.unsupportedReason||'';
}
function hideCodecWarning(){pendingConversion=null;$('codec-warning').classList.add('hidden');}
$('convert-file').onclick=async()=>{
  if(!pendingConversion||busyController)return;
  const original=pendingConversion,probe=videoProbe;
  const controller=beginBusy('Converting on-device','Preparing H.264 8-bit compatible video (nothing uploaded).');
  try{
    const result=await convertSourceToH264(original,{signal:controller.signal,hdr:(probe?.bitDepth||8)>8||/hvc1|hev1/i.test(probe?.codec||''),
      onStatus:x=>$('busy-copy').textContent=x,onProgress:x=>progress(x,'Converting to H.264 · '+Math.round(x*100)+'%')});
    endBusy();hideCodecWarning();if(result.warning)toast(result.warning);
    await openFile(result.file);
  }catch(e){
    endBusy();$('codec-warning-error').textContent=`${e.code||'HF_CONVERT_FAILED'}: ${e.message}`;
    lastDiagnostic=browserDiagnostics(original,probe||{},{errorCode:e.code||'HF_CONVERT_FAILED',cause:e.details?.cause||e.message});
    toast('Conversion failed · '+(e.code||'HF_CONVERT_FAILED')+'. See the compatibility card.');
  }
};
$('copy-codec-diagnostic').onclick=()=>navigator.clipboard?.writeText(JSON.stringify(lastDiagnostic,null,2)).then(()=>toast('Diagnostic copied')).catch(()=>toast('Could not copy — use Chrome HTTPS.'));
$('copy-export-diagnostic').onclick=()=>navigator.clipboard?.writeText(JSON.stringify(lastDiagnostic,null,2)).then(()=>toast('Export diagnostic copied')).catch(()=>toast('Could not copy — use Chrome HTTPS.'));
async function openFile(file){
  if(!file)return;
  if(!/^(image|video)\//.test(file.type)){
    const ext=(file.name.split('.').pop()||'').toLowerCase();
    const type=({mp4:'video/mp4',mov:'video/quicktime',m4v:'video/mp4',webm:'video/webm',jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp'})[ext];
    if(!type){toast('Choose an image or video');return;}
    file=new File([file],file.name,{type,lastModified:file.lastModified});
  }
  clearTimeout(saveTimer);busyController?.abort();if(reviewResolve){reviewResolve({action:'end'});reviewResolve=null;}
  if(sourceURL)URL.revokeObjectURL(sourceURL);
  sourceURL=URL.createObjectURL(file);kind=file.type.startsWith('image/')?'photo':'video';
  $('export-error').classList.add('hidden');hideCodecWarning();videoProbe=null;
  if(kind==='video'){
    try{
      videoProbe=await inspectVideoFile(file);
      if(videoProbe?.supported===false){showCodecWarning(file,videoProbe);return;}
    }catch(e){
      // Unrecognized MOV structures can still play in HTML5; try the player.
      console.warn('MP4 inspector',e);videoProbe={codec:'unknown',probeUnavailable:true,fileSize:file.size,probeError:e.message};
    }
  }

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
      info={duration:Number(hiddenVideo.duration)||0,fps:videoProbe?.fps||30,width:d.width,height:d.height,fileName:file.name,fileSize:file.size,fileLastModified:file.lastModified,codec:videoProbe?.codec||'unknown',rotation:videoProbe?.rotation||0};
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
    refreshEstimate();void updateEncoderAvailability();setTool('select');refresh();$('editor').scrollIntoView({behavior:'smooth',block:'start'});
    toast('File opened locally. Nothing uploaded.');
  }catch(e){
    if(kind==='video')showCodecWarning(file,videoProbe,e);
    toast('Unable to open: '+e.message);console.error(e);
  }
}

function onDraw(box){
  if(gapEditor?.mode==='draw'){
    const c=project?.concealments.find(x=>x.id===gapEditor.cId),g=findGap(c,gapEditor.gapId);
    gapEditor=null;if(!c||!g)return;
    addPoint(c,currentTime(),box,'manual',1);markGapReviewed(c,g,'user-drawn');
    selectedId=c.id;setTool('select');snapshot();toast('Manual correction saved. Review the frames around it before sharing.');return;
  }
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
      const tracks=scanResults.length?scanResults:await findAllPeople({video:hiddenVideo,file:sourceFile,project,ai,accuracy:$('tracking-accuracy').value,signal:controller.signal,onProgress:(p,t)=>progress(p,`${Math.round(100*p)}% · ${seconds(t)}`)});
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
// Persistent modal decision: no silent toast for an operation that cannot continue.
function requestDecision(modalId,{detail,buttons}){
  const modal=$(modalId);
  if(detail){const p=modal.querySelector('[id$="-detail"]');if(p)p.textContent=detail;}
  modal.classList.remove('hidden');
  return new Promise(resolve=>{
    let done=false;const cleanup=()=>{modal.classList.add('hidden');for(const [id,handler] of handlers)$(id).removeEventListener('click',handler);};
    const handlers=Object.entries(buttons).map(([id,value])=>[id,()=>{if(done)return;done=true;cleanup();resolve(value);}]);
    for(const [id,handler] of handlers)$(id).addEventListener('click',handler);
    $(handlers[0][0]).focus();
  });
}
// Full-video tracking is the default for a person. Drawing a manual region
// deliberately retains its time range and keyframes.
async function autoTrackPerson(c,{fromExport=false}={}){
  if(kind!=='video'||!project||busyController||!isPersonSelection(c))return false;
  const originalPlayhead=currentTime(),origin=c.originalTapTime??c.track.find(p=>p.source==='manual'||p.source==='ai')?.t??0;
  const duration=project.video.duration;
  const controller=beginBusy('Following this person…','Tracking from the selected frame to both ends of the video. Cancel to stop.');
  trackingActive=true;hiddenVideo.pause();c.trackingStatus='running';
  c.startTime=0;c.endTime=duration;
  const fweight=Math.max(0,duration-origin)/Math.max(duration,.01);
  let userEnded=false,retryAfterCleanup=false;
  const review=async info=>{
    // v1.11 never conceals another person merely because a target was lost.
    // A sustained loss needs a visible human decision.
    const decision=await askTracking(info);
    if(decision.action==='end'){c.userEnded=true;userEnded=true;}
    return decision;
  };
  try{
    await ai.init();
    if(origin<duration-.005){
      await trackDirection({video:hiddenVideo,file:sourceFile,project,concealment:c,ai,direction:1,
        checkEvery:Number($('check-interval').value),accuracy:$('tracking-accuracy').value,signal:controller.signal,
        onProgress:(f,t)=>progress(fweight*f,`Following this person… ${Math.round(fweight*f*100)}% · ${seconds(t)} · Cancel to stop`),
        onFrame:(t,boxes)=>{aiBoxes=boxes;render();},onReview:review});
    }
    if(!controller.signal.aborted&&origin>.005){
      await trackDirection({video:hiddenVideo,file:sourceFile,project,concealment:c,ai,direction:-1,
        checkEvery:Number($('check-interval').value),accuracy:$('tracking-accuracy').value,signal:controller.signal,
        onProgress:(f,t)=>progress(fweight+(1-fweight)*f,`Following this person… ${Math.round((fweight+(1-fweight)*f)*100)}% · ${seconds(t)}`),
        onFrame:(t,boxes)=>{aiBoxes=boxes;render();},onReview:review});
    }
    if(controller.signal.aborted)throw new DOMException('Cancelled','AbortError');
    if(!userEnded){finalizeFullTrack(c,duration);progress(1,c.reviewGaps?.some(g=>!g.resolved)?'Tracking complete with review gaps — correct uncertain moments before export.':'Person followed from start to end. Review the result.');}
    else c.trackingStatus='complete';
    snapshot();
    toast(c.reviewGaps?.some(g=>!g.resolved)?`${c.label}: uncertain intervals need review; export is blocked until corrected.`:`${c.label}: followed through ${seconds(duration)}. Review before sharing.`);
    return true;
  }catch(error){
    c.trackingStatus='incomplete';snapshot();
    if(error.name!=='AbortError')console.error('Full-video tracking failed',error);
    if(!fromExport){
      if(!openReviewGaps(c).length&&c.track.length){
        const last=c.track.at(-1)?.t||0;
        if(last<duration-.04)c.reviewGaps=[...(c.reviewGaps||[]),{
          from:last,to:duration,reason:'Tracking interrupted before the end',resolved:false
        }];
      }
      const action=await requestDecision('coverage-block-modal',{
        detail:`${c.label} could not be followed through the complete video (${error.message}). Retry, review uncertain frames, or explicitly end this cover.`,
        buttons:{'coverage-finish':'retry','coverage-review':'review','coverage-mark':'mark','coverage-end':'end','coverage-back':'back'}
      });
      if(action==='retry')retryAfterCleanup=true;
      if(action==='review'&&openReviewGaps(c).length)await reviewGap(c,openReviewGaps(c)[0]);
      if(action==='mark'&&openReviewGaps(c).length)await markGapWithConfirmation(c,openReviewGaps(c)[0]);
      if(action==='end'){
        if(openReviewGaps(c).length)finishCoverAtGap(c,openReviewGaps(c)[0]);
        else{c.userEnded=true;c.endTime=Math.min(duration,c.track.at(-1)?.t??duration);}
        snapshot();
      }
    }
  }finally{
    trackingActive=false;endBusy();hiddenVideo.pause();
    // Playback position is not part of the mask. Return to the user's frame.
    if(!fromExport&&kind==='video'&&Math.abs(originalPlayhead-currentTime())>.03)void seekTo(originalPlayhead);
    refresh();
  }
  if(retryAfterCleanup)return autoTrackPerson(c,{fromExport});
  return false;
}
async function onTap(x,y){
  if(gapEditor?.mode==='retap'){
    const editor=gapEditor,c=project?.concealments.find(x=>x.id===editor.cId),gap=findGap(c,editor.gapId);
    if(!c||!gap){gapEditor=null;return;}
    hiddenVideo.pause();try{
      await ai.init();const boxes=await ai.detect(media,currentTime(),project.video.fps),match=nearestPerson(boxes,x,y);
      if(!match){toast('No person found at the tap. Try again or Draw box.');return;}
      addPoint(c,currentTime(),match,'manual',match.confidence||1);
      markGapReviewed(c,gap,'user-retapped');c.originalTapTime=currentTime();
      gapEditor=null;selectedId=c.id;setTool('select');snapshot();
      toast('Correct person re-selected at this frame. Review downstream motion, or press Track → to refresh it.');
    }catch(e){toast('Re-tap failed: '+e.message);}return;
  }
  if(fixResolve){const b={x:clamp(x-.09,0,.99),y:clamp(y-.14,0,.99),w:.18,h:.28};onDraw(b);return;}
  if(tool==='key'){toast('Draw a rectangle for the new keyframe.');return;}
  if(tool==='draw'){toast('Drag to draw a rectangle, not just tap.');return;}
  if(!project||busyController){toast('Finish the current operation first.');return;}
  if(tool==='exclude'){await excludeTappedPerson(x,y);return;}
  hiddenVideo.pause();let created=null;
  try{
    const controller=beginBusy('Detecting people','The model runs locally after downloading.');
    const time=currentTime();
    aiBoxes=await ai.detect(media,time,project.video.fps);
    if(controller.signal.aborted)throw new DOMException('Cancelled','AbortError');
    render();
    const b=nearestPerson(aiBoxes,x,y);
    if(!b){toast('No person found at this frame. Use Draw new box.');return;}
    const c=newConcealment(project,b,time,{label:`Person ${project.concealments.filter(c=>c.label.startsWith('Person')).length+1}`,source:'ai'});
    c.track[0].confidence=b.confidence;c.identitySignature=appearanceSignature(media,b);c.precisionCritical=true;c.thumbnail=personThumbnail(media,b);
    if(kind==='video'){
      c.originalTapTime=time;c.trackingStatus='pending';c.userEnded=false;
      // Full-length timeline coverage is visible immediately; masks still
      // require successful tracking before export is allowed.
      c.startTime=0;c.endTime=project.video.duration;
    }
    project.concealments.push(c);selectedId=c.id;created=c;snapshot();
  }catch(e){if(e.name==='AbortError')toast('AI selection cancelled.');else{console.error(e);toast('AI unavailable: '+e.message+'. Manual drawing still works.');}}
  finally{endBusy();}
  if(created&&kind==='video')await autoTrackPerson(created);
}
const input=new CanvasInput(canvas,{onDraw,onTap,onDraft:b=>{draft=b;render();}});
const timeline=new Timeline({slider:$('scrubber'),lanes:$('timeline-lanes'),onSeek:seekTo,onSelect:selectMask,
  onGapSelect:(id,gapId)=>{const c=project?.concealments.find(x=>x.id===id);if(c)void reviewGap(c,findGap(c,gapId));},
  onRange:(id,edge,t)=>{const c=project.concealments.find(x=>x.id===id);if(!c)return;if(edge==='start'){c.startTime=clamp(t,0,c.endTime);c.userStart=true;}else{c.endTime=clamp(t,c.startTime,project.video.duration);c.userEnded=true;}refresh({renderOnly:true});},
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
async function askTracking({kind:reviewKind,time,reason,detections,proposed,direction,expectedThumb,candidateThumb}){
  $('busy').classList.add('hidden');
  const reappeared=reviewKind==='reacquire';
  $('review-continue').textContent=reappeared?'Yes, cover':'Keep going';
  $('review-skip').textContent=reappeared?'No, different person':'Skip ahead';
  $('review-fix').textContent=reappeared?'Draw box':'Fix box';
  $('review-end').classList.toggle('hidden',reappeared);
  $('review-modal').classList.remove('hidden');$('review-description').textContent=`At ${seconds(time)}: ${reason}. Confirm, adjust, or stop. The previous region remains covered until you choose.`;
  const thumbs=$('review-identity-thumbs');if(thumbs){thumbs.classList.toggle('hidden',!expectedThumb&&!candidateThumb);
    if(expectedThumb)$('review-target-thumb').src=expectedThumb;
    if(candidateThumb)$('review-candidate-thumb').src=candidateThumb;
  }
  try{$('review-shot').src=canvas.toDataURL('image/jpeg',.7);}catch{$('review-shot').removeAttribute('src');}
  const action=await new Promise(resolve=>{reviewResolve=resolve;});
  reviewResolve=null;hideReview();
  if(reappeared&&action.action==='continue')action.action='accept';
  if(reappeared&&action.action==='skip')action.action='reject';
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
    await trackDirection({video:hiddenVideo,file:sourceFile,project,concealment:c,ai,direction,checkEvery:Number($('check-interval').value),accuracy:$('tracking-accuracy').value,signal:controller.signal,
      onProgress:(p,t)=>progress(p,`${Math.round(p*100)}% · ${seconds(t)} · ${c.track.length} positions`),
      onFrame:(t,boxes)=>{aiBoxes=boxes;render();},onReview:async info=>{const decision=await askTracking(info);if(decision.action==='end')c.userEnded=true;return decision;}});
    if(!c.userEnded&&c.startTime<=.04&&c.endTime>=project.video.duration-.04)finalizeFullTrack(c,project.video.duration);
    else c.trackingStatus='incomplete';
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
      scanResults=boxes.map((b,i)=>({id:`person-${i+1}`,label:`Person ${i+1}`,thumbnail:personThumbnail(media,b),faceSamples:headCrop(media,b),track:[{t:0,...b,source:'ai'}],startTime:0,endTime:0}));
    }else{
      scanResults=await findAllPeople({video:hiddenVideo,file:sourceFile,project,ai,accuracy:$('tracking-accuracy').value,signal:controller.signal,onProgress:(p,t,count)=>progress(p,`${Math.round(p*100)}% · ${seconds(t)} · ${count} tracks`) });
    }
    endBusy();render();
    if(coverAll){applyScan(scanResults);toast(`Added ${scanResults.length} person tracks. Review identity changes.`);}
    else showScan();
  }catch(e){if(e.name==='AbortError')toast('Scan cancelled.');else{console.error(e);toast('Scan failed: '+e.message);}}
  finally{trackingActive=false;endBusy();}
}
let genderJob=null,scanGeneration=0;
// Photo equivalent of the scan's head-and-shoulders samples (v1.12 gender estimate).
function headCrop(source,b){
  const W=source.videoWidth||source.naturalWidth||source.width||1,H=source.videoHeight||source.naturalHeight||source.height||1;
  const cx=(b.x+b.w/2)*W,side=Math.max(b.w*W*1.15,Math.min(b.h*H*.55,b.w*W*1.8));
  const x=Math.max(0,cx-side/2),y=Math.max(0,(b.y-b.h*.06)*H),w=Math.min(W-x,side),h=Math.min(H-y,side*1.05);
  if(w<12||h<12)return [];
  const canvas=document.createElement('canvas'),size=Math.max(64,Math.min(320,Math.round(w)));
  canvas.width=size;canvas.height=Math.max(1,Math.round(size*h/w));
  try{canvas.getContext('2d').drawImage(source,x,y,w,h,0,0,canvas.width,canvas.height);}catch{return [];}
  return [{frame:0,canvas}];
}
function setScanChoice(tr,value){const input=$('scan-list').querySelector(`[name="choice-${tr.id}"][value="${value}"]`);if(input)input.checked=true;}
function applyWomenOnly(){
  // Cover anyone who is NOT confidently a man (unclear/no face stays covered).
  // Choices are only pre-selected; the user still reviews and presses Apply.
  for(const tr of scanResults)setScanChoice(tr,tr.gender?.label==='man'?'skip':'cover');
  $('scan-all').checked=scanResults.every(tr=>tr.gender?.label!=='man');
}
// Optional, explicitly requested (GPT review P1-9): the face model is only
// downloaded when the user asks for "Cover women only". A generation token
// guards against stale results after the modal closes or a new scan starts.
async function classifyScanGenders(){
  const generation=scanGeneration,tracks=scanResults.filter(tr=>!tr.gender);
  if(!tracks.length)return true;
  const job=genderJob={generation};
  const status=$('scan-gender-status');
  const live=()=>genderJob===job&&generation===scanGeneration&&!$('scan-modal').classList.contains('hidden');
  if(status)status.textContent='Estimating likely women/men on this device… (first use downloads ~10 MB)';
  for(const tr of tracks){const el=$('scan-list').querySelector(`[data-gender-for="${tr.id}"]`);if(el)el.textContent='Checking…';}
  try{
    for(const tr of tracks){
      const g=await estimateTrackGender(tr.faceSamples||[]);
      if(!live())return false;
      tr.gender=g;tr.faceSamples=null; // release the crops (P2-16)
      const caption=$('scan-list').querySelector(`[data-gender-for="${tr.id}"]`);
      if(caption){caption.textContent=genderCaption(g);caption.dataset.label=g.label;}
    }
    if(status)status.textContent='AI estimate from clear faces only. Anyone unclear stays covered. Check every person before applying.';
    return true;
  }catch(error){
    console.warn('Gender estimate unavailable',error);
    if(!live())return false;
    for(const tr of tracks)if(!tr.gender)tr.gender={label:'unknown',samples:0};
    if(status)status.textContent='Gender estimate unavailable (offline?) — everyone stays covered.';
    for(const el of $('scan-list').querySelectorAll('[data-gender-for]'))if(el.textContent==='Checking…')el.textContent='Unclear — kept covered';
    return true;
  }finally{if(genderJob===job)genderJob=null;}
}
function showScan(){const list=$('scan-list');list.replaceChildren();$('scan-all').checked=true;
  if(!scanResults.length){const p=document.createElement('p');p.textContent='No people detected. You can still draw a selection manually.';list.append(p);}
  for(const tr of scanResults){const row=document.createElement('div');row.className='scan-person';
    const thumb=document.createElement('img');thumb.className='thumb';thumb.alt=tr.label+' at initial detection';thumb.src=tr.thumbnail;
    const info=document.createElement('div');const name=document.createElement('strong');name.textContent=tr.label;
    const sub=document.createElement('span');sub.className='dim';sub.textContent=kind==='photo'?'Detected in this photo':`Visible ${seconds(tr.startTime)}–${seconds(tr.endTime)} · ${tr.track.length} positions`;
    const gender=document.createElement('span');gender.className='gender-tag';gender.dataset.genderFor=tr.id;gender.textContent=tr.gender?genderCaption(tr.gender):'';if(tr.gender)gender.dataset.label=tr.gender.label;
    info.append(name,sub,gender);
    const group=document.createElement('div');group.className='choice-group';
    for(const [value,caption] of [['cover','Cover'],['exclude','Don’t cover'],['skip','Skip']]){
      const label=document.createElement('label'),input=document.createElement('input');input.type='radio';input.name='choice-'+tr.id;input.value=value;input.checked=value==='cover';label.append(input,document.createTextNode(caption));group.append(label);
    }
    info.append(group);row.append(thumb,info);list.append(row);
  }
  $('scan-modal').classList.remove('hidden');
  scanGeneration++;$('scan-gender-status').textContent='';
  const women=$('scan-women');if(women)women.classList.toggle('hidden',!scanResults.length);
}
function applyScan(tracks,excluded=[]){
  if(!project)return;
  for(const tr of tracks){const c=newConcealment(project,tr.track[0],tr.startTime,{label:`Person ${project.concealments.filter(c=>c.label.startsWith('Person')).length+1}`,source:'ai'});
    c.track=clone(tr.track);c.precisionCritical=true;c.identitySignature=tr.identitySignature||null;
    if(kind==='video')applyCompleteScanTrack(c,tr,project.video.duration);
    else{c.startTime=0;c.endTime=0;c.trackingStatus='complete';}
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
  c[field]=value;if(field==='endTime')c.userEnded=true;if(field==='startTime')c.userStart=true;snapshot();}
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
$('review-gaps-selected').onclick=()=>{const c=selected();if(c)void reviewGap(c,openReviewGaps(c)[0]);};
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
$('scan-close').onclick=()=>{scanGeneration++;genderJob=null;$('scan-modal').classList.add('hidden');};
$('scan-women').onclick=async()=>{
  const btn=$('scan-women');if(btn.disabled)return;btn.disabled=true;
  try{
    const ok=await classifyScanGenders();
    if(ok&&!$('scan-modal').classList.contains('hidden')){applyWomenOnly();
      const men=scanResults.filter(tr=>tr.gender?.label==='man').length;
      toast(men?`${men} likely ${men===1?'man':'men'} set to Skip; everyone else stays covered. Check before applying.`:'No one was confidently identified as a man, so everyone stays covered.');}
  }finally{btn.disabled=false;}
};
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
$('whole-video').onclick=()=>{const c=selected();if(!c)return;c.startTime=0;c.endTime=project.video.duration;c.userEnded=false;c.userStart=false;snapshot();toast('Whole-video time range applied.');};
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
    help:`<p><strong>1.</strong> Open a local video or photo. <strong>2.</strong> Pause at the moment you want. Tap a person to load the AI detector, or choose “Draw new box” and drag on the video. <strong>3.</strong> Tap a person once: HalalFrame automatically follows them forwards and backwards through the complete clip. No extra Track button needed. <strong>4.</strong> Manual Draw boxes keep a short editable time range with optional position keyframes. <strong>5.</strong> Review the entire result before sharing.</p><p>Photo JPG/PNG export is included. Video MP4/audio output uses hardware WebCodecs when available and single-thread FFmpeg or WebM fallback, depending on browser support; check the result before sharing.</p>`
  };$('info-content').innerHTML=content[type];$('info-modal').classList.remove('hidden');}

function chosenExportOptions(){return {
  preset:$('export-preset').value,codec:$('export-codec').value,fps:$('export-fps').value,
  audioBitrate:$('export-audio-bitrate').value==='auto'?null:Number($('export-audio-bitrate').value),
  channels:$('export-channels').value,speed:$('export-speed').value,targetMB:Number($('export-target-mb').value)||16
};}
async function updateEncoderAvailability(){
  const supported=await supportedEncoderChoices({width:project?.video.width||1280,height:project?.video.height||720,fps:30});
  for(const option of $('export-codec').options){option.disabled=supported[option.value]===false;
    option.title=option.disabled?'This device has no compatible hardware/software WebCodecs encoder':'';}
  if($('export-codec').selectedOptions[0]?.disabled){$('export-codec').value='h264';toast('Selected codec unsupported on this device; H.264 selected.');}
  refreshEstimate();
}
function refreshEstimate(){
  if(!project||kind!=='video')return;
  const selected=chosenExportOptions();
  $('export-target-wrap').classList.toggle('hidden',selected.preset!=='fit');
  const est=estimateSize(project.video,selected.preset,{...selected,audioMode:audioPanel.mode});
  $('export-estimate').textContent=`${est.width}×${est.height} · max ${Math.round(est.fps)} fps · ${Math.round(est.bitRate/1000)} kbps video · estimated ${(est.bytes/1024/1024).toFixed(1)} MB${est.canFit?'':' · TARGET MAY NOT FIT'}. Actual size varies.`;
}
for(const id of ['export-preset','export-codec','export-fps','export-audio-bitrate','export-channels','export-target-mb','export-speed'])$(id).addEventListener('input',refreshEstimate);
// Export is a single guided workflow. Never make the user find Audio → Process
// or Track → hidden far down a phone's editor panel.
async function ensurePersonCoverage(){
  if(kind!=='video'||!project)return false;
  for(const c of [...project.concealments]){
    let attempts=0;
    while(needsFullTracking(c,project.video.duration)){
      const gaps=openReviewGaps(c);
      if(gaps.length){
        const gap=gaps[0];
        const choice=await requestDecision('coverage-block-modal',{
          detail:`${c.label} has ${gaps.length} uncertain interval(s), starting ${seconds(gap.from)}–${seconds(gap.to)}. This is not permission to blur another person. Review and resolve it, or end this cover before exporting.`,
          buttons:{'coverage-review':'review','coverage-mark':'mark','coverage-end':'end','coverage-finish':'finish','coverage-back':'back'}
        });
        if(choice==='back')return false;
        if(choice==='review'){
          const result=await reviewGap(c,gap);
          if(result==='back'||result==='draw'||result==='retap')return false;
          continue;
        }
        if(choice==='mark'){
          const confirmed=await markGapWithConfirmation(c,gap);
          if(!confirmed)return false;
          continue;
        }
        if(choice==='end'){finishCoverAtGap(c,gap);snapshot();continue;}
        if(choice==='finish'){
          // A new tracking pass cannot automatically prove a lost identity.
          // Keep the current gap available for review after the retry.
          if(++attempts>2)return false;
          await autoTrackPerson(c,{fromExport:true});continue;
        }
      }
      if(++attempts>3)return false;
      const choice=await requestDecision('coverage-block-modal',{
        detail:`${c.label} still needs a complete tracking pass. Finish following the selected person before export, or end the cover explicitly.`,
        buttons:{'coverage-finish':'finish','coverage-review':'review','coverage-mark':'mark','coverage-end':'end','coverage-back':'back'}
      });
      if(choice==='back')return false;
      if(choice==='finish'){await autoTrackPerson(c,{fromExport:true});continue;}
      if(choice==='end'){c.userEnded=true;c.endTime=Math.min(c.endTime,c.track.at(-1)?.t??c.endTime);snapshot();continue;}
      if(choice==='review'||choice==='mark'){
        const gap=openReviewGaps(c)[0];
        if(!gap){toast('No gap has been recorded. Choose Finish tracking or End cover here.');continue;}
        if(choice==='review')await reviewGap(c,gap);else await markGapWithConfirmation(c,gap);
        return false;
      }
    }
  }
  return true;
}
async function ensureCleanedAudioForExport(){
  if(audioPanel.mode!=='clean')return true;
  while(audioPanel.mode==='clean'&&!audioPanel.cleaned){
    if(audioPanel.busy){
      await requestDecision('audio-failed-modal',{
        detail:'Music removal is already processing in the Audio tab. Please wait for it to finish, then press Export again. You can also choose No audio.',
        buttons:{'audio-failed-silent':'silent','audio-failed-back':'back'}
      }).then(action=>{if(action==='silent')audioPanel.setMode('none');});
      return audioPanel.mode==='none';
    }
    const controller=beginBusy('Removing music…','Preparing on-device voice separation. Your video stays on your phone.');
    const cancel=()=>audioPanel.cancel();controller.signal.addEventListener('abort',cancel,{once:true});
    let ok=false;
    try{
      ok=await audioPanel.process({onProgress:(amount,label)=>{
        progress(.92*amount,amount>.88?`Checking for music… ${Math.round(amount*100)}%`:`Removing music… ${Math.round(amount*100)}% · ${label}`);
        $('busy-title').textContent=amount>.88?'Checking for music…':'Removing music…';
      }});
    }finally{controller.signal.removeEventListener('abort',cancel);endBusy();}
    if(ok&&audioPanel.cleaned)break;
    const problem=audioPanel.lastProcessError?.message||'The model was cancelled or returned no cleaned output.';
    const choice=await requestDecision('audio-failed-modal',{
      detail:`${problem} The original soundtrack will NOT silently replace cleaned speech. Retry, choose a completely silent export, or review in Audio.`,
      buttons:{'audio-failed-retry':'retry','audio-failed-silent':'silent','audio-failed-back':'back'}
    });
    if(choice==='retry')continue;
    if(choice==='silent'){audioPanel.setMode('none');return true;}
    audioPanel.tab('audio');return false;
  }
  const check=audioPanel.musicCheck;
  const riskCount=(check?.blocks||[]).filter(b=>b.state==='risk'||b.state==='caution').length;
  if(!check?.verified||riskCount){
    $('audio-risk-mute').disabled=!riskCount;
    const choice=await requestDecision('audio-risk-modal',{
      detail:check?.error?`${check.error}. Music verification is not available; we cannot label this audio clean. Choose No audio or explicitly accept the risk.`:
        `Music check using ${check?.modelUsed||'the selected model'} flagged ${riskCount} possible music/instrument section(s). Your options determine how much audio is retained. No AI can guarantee music is completely removed.`,
      buttons:{'audio-risk-mute':'mute','audio-risk-silent':'silent','audio-risk-anyway':'anyway','audio-risk-back':'back'}
    });
    $('audio-risk-mute').disabled=false;
    if(choice==='mute'){
      if(!riskCount){audioPanel.tab('audio');return false;}
      audioPanel.muteAllRisks();
      return true;
    }
    if(choice==='silent'){audioPanel.setMode('none');return true;}
    if(choice==='anyway')return true; // Explicit user choice, never an automatic "passed" state.
    audioPanel.tab('audio');return false;
  }
  return true;
}
function exportFileName(sourceName,format='mp4'){
  const root=(sourceName||'Video').replace(/\.[^.]+$/,'').replace(/[^a-zA-Z0-9_-]+/g,'_').replace(/^_+|_+$/g,'').slice(0,72)||'Video';
  const date=new Date(),day=[date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('-');
  return `HalalFrame_${root}_${day}.${format}`;
}
function renderRecentExports(){
  const container=$('recent-exports');container.replaceChildren();
  if(!recentExports.length){const label=document.createElement('span');label.className='dim';label.textContent='No exports yet.';container.append(label);return;}
  for(const entry of recentExports){
    const row=document.createElement('div');row.className='recent-export-row';
    const label=document.createElement('span');label.className='dim';label.textContent=`${entry.name} · ${(entry.blob.size/1048576).toFixed(1)} MB`;
    const actions=document.createElement('div');actions.className='recent-export-actions';
    const save=document.createElement('button');save.type='button';save.className='btn secondary small';save.textContent='Save again';save.onclick=()=>{downloadBlob(entry.blob,entry.name);toast('Download requested — look in Files → Downloads.');};
    const view=document.createElement('button');view.type='button';view.className='btn subtle small';view.textContent='View';view.onclick=()=>openResultSheet(entry,false);
    actions.append(save,view);row.append(label,actions);container.append(row);
  }
}
function rememberExport(result){
  const entry={...result,url:URL.createObjectURL(result.blob),createdAt:Date.now()};
  recentExports.unshift(entry);
  let total=recentExports.reduce((sum,r)=>sum+r.blob.size,0);
  while(recentExports.length>RECENT_LIMIT||total>300*1024*1024&&recentExports.length>1){
    const removed=recentExports.pop();total-=removed.blob.size;URL.revokeObjectURL(removed.url);
  }
  renderRecentExports();return entry;
}
function closeResultSheet(){
  $('export-success-player').pause();$('export-success-player').removeAttribute('src');$('export-success-player').load();
  $('export-success-modal').classList.add('hidden');
}
function openResultSheet(entry,autoSave=false){
  if(!entry)return;
  exportResult=entry;
  $('export-success-player').src=entry.url;
  $('export-success-title').textContent='Your edited video is ready';
  $('export-success-meta').textContent=`${entry.name} · ${(entry.blob.size/1048576).toFixed(1)} MB · ${entry.format.toUpperCase()}`;
  const iphone=/iPad|iPhone|iPod/i.test(navigator.userAgent);
  $('export-save-message').textContent=iphone?
    'On iPhone: tap Share to WhatsApp, then choose Save Video in the iOS share sheet.':
    'Your export is ready. Look in Files → Downloads after saving. Some browsers require a separate tap on Save to phone.';
  $('export-success-modal').classList.remove('hidden');
  if(autoSave&&!iphone&&!entry.autoDownloadRequested){
    entry.autoDownloadRequested=true; // never trigger a second automatic download
    try{
      downloadBlob(entry.blob,entry.name);
      $('export-save-message').textContent='Download requested automatically. Check Files → Downloads (or your browser Downloads). If you cannot find it, tap Save to phone below. The browser does not report whether it saved successfully.';
    }catch(error){
      $('export-save-message').textContent='Automatic save could not start: '+error.message+'. Tap Save to phone below.';
    }
  }
}
$('export-success-close').onclick=closeResultSheet;
$('export-done').onclick=closeResultSheet;
$('export-save-primary').onclick=()=>{if(!exportResult)return;downloadBlob(exportResult.blob,exportResult.name);
  $('export-save-message').textContent='Download requested. On Android check Files → Downloads; on iPhone use Share → Save Video. If the browser blocks the download, allow downloads for this site.';
};
$('export-share-whatsapp').onclick=async()=>{
  if(!exportResult)return;
  try{
    if(await shareBlob(exportResult.blob,exportResult.name)){
      $('export-save-message').textContent='Share sheet opened. Select WhatsApp, or use Save Video on iPhone.';
    }else $('export-save-message').textContent='This browser cannot share files directly. Tap Save to phone, then use Gallery/Files → Share → WhatsApp.';
  }catch(error){if(error.name!=='AbortError')$('export-save-message').textContent='Share failed: '+error.message+'. Save the file and share from Gallery/Files.';}
};
$('reopen-export').onclick=()=>openResultSheet(exportResult,false);
$('export-failed-back').onclick=()=>$('export-failed-modal').classList.add('hidden');
$('export-failed-retry').onclick=()=>{ $('export-failed-modal').classList.add('hidden');requestExportReview(performVideoExport); };
$('export-failed-copy').onclick=()=>$('copy-export-diagnostic').click();

async function performVideoExport(){
  if(kind!=='video'||!project||!sourceFile||busyController)return;
  // First prove that selected people have full-duration tracks. Failure is a
  // persistent modal with a retry action, not a brief toast.
  if(!(await ensurePersonCoverage()))return;
  if(!(await ensureCleanedAudioForExport()))return;
  let audioOptions;
  try{audioOptions=await audioPanel.exportOptions();}
  catch(error){
    await requestDecision('audio-failed-modal',{
      detail:error.message+' Please return to Audio and choose a valid soundtrack before exporting.',
      buttons:{'audio-failed-back':'back'}
    });audioPanel.tab('audio');return;
  }
  const options=chosenExportOptions();
  const controller=beginBusy('Encoding video…','Encoding sequentially on this device. Keep the app open.');
  const previousTime=currentTime();hiddenVideo.pause();$('export-result').classList.add('hidden');$('export-error').classList.add('hidden');
  const started=performance.now();
  try{
    const result=await exportVideo({file:sourceFile,project,maskCache,ai,...options,...audioOptions,signal:controller.signal,
      onProgress:(p,message)=>progress(p,`Encoding video… ${Math.round(p*100)}% · ${message}`),onStatus:message=>$('busy-copy').textContent=message});
    if(controller.signal.aborted)throw new DOMException('Cancelled','AbortError');
    // The extension matches the ACTUAL file format if the browser falls back.
    const name=exportFileName(project.video.fileName,result.format);
    const entry=rememberExport({...result,name});
    exportResult=entry;
    $('export-result').classList.remove('hidden');
    $('export-result-title').textContent=`${result.format.toUpperCase()} ready · ${(result.blob.size/1048576).toFixed(1)} MB · ${((performance.now()-started)/1000).toFixed(1)}s`;
    $('export-result-message').textContent=result.warning||`Edited video ready (${audioOptions.audioMode==='none'?'no sound':audioOptions.audioMode==='clean'?'AI-processed voice':'original soundtrack'}). Review the complete output before sharing.`;
    endBusy();openResultSheet(entry,true);
  }catch(e){
    if(e.name==='AbortError')toast('Export cancelled.');
    else{
      console.error(e);
      const code=e.code||'HF_EXPORT_FAILED';
      $('export-error').classList.remove('hidden');$('export-error-title').textContent='Export issue · '+code;
      $('export-error-copy').textContent=e.message+' Try WhatsApp 720p H.264, a shorter source video, or local conversion. Media stays on your device.';
      $('export-error-code').textContent=videoProbe?`${videoProbe.codec} · ${videoProbe.bitDepth}-bit · ${project.video.width}×${project.video.height}`:'Video codec not identified';
      lastDiagnostic=browserDiagnostics(sourceFile,videoProbe||project.video,{errorCode:code,cause:e.details?.cause||e.message,
        settings:options,elapsedSeconds:(performance.now()-started)/1000});
      $('export-failed-detail').textContent=`${code}: ${e.message} Your video is still loaded. You can try WhatsApp 720p H.264, check the audio mode, or copy diagnostics before retrying.`;
      $('export-failed-modal').classList.remove('hidden');
    }
  }finally{
    endBusy();if(Math.abs(previousTime-currentTime())>.03)void seekTo(previousTime).catch(()=>{});
  }
}
$('mp4-export').onclick=()=>{
  if(kind==='video'&&project&&sourceFile&&!busyController){
    requestExportReview(performVideoExport);
  }
};
$('download-video').onclick=()=>{if(exportResult)downloadBlob(exportResult.blob,exportResult.name);};
$('share-video').onclick=async()=>{
  if(!exportResult)return;
  try{if(!(await shareBlob(exportResult.blob,exportResult.name))){openResultSheet(exportResult,false);$('export-save-message').textContent='Sharing files is not supported in this browser. Tap Save to phone, then share from Gallery/Files.';}}
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
