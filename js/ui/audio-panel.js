// HalalFrame's on-device audio tab. No media is sent to any service.
import {MODELS,VAD_URL,DEMUCS,displayMB} from '../audio/models.js';
const $=id=>document.getElementById(id);
const AUDIO_CACHE='halalframe-audio-models-v1.5';
const MEDIA_LIMIT_SECONDS=120;
export class AudioPanel{
  constructor({getFile,getTime,getVideo,onChange=()=>{},toast=()=>{}}){
    Object.assign(this,{getFile,getTime,getVideo,onChange,toast});
    this.mode='original';this.quality='quick';this.cleaned=null;this.original=null;this._rejectJob=null;
    this.worker=null;this.context=null;this.source=null;this.musicCheck=null;this.busy=false;this.cancelling=false;this.maxProgress=0;
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
  }
  tab(which){
    const audio=which==='audio';$('tab-visual').classList.toggle('active',!audio);$('tab-audio').classList.toggle('active',audio);
    $('tab-visual').setAttribute('aria-selected',String(!audio));$('tab-audio').setAttribute('aria-selected',String(audio));
    for(const card of document.querySelectorAll('[data-visual-settings]'))card.classList.toggle('hidden',audio);
    $('audio-panel').classList.toggle('hidden',!audio);
    if(!audio)this.stopPreview();
  }
  reset(enabled){
    this.cancel();this.stopPreview();this.cleaned=null;this.original=null;this.musicCheck=null;this.mode='original';this.quality='quick';
    $('audio-mode').value='original';$('audio-quality').value='quick';$('audio-strength').value='1';$('audio-strict').checked=false;
    $('tab-audio').disabled=!enabled;
    if(!enabled)this.tab('visual');
    const video=this.getVideo();if(video)video.muted=false;
    this.updateUI();this.checkCache();
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
    const desc=this.mode==='original'?'Original sound is kept.':this.mode==='none'?'Completely silent MP4; no audio track is added.':this.cleaned?(this.musicCheck?.verified?'Voice processed · no high-confidence music found by classifier. Listen carefully.':'Voice processed · music check unverified or possible music remains. Review before export.'):'Process and verify voice first. No audio is always the safest option.';
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
  async process(){
    if(this.busy)return;
    this.mode='clean';$('audio-mode').value='clean';this.busy=true;this.cleaned=null;this.musicCheck=null;this.maxProgress=0;this.stopPreview();this.updateUI();
    const since=performance.now();
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
            $('audio-progress-text').textContent='Worker ready · preparing models on this device…';
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
          }else if(d.type==='delegate'){
            armTimer();$('audio-backend').textContent='Audio AI: '+d.delegate;
          }else if(d.type==='complete')finish(d);
          else if(d.type==='error')fail(new Error(d.message));
        };
        worker.onerror=e=>{e.preventDefault?.();fail(new Error(`Audio worker failed: ${e.message||'Unknown module or runtime error'}`));};
        worker.onmessageerror=()=>fail(new Error('Audio worker sent a message the browser could not decode. Try again or select No audio.'));
        armTimer(); // Also cover the period before the ready handshake.
      });
      const decoded=output.channels.map(b=>new Float32Array(b));
      const result=new AudioBuffer({numberOfChannels:decoded.length,length:decoded[0].length,sampleRate:output.sampleRate});
      decoded.forEach((ch,index)=>result.copyToChannel(ch,index));
      this.cleaned=result;
      this.musicCheck=output.musicCheck||{verified:false,blocks:[],error:'No independent music verification'};
      this.showMusicReport();
      $('audio-progress-text').textContent=`Voice processed ${result.duration.toFixed(1)}s · speech ${output.speechPercent}% · Music check ${this.musicCheck.verified?'passed':'needs your review'}`;
      $('audio-progress').style.width='100%';this.toast('Cleaned audio ready. Compare Original and Cleaned before exporting.');
      this.checkCache();
    }catch(e){
      this.cleaned=null;this.musicCheck=null;
      if(!this.cancelling){this.toast('Audio cleaning could not finish: '+e.message);$('audio-progress-text').textContent=e.message;}
    }finally{
      this.worker?.terminate();this.worker=null;this._rejectJob=null;this.busy=false;this.cancelling=false;this.updateUI();
    }
  }
  cancel(){
    if(this.worker){this.cancelling=true;this.worker.terminate();this.worker=null;this._rejectJob?.(new DOMException('Audio processing cancelled','AbortError'));this._rejectJob=null;}
    this.busy=false;$('audio-progress-text').textContent='Processing cancelled; no cleaned output was saved.';
    this.updateUI();
  }
  async preview(mode){
    this.stopPreview();try{
      const sound=mode==='clean'?this.cleaned:await this.decode();
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
    description.textContent=check.error?'Music check unavailable: '+check.error:
      check.verified?'No high-confidence music/instrument segments detected after processing. This is NOT a guarantee.':
      `${check.remainingRisk} interval(s) remain suspicious. Red = possible music under speech. Listen before exporting or choose No audio.`;
    for(const item of check.blocks||[]){const segment=document.createElement('button');segment.type='button';
      segment.className='music-check-segment '+item.state;segment.style.flex=String(Math.max(.2,item.end-item.start));
      segment.title=`${item.start.toFixed(1)}–${item.end.toFixed(1)}s · Original music ${(100*item.before).toFixed(0)}% · Remaining ${(100*item.after).toFixed(0)}%`;
      segment.onclick=()=>{const video=this.getVideo();if(video){video.currentTime=item.start;video.pause();}this.preview('clean');};
      strip.append(segment);
    }
  }
  exportOptions(){
    if(this.mode==='clean'&&!this.cleaned)throw new Error('Cleaned audio is not ready. Process it first, or choose No audio.');
    return {audioMode:this.mode,cleanedAudio:this.cleaned,musicCheck:this.musicCheck};
  }
}
