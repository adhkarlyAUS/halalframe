// HalalFrame first-run gate and export acknowledgement. No backend or sign-in.
// The app stays inert until the user accepts the safety disclaimer.
const AGREEMENT_KEY='halalframe-disclaimer-accepted-v1';
const $=id=>document.getElementById(id);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const SLIDES=[
  {label:'WELCOME',symbol:'',title:'Welcome to HalalFrame',description:'A simple, private way to conceal people and regions in photos and videos.'},
  {label:'HOW IT WORKS',symbol:'steps',title:'Tap a person. Track. Export.',description:'Tap a person, track their movement, review the timeline, then export. All three steps are shown below.'},
  {label:'YOUR PRIVACY',symbol:'privacy',title:'Everything stays on your phone',description:'No sign-in, no server and no uploaded media. Your videos and photos are processed in your browser. AI model files download on the first run.'},
  {label:'IMPORTANT DISCLAIMER',symbol:'!',title:'Before you begin',description:'Please understand the limitations of automatic concealment.'}
];
export function initFirstRun({initAI=async()=>{},onAIReady=()=>{},onReady=()=>{}}={}){
  let step=0,review=false,accessGranted=false,gateFinished=false;
  const shell=()=>[document.querySelector('header.topbar'),document.querySelector('main')].filter(Boolean);
  const accepted=()=>{if(accessGranted)return true;try{return localStorage.getItem(AGREEMENT_KEY)==='yes';}catch{return false;}};
  function setGate(enabled){document.documentElement.classList.toggle('hf-gated',enabled);shell().forEach(el=>el.inert=enabled);document.body.classList.toggle('hf-locked',enabled);}
  function finish(){
    if(gateFinished)return;
    gateFinished=true;accessGranted=true;setGate(false);$('onboarding').classList.add('hidden');
    onReady();
  }
  function showSlide(index){
    step=Math.max(0,Math.min(SLIDES.length-1,index));
    const data=SLIDES[step];
    $('onboarding').querySelector('.onboarding-panel').classList.toggle('step-welcome',step===0);
    $('onboard-step-label').textContent=`${data.label} · ${step+1} OF 4`;
    $('onboard-title').textContent=data.title;
    const visual=$('onboard-visual');visual.replaceChildren();visual.classList.toggle('is-steps',step===1);visual.classList.toggle('hidden',step===0||step===3);
    if(step===1){
      for(const [file,alt] of [['tap-person.svg','Tap a person'],['track-person.svg','Track their movement'],['export-video.svg','Export and share']]){
        const card=document.createElement('figure');card.className='onboard-step-card';
        const img=document.createElement('img');img.src='assets/onboarding/'+file;img.alt=alt;img.className='onboard-illustration';
        const label=document.createElement('figcaption');label.textContent=alt;card.append(img,label);visual.append(card);
      }
    }else if(step===2){
      const shield=document.createElement('img');shield.src='assets/onboarding/privacy-shield.svg';
      shield.alt='A phone protected by a shield and padlock';shield.className='onboard-privacy-illustration';visual.append(shield);
    }
    
    $('onboard-description').textContent=data.description;
    if(step===1)visual.scrollLeft=0;
    $('onboard-disclaimer').classList.toggle('hidden',step!==3);$('onboard-description').classList.toggle('onboard-centered',step===2);
    $('onboard-dots').replaceChildren();
    for(let i=0;i<SLIDES.length;i++){
      const dot=document.createElement('span');dot.className='onboard-dot'+(i===step?' active':'');dot.setAttribute('aria-label',`Step ${i+1}${i===step?', current':''}`);
      $('onboard-dots').append(dot);
    }
    $('onboard-back').classList.toggle('hidden',step===0||review);
    $('onboard-next').textContent=review?'Close':step===3?'I accept & start':'Next →';
    const box=$('onboard-agree');
    $('onboard-disclaimer').querySelector('.onboard-accept').classList.toggle('hidden',review);
    $('onboard-next').disabled=!review&&step===3&&!box.checked;
    $('onboarding').querySelector('.onboarding-panel').scrollTop=0;
  }
  function openOnboarding({at=0,readOnly=false}={}){
    review=readOnly;$('onboarding').classList.remove('hidden');
    if(!review)setGate(true);
    showSlide(at);
    $('onboard-next').focus({preventScroll:true});
  }
  $('onboard-next').addEventListener('click',()=>{
    if(review){$('onboarding').classList.add('hidden');return;}
    if(step!==3){showSlide(step+1);return;}
    if(!$('onboard-agree').checked)return;
    accessGranted=true;
    try{localStorage.setItem(AGREEMENT_KEY,'yes');}catch{/* This session still works if storage is unavailable. */}
    finish();
  });
  $('onboard-back').addEventListener('click',()=>{if(!review&&step>0)showSlide(step-1);});
  $('onboard-agree').addEventListener('change',()=>{if(step===3&&!review)$('onboard-next').disabled=!$('onboard-agree').checked;});
  async function start(){
    setGate(true);
    const splash=$('splash-screen'),status=$('splash-status');
    const begin=performance.now();
    const stages=[...document.querySelectorAll('#splash-stages span')];
    const stage=index=>stages.forEach((el,i)=>{el.classList.toggle('current',i===index);el.classList.toggle('done',i<index);});
    stage(0);status.textContent='App · loading editor…';$('splash-progress').style.width='18%';
    // AI loading starts for real here; the splash has an indeterminate bar and
    // does not pretend that its animation measures downloaded bytes.
    const bootstrap=Promise.resolve().then(()=>{stage(1);status.textContent='AI models · preparing on-device detection…';$('splash-progress').style.width='56%';return initAI();}).then(()=>{
      onAIReady();stage(2);$('splash-progress').style.width='100%';$('splash-progress').classList.add('complete');
      return 'ready';
    },err=>{
      console.warn('AI initialization unavailable; manual editing still works:',err);
      status.textContent='AI requires internet on first use. Manual editor is ready.';return 'failed';
    });
    const outcome=await Promise.race([bootstrap,delay(6500).then(()=>'loading')]);
    if(outcome==='failed')status.textContent='AI unavailable. Manual tools are ready.';
    if(outcome==='loading')status.textContent='AI continues loading in the background…';
    if(outcome==='ready')status.textContent='Ready · private editing on your device';
    // Never vanish instantly on a fast/cached load. Allow the lime frame
    // animation and all loading stages to be seen for at least 1.85 seconds.
    await delay(Math.max(0,1850-(performance.now()-begin)));
    splash.classList.add('leaving');await delay(240);splash.classList.add('hidden');
    if(accepted())finish();else openOnboarding({at:0});
  }
  return {start,showDisclaimer:()=>openOnboarding({at:3,readOnly:accepted()}),isAccepted:accepted};
}
export function initExportReview(){
  let pending=null;
  const modal=$('export-review-modal'),checkbox=$('export-review-check'),next=$('export-review-continue');
  function close(){modal.classList.add('hidden');pending=null;}
  checkbox.addEventListener('change',()=>{next.disabled=!checkbox.checked;});
  $('export-review-cancel').addEventListener('click',close);
  next.addEventListener('click',()=>{
    if(!checkbox.checked||!pending)return;
    const task=pending;close();
    Promise.resolve().then(task).catch(err=>console.error('Export action failed:',err));
  });
  return task=>{
    if(typeof task!=='function')throw new TypeError('Export action required');
    pending=task;checkbox.checked=false;next.disabled=true;
    modal.classList.remove('hidden');checkbox.focus({preventScroll:true});
  };
}
