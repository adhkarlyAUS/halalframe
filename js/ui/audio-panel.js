// HalalFrame's on-device audio tab. No media is sent to any service.
import {MODELS,VAD_URL,displayMB} from '../audio/models.js';
const $=id=>document.getElementById(id);
const AUDIO_CACHE='halalframe-audio-models-v1.5';
const MEDIA_LIMIT_SECONDS=120;
export class AudioPanel{
  constructor({getFile,getTime,getVideo,onChange=()=>{},toast=()=>{}}){
    Object.assign(this,{getFile,getTime,getVideo,onChange,toast});
    this.mode='original';this.quality='quick';this.cleaned=null;this.original=null;this._rejectJob=null;
    this.worker=null;this.context=null;this.source=null;this.busy=false;this.cancelling=false;this.maxProgress=0;
    this.bind();this.updateUI();
  }
  bind(){
    $('tab-visual').addEventListener('click',()=>this.tab('visual'));
    $('tab-audio').addEventListener('click',()=>this.tab('audio'));
    $('audio-mode').addEventListener('change',e=>{this.setMode(e.target.value);});
    $('audio-quality').addEventListener('change',e=>{this.quality=e.target.value;this.cleaned=null;this.stopPreview();this.updateUI();this.checkCache();});
    $('audio-strength').addEventListener('input',e=>{$('audio-strength-label').textContent=['Gentle','Strong','Maximum'][Number(e.target.value)]||'Strong';this.cleaned=null;this.updateUI();});
    $('audio-strict').addEventListener('change',()=>{this.cleaned=null;this.updateUI();});
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
    this.cancel();this.stopPreview();this.cleaned=null;this.original=null;this.mode='original';this.quality='quick';
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
    const desc=this.mode==='original'?'Original sound is kept.':this.mode==='none'?'Completely silent MP4; no audio track is added.':this.cleaned?'Cleaned-audio preview ready. Listen carefully before export.':'Clean audio first. Export will be blocked until processing succeeds.';
    $('audio-summary').textContent=desc;
    $('export-audio-summary').textContent=this.mode==='original'?'Audio: Original':this.mode==='none'?'Audio: None (silent)':'Audio: Cleaned voice'+(this.cleaned?' · ready':' · process first');
    if(this.mode==='clean')$('audio-model-size').textContent=this.quality==='quick'?'First download: Silero 2.3 MB + Quick model 29.7 MB.':'First download: Silero 2.3 MB + Best model 66.8 MB. Higher memory use; slower on phones.';
    this.onChange();
  }
  async checkCache(){
    try{
      const c=await caches.open(AUDIO_CACHE);
      const vad=!!await c.match(VAD_URL),model=!!await c.match(MODELS[this.quality].url);
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
    this.mode='clean';$('audio-mode').value='clean';this.busy=true;this.cleaned=null;this.maxProgress=0;this.stopPreview();this.updateUI();
    const since=performance.now();
    try{
      const original=await this.decode();
      if(original.duration>MEDIA_LIMIT_SECONDS)throw new Error(`On-device music cleaning is limited to ${MEDIA_LIMIT_SECONDS} seconds to protect phone memory. You can still use Keep original or No audio for longer videos.`);
      const ch=[];for(let i=0;i<Math.min(2,original.numberOfChannels);i++)ch.push(new Float32Array(original.getChannelData(i)).buffer);
      const transfer=ch.slice();
      const worker=new Worker(new URL('../audio/music-worker.js?v='+window.APP_VERSION,import.meta.url),{type:'module'});
      this.worker=worker;this.busy=true;this.updateUI();
      const job=crypto.randomUUID();
      const output=await new Promise((resolve,reject)=>{
        this._rejectJob=reject;
        worker.onmessage=e=>{
          const d=e.data;if(d?.job!==job)return;
          if(d.type==='progress'){
            const part=Math.max(0,Math.min(1,d.ratio||0));
            // Stage ratios restart on each model. Show ONE monotonic job total,
            // so the progress bar never jumps from 100% back to 1%.
            const vadModel=d.stage==='models'&&/Silero|voice detector/i.test(d.detail||'');
            const stageFraction=d.stage==='models'?(vadModel?.02+.13*part:.27+.15*part):
              d.stage==='vad'?.15+.12*part:d.stage==='separate'?.42+.56*part:0;
            this.maxProgress=Math.max(this.maxProgress,stageFraction);
            $('audio-progress-wrap').classList.remove('hidden');$('audio-progress').style.width=(100*this.maxProgress).toFixed(1)+'%';
            const secondsElapsed=(performance.now()-since)/1000;
            const eta=this.maxProgress>.12?Math.ceil((secondsElapsed/this.maxProgress)*(1-this.maxProgress)):null;
            $('audio-progress-text').textContent=`${d.detail||d.stage}${eta===null?'':` · ~${eta}s left`}`;
          }else if(d.type==='delegate'){$('audio-backend').textContent='Audio AI: '+d.delegate;}
          else if(d.type==='complete')resolve(d);
          else if(d.type==='error')reject(new Error(d.message));
        };
        worker.onerror=e=>reject(new Error(`Audio worker failed: ${e.message}`));
        worker.postMessage({type:'process',job,channels:ch,sampleRate:original.sampleRate,
          quality:this.quality,strength:['gentle','strong','maximum'][Number($('audio-strength').value)]||'strong',strict:$('audio-strict').checked},transfer);
      });
      const decoded=output.channels.map(b=>new Float32Array(b));
      const result=new AudioBuffer({numberOfChannels:decoded.length,length:decoded[0].length,sampleRate:output.sampleRate});
      decoded.forEach((ch,index)=>result.copyToChannel(ch,index));
      this.cleaned=result;
      $('audio-progress-text').textContent=`Cleaned ${(result.duration).toFixed(1)}s · speech detected ${output.speechPercent}% · listen before sharing`;
      $('audio-progress').style.width='100%';this.toast('Cleaned audio ready. Compare Original and Cleaned before exporting.');
      this.checkCache();
    }catch(e){
      this.cleaned=null;
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
  exportOptions(){
    if(this.mode==='clean'&&!this.cleaned)throw new Error('Cleaned audio is not ready. Process it first, or choose No audio.');
    return {audioMode:this.mode,cleanedAudio:this.cleaned};
  }
}
