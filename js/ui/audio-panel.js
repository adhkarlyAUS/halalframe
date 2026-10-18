// HalalFrame's on-device audio tab. No media is sent to any service.
import {MODELS,VAD_URL,DEMUCS,displayMB} from '../audio/models.js';
const $=id=>document.getElementById(id);
const AUDIO_CACHE='halalframe-audio-models-v1.5';
const MEDIA_LIMIT_SECONDS=120;
export class AudioPanel{
  constructor({getFile,getTime,getVideo,onChange=()=>{},toast=()=>{}}){
    Object.assign(this,{getFile,getTime,getVideo,onChange,toast});
    this.mode='original';this.quality='quick';this.mutedIntervals=[];this.cleaned=null;this.original=null;this._rejectJob=null;
    this.worker=null;this.verificationController=null;this.context=null;this.source=null;this.musicCheck=null;this.busy=false;this.cancelling=false;this.maxProgress=0;
    this.bind();this.updateUI();
  }
  bind(){
    $('tab-visual').addEventListener('click',()=>this.tab('visual'));
    $('tab-audio').addEventListener('click',()=>this.tab('audio'));
    $('audio-mode').addEventListener('change',e=>{this.setMode(e.target.value);});
    $('audio-quality').addEventListener('change',e=>{this.quality=e.target.value;this.cleaned=null;this.musicCheck=null;this.stopPreview();this.updateUI();this.checkCache();});
    $('audio-strength').addEventListener('input',e=>{$('audio-strength-label').textContent=['Gentle','Strong','Maximum'][Number(e.target.value)]||'Strong';this.cleaned=null;this.musicCheck=null;this.updateUI();});
    $('audio-strict').addEventListener('change',()=>{this.cleaned=null;this.musicCheck=null;this.updateUI();});
    $('audio-process').addEventListener('click',()=>this.process());
    $('audio-cancel').addEventListener('click',()=>this.cancel());
    $('audio-preview-original').addEventListener('click',()=>this.preview('original'));
    $('audio-preview-clean').addEventListener('click',()=>this.preview('clean'));
    $('audio-preview-stop').addEventListener('click',()=>this.stopPreview());
    $('audio-add-mute').addEventListener('click',()=>this.addMuteRange());
    $('audio-clear-mutes').addEventListener('click',()=>{this.mutedIntervals=[];this.updateMuteUI();this.onChange();});
    $('audio-mute-risk').addEventListener('click',()=>this.muteAllRisks());
  }
  tab(which){
    const audio=which==='audio';$('tab-visual').classList.toggle('active',!audio);$('tab-audio').classList.toggle('active',audio);
    $('tab-visual').setAttribute('aria-selected',String(!audio));$('tab-audio').setAttribute('aria-selected',String(audio));
    for(const card of document.querySelectorAll('[data-visual-settings]'))card.classList.toggle('hidden',audio);
    $('audio-panel').classList.toggle('hidden',!audio);
    if(!audio)this.stopPreview();
  }
  reset(enabled){
    this.cancel();this.stopPreview();this.cleaned=null;this.original=null;this.musicCheck=null;this.mutedIntervals=[];this.mode='original';this.quality='quick';
    $('audio-mode').value='original';$('audio-quality').value='quick';$('audio-strength').value='1';$('audio-strict').checked=false;
    $('tab-audio').disabled=!enabled;
    if(!enabled)this.tab('visual');
    const video=this.getVideo();if(video)video.muted=false;
    this.updateUI();this.updateMuteUI();this.checkCache();
  }
  setMode(mode){
    if(!['original','none','clean'].includes(mode))return;
    this.mode=mode;
    this.stopPreview();
    const video=this.getVideo();if(video)video.muted=mode!=='original';
    this.updateUI();this.onChange();
  }
  updateUI(){
    const active=this.mode==='clean';$('audio-clean-settings').classList.toggle('hidden',!active);
    $('audio-process').disabled=this.busy;
    $('audio-process').textContent=this.cleaned?'Reprocess cleaned audio':'Download model & clean audio';
    $('audio-cancel').classList.toggle('hidden',!this.busy);
    $('audio-preview-original').disabled=!this.getFile();
    $('audio-preview-clean').disabled=!this.cleaned;
    $('audio-preview-stop').disabled=!this.source;
    const report=$('music-report');if(report)report.classList.toggle('hidden',!this.musicCheck||!active);
    const desc=this.mode==='original'?'Original sound is kept.':this.mode==='none'?'Completely silent MP4; no audio track is added.':this.cleaned?(this.musicCheck?.verified?'Voice processed · no flagged classifier segments. Listen carefully.':'Voice processed · music check unverified or possible music remains. Review before export.'):'Process and verify voice first. No audio is always the safest option.';
    $('audio-summary').textContent=desc;
    $('export-audio-summary').textContent=this.mode==='original'?'Audio: Original':this.mode==='none'?'Audio: None (silent)':'Audio: Voice processed'+(this.cleaned?(this.musicCheck?.verified?' · classifier check passed':' · music check incomplete'):' · process first');
    if(this.mode==='clean')$('audio-model-size').textContent=this.quality==='quick'?'First download: Silero 2.3 MB + Quick model 29.7 MB.':this.quality==='studio'?'Studio experimental: 181 MB HTDemucs; high memory, may be unsupported on GitHub Pages.':'First download: Silero 2.3 MB + Best model 66.8 MB. Higher memory use; slower on phones.';
    this.onChange();
  }
  async checkCache(){
    try{
      const c=await caches.open(AUDIO_CACHE);
      const vad=!!await c.match(VAD_URL),model=!!await c.match(this.quality==='studio'?DEMUCS.url:MODELS[this.quality].url);
      $('audio-cache').textContent=vad&&model?'Models downloaded for offline use ✓':vad?'Voice detector cached · separator needs first download':'Models download once after you tap Process';
    }catch{$('audio-cache').textContent='Browser storage unavailable — internet may be required';}
  }
  async decode(){
    if(this.original)return this.original;
    const file=this.getFile();if(!file)throw new Error('Choose a video first.');
    const context=new (window.AudioContext||window.webkitAudioContext)();
    try{this.original=await context.decodeAudioData(await file.arrayBuffer());}
    finally{await context.close();}
    if(!this.original.numberOfChannels)throw new Error('The video has no decodable audio. Choose No audio.');
    return this.original;
  }
  async process({onProgress=()=>{}}={}){
    if(this.busy)return false;
    this.mode='clean';$('audio-mode').value='clean';this.busy=true;this.cleaned=null;this.musicCheck=null;this.lastProcessError=null;this.maxProgress=0;this.stopPreview();this.updateUI();
    onProgress(0,'Removing music · starting on-device processing…');
    const since=performance.now();
    let retryBest=false;
    try{
      const original=await this.decode();
      if(original.duration>MEDIA_LIMIT_SECONDS)throw new Error(`On-device music cleaning is limited to ${MEDIA_LIMIT_SECONDS} seconds to protect phone memory. You can still use Keep original or No audio for longer videos.`);
      const ch=[];for(let i=0;i<Math.min(2,original.numberOfChannels);i++)ch.push(new Float32Array(original.getChannelData(i)).buffer);
      const transfer=ch.slice();
      const worker=new Worker(new URL('../audio/music-worker.js?v='+window.APP_VERSION,import.meta.url),{type:'module'});
      this.worker=worker;this.busy=true;this.updateUI();
      const job=crypto.randomUUID();
      $('audio-progress-wrap').classList.remove('hidden');
      $('audio-progress').style.width='0%';
      $('audio-progress-text').textContent='Starting private audio worker…';
      const output=await new Promise((resolve,reject)=>{
        let settled=false,started=false,watchdog=null;
        const stopTimer=()=>{if(watchdog!==null){clearTimeout(watchdog);watchdog=null;}};
        const fail=error=>{if(settled)return;settled=true;stopTimer();reject(error);};
        const finish=value=>{if(settled)return;settled=true;stopTimer();resolve(value);};
        const armTimer=()=>{
          stopTimer();
          watchdog=setTimeout(()=>fail(new Error(
            started?'No audio-processing progress for 30 seconds. The model may be out of memory or the browser may be stalled. Try Quick, a shorter clip, or No audio.':
              'Audio worker did not start within 30 seconds. Reload while online and try again.'
          )),30000);
        };
        // Cancel uses the same rejection path, ensuring the watchdog is cleared.
        this._rejectJob=fail;
        worker.onmessage=e=>{
          if(settled)return;
          const d=e.data;
          if(d?.type==='ready'&&!started){
            // The worker registered its handler and finished module evaluation.
            // Transfer input buffers ONLY after this acknowledgement.
            started=true;armTimer();
            $('audio-progress-text').textContent='Worker ready · preparing models on this device…';onProgress(.03,'Removing music · preparing models…');
            try{worker.postMessage({type:'process',job,channels:ch,sampleRate:original.sampleRate,
              quality:this.quality,strength:['gentle','strong','maximum'][Number($('audio-strength').value)]||'strong',strict:$('audio-strict').checked},transfer);
            }catch(error){fail(new Error('Could not send audio to local worker: '+error.message));}
            return;
          }
          if(d?.job!==job||!started)return;
          if(d.type==='progress'){
            armTimer(); // Download/inference can be slow; require ongoing progress.
            const part=Math.max(0,Math.min(1,d.ratio||0));
            // Stage ratios restart on each model. Show ONE monotonic job total.
            const vadModel=d.stage==='models'&&/Silero|voice detector/i.test(d.detail||'');
            const stageFraction=d.stage==='music-check'?.96+.035*part:d.stage==='models'?(vadModel?.02+.13*part:.27+.15*part):
              d.stage==='vad'?.15+.12*part:d.stage==='separate'?.42+.54*part:
              d.stage==='refine'?.96+.039*part:0;
            this.maxProgress=Math.max(this.maxProgress,stageFraction);
            $('audio-progress-wrap').classList.remove('hidden');
            $('audio-progress').style.width=(100*this.maxProgress).toFixed(1)+'%';
            const secondsElapsed=(performance.now()-since)/1000;
            const eta=this.maxProgress>.12?Math.ceil((secondsElapsed/this.maxProgress)*(1-this.maxProgress)):null;
            $('audio-progress-text').textContent=`${d.detail||d.stage}${eta===null?'':` · ~${eta}s left`}`;
            onProgress(Math.min(.88,this.maxProgress*.88),'Removing music · '+(d.detail||d.stage));
          }else if(d.type==='delegate'){
            armTimer();$('audio-backend').textContent='Audio AI: '+d.delegate;
          }else if(d.type==='complete')finish(d);
          else if(d.type==='error')fail(new Error(d.message));
        };
        worker.onerror=e=>{e.preventDefault?.();fail(new Error(`Audio worker failed: ${e.message||'Unknown module or runtime error'}`));};
        worker.onmessageerror=()=>fail(new Error('Audio worker sent a message the browser could not decode. Try again or select No audio.'));
        armTimer(); // Also cover the period before the ready handshake.
      });
      // Release the large ONNX worker before MediaPipe AudioClassifier loads.
      this.worker?.terminate();this.worker=null;
      let decoded=output.channels.map(b=>new Float32Array(b));
      if(output.studioWarning){
        this.quality='best';$('audio-quality').value='best';
        this.toast(output.studioWarning);
      }
      this.verificationController=new AbortController();
      const originalChannels=Array.from({length:Math.min(2,original.numberOfChannels)},(_,i)=>original.getChannelData(i));
      try{
        $('audio-progress-text').textContent='Music check · loading YAMNet on this device…';onProgress(.90,'Checking for music · loading YAMNet…');
        $('audio-progress').style.width='97%';
        const {verifyMusic,smoothRiskGate}=await import('../audio/music-check.js?v='+window.APP_VERSION);
        const verify=async()=>verifyMusic({original:originalChannels,cleaned:decoded,rate:original.sampleRate,
          strict:$('audio-strict').checked,signal:this.verificationController.signal,
          onProgress:f=>{$('audio-progress-text').textContent=`Music check · ${Math.round(f*100)}% of audio analysed`;
            $('audio-progress').style.width=(97+f*2).toFixed(1)+'%';onProgress(.90+.09*f,'Checking for music · '+Math.round(f*100)+'%');}});
        this.musicCheck=await verify();
        const strict=$('audio-strict').checked;
        const risk=(this.musicCheck.blocks||[]).filter(b=>b.state==='risk'&&(strict||b.speech<.34));
        if(risk.length){
          decoded=smoothRiskGate(decoded,original.sampleRate,risk);
          $('audio-progress-text').textContent=`Muted ${risk.length} suspicious interval(s). Rechecking…`;
          this.musicCheck=await verify();this.musicCheck.extraMuted=risk.length;
        }
      }catch(error){
        if(error.name==='AbortError')throw error;
        this.musicCheck={verified:false,remainingRisk:null,
          blocks:[{start:0,end:original.duration,before:0,after:1,speech:0,state:'risk'}],
          error:'YAMNet on-device check unavailable: '+error.message};
      }finally{this.verificationController=null;}
      // Attribute this report to the ACTUAL model run, not the dropdown. Studio
      // may automatically fall back to Best, and the report must say so.
      const actualModel=output.model==='studio'?DEMUCS.name:(MODELS[output.model]?.name||String(output.model||'Unknown'));
      this.musicCheck.modelUsed=actualModel;
      this.musicCheck.strength=['Gentle','Strong','Maximum'][Number($('audio-strength').value)]||'Strong';
      const result=new AudioBuffer({numberOfChannels:decoded.length,length:decoded[0].length,sampleRate:output.sampleRate});
      decoded.forEach((ch,index)=>result.copyToChannel(ch,index));
      this.cleaned=result;
      this.showMusicReport();
      const qualityNote=output.studioWarning?' · Studio fell back to Best':'';
      $('audio-progress-text').textContent=`${actualModel} · ${this.musicCheck.strength} · speech ${output.speechPercent}% · Music check ${this.musicCheck.verified?'passed':'needs review'}${qualityNote}`;
      $('audio-progress').style.width='100%';this.toast('Audio ready. Listen to A/B preview and inspect the music-risk strip.');
      this.checkCache();onProgress(1,'Checking for music · report ready');
    }catch(e){
      this.cleaned=null;this.musicCheck=null;this.lastProcessError=e;
      if(!this.cancelling&&this.quality==='studio'){
        retryBest=true;this.quality='best';$('audio-quality').value='best';
        this.toast('Studio timed out or failed; automatically trying Best MDX-Net. '+e.message);
        $('audio-progress-text').textContent='Studio unavailable · automatically switching to Best…';
      }else if(!this.cancelling){this.toast('Audio cleaning could not finish: '+e.message);$('audio-progress-text').textContent=e.message;}
    }finally{
      this.worker?.terminate();this.worker=null;this._rejectJob=null;this.busy=false;this.cancelling=false;this.updateUI();
    }
    // The caller can await Studio → Best fallback; do not defer it to a microtask.
    if(retryBest)return await this.process({onProgress});
    return !!this.cleaned;
  }
  cancel(){
    this.verificationController?.abort();
    if(this.worker){this.cancelling=true;this.worker.terminate();this.worker=null;this._rejectJob?.(new DOMException('Audio processing cancelled','AbortError'));this._rejectJob=null;}
    this.busy=false;$('audio-progress-text').textContent='Processing cancelled; no cleaned output was saved.';
    this.updateUI();
  }
  async preview(mode){
    this.stopPreview();try{
      const raw=mode==='clean'?this.cleaned:await this.decode();
      const sound=this.mutedIntervals.length&&raw?this.applyMutes(raw):raw;
      if(!sound)throw new Error('Process cleaned audio first.');
      const video=this.getVideo();video?.pause();
      const time=Math.max(0,Math.min(sound.duration-.01,this.getTime()||0));
      this.context=new (window.AudioContext||window.webkitAudioContext)();await this.context.resume();
      this.source=this.context.createBufferSource();this.source.buffer=sound;
      this.source.connect(this.context.destination);
      this.source.onended=()=>{this.source=null;void this.context?.close().catch(()=>{});this.context=null;this.updateUI();};
      this.source.start(0,time,Math.min(5,sound.duration-time));
      $('audio-preview-status').textContent=`Playing ${mode==='clean'?'cleaned voice':'original'} from ${time.toFixed(1)} s (5-second A/B preview)`;
      this.updateUI();
    }catch(e){this.toast('Preview failed: '+e.message);}
  }
  stopPreview(){
    if(this.source){this.source.onended=null;try{this.source.stop();}catch{}this.source.disconnect();this.source=null;}
    if(this.context){void this.context.close().catch(()=>{});this.context=null;}
    if($('audio-preview-status'))$('audio-preview-status').textContent='Tap Original or Cleaned to hear five seconds from your playhead.';
    if($('audio-preview-stop'))$('audio-preview-stop').disabled=true;
  }
  showMusicReport(){
    const report=$('music-report'),strip=$('music-report-strip'),description=$('music-report-description');
    if(!report||!strip||!description||typeof strip.replaceChildren!=='function')return;
    report.classList.toggle('hidden',!this.musicCheck);strip.replaceChildren();
    const check=this.musicCheck;if(!check)return;
    const modelLabel=`Model used: ${check.modelUsed||'Unknown'}${check.strength?' · '+check.strength:''}. `;
    description.textContent=modelLabel+(check.error?'Music check unavailable: '+check.error:
      check.verified?'No music/instrument intervals flagged at the current conservative thresholds. NOT a guarantee.':
      `${check.remainingRisk||0} red + ${check.remainingCaution||0} amber interval(s). Amber = possible instruments beneath speech; review manually or choose No audio.`);
    $('audio-mute-risk').disabled=!(check.blocks||[]).some(b=>b.state==='risk'||b.state==='caution');
    for(const item of check.blocks||[]){const segment=document.createElement('button');segment.type='button';
      segment.className='music-check-segment '+item.state;segment.style.flex=String(Math.max(.2,item.end-item.start));
      segment.title=`${item.start.toFixed(1)}–${item.end.toFixed(1)}s · Original music ${(100*item.before).toFixed(0)}% · Remaining ${(100*item.after).toFixed(0)}% · Instrument ${(100*(item.instrument||0)).toFixed(0)}%`;
      segment.onclick=()=>{const video=this.getVideo();if(video){video.currentTime=item.start;video.pause();}this.preview('clean');};
      strip.append(segment);
    }
  }
  updateMuteUI(){
    $('audio-manual-mutes').textContent=this.mutedIntervals.length?
      `Muted sections: ${this.mutedIntervals.map(x=>x.start.toFixed(1)+'–'+x.end.toFixed(1)+'s').join(', ')}`:
      'No muted sections selected.';
  }
  addMuteRange(){
    const start=Number($('audio-mute-start').value),end=Number($('audio-mute-end').value);
    if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start){this.toast('Choose a valid start and end time for your mute.');return;}
    this.mutedIntervals.push({start,end});this.mutedIntervals.sort((a,b)=>a.start-b.start);
    this.updateMuteUI();this.onChange();this.toast(`Audio will be muted from ${start.toFixed(1)}–${end.toFixed(1)} seconds.`);
  }
  muteAllRisks(){
    if(!this.musicCheck?.blocks?.length){this.toast('Process audio and run Music check first.');return;}
    const marked=this.musicCheck.blocks.filter(b=>b.state==='risk'||b.state==='caution').map(b=>({start:b.start,end:b.end}));
    if(!marked.length){this.toast('No amber/red music-check sections to mute.');return;}
    this.mutedIntervals.push(...marked);this.mutedIntervals.sort((a,b)=>a.start-b.start);
    this.updateMuteUI();this.onChange();this.toast(`Muted ${marked.length} flagged music section(s) in the export.`);
  }
  applyMutes(raw){
    if(!raw||!this.mutedIntervals.length)return raw;
    const result=new AudioBuffer({sampleRate:raw.sampleRate,length:raw.length,numberOfChannels:raw.numberOfChannels});
    const fade=Math.max(1,Math.round(raw.sampleRate*.025));
    for(let c=0;c<raw.numberOfChannels;c++){
      const data=new Float32Array(raw.getChannelData(c));
      for(const {start,end} of this.mutedIntervals){
        const lo=Math.max(0,Math.min(data.length,Math.floor(start*raw.sampleRate)));
        const hi=Math.max(lo,Math.min(data.length,Math.ceil(end*raw.sampleRate)));
        for(let i=Math.max(0,lo-fade);i<lo;i++)data[i]*=(lo-i)/fade;
        data.fill(0,lo,hi);
        for(let i=hi;i<Math.min(data.length,hi+fade);i++)data[i]*=(i-hi)/fade;
      }
      result.copyToChannel(data,c);
    }
    return result;
  }
  async exportOptions(){
    if(this.mode==='clean'&&!this.cleaned)throw new Error('Cleaned audio is not ready. Process it first, or choose No audio.');
    if(this.mode==='none')return {audioMode:'none',cleanedAudio:null,musicCheck:this.musicCheck};
    if(!this.mutedIntervals.length)return {audioMode:this.mode,cleanedAudio:this.cleaned,musicCheck:this.musicCheck};
    const original=this.mode==='clean'?this.cleaned:await this.decode();
    // An edited original soundtrack is sent through the local PCM/AAC path;
    // it is never copied from the unedited file by FFmpeg on export.
    return {audioMode:'clean',cleanedAudio:this.applyMutes(original),musicCheck:this.musicCheck};
  }

}
