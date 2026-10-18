// HalalFrame first-run gate and export acknowledgement. No backend or sign-in.
// The app stays inert until the user accepts the safety disclaimer.
const AGREEMENT_KEY='halalframe-disclaimer-accepted-v1';
const $=id=>document.getElementById(id);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const SLIDES=[
  {label:'WELCOME',symbol:'◇',title:'Welcome to HalalFrame',description:'A simple, private way to conceal people and regions in photos and videos.'},
  {label:'HOW IT WORKS',symbol:'◎ → ↗ → ↓',title:'Tap a person. Track. Export.',description:'Pause and tap a person, track their movement, inspect the timeline, then export your concealed media.'},
  {label:'YOUR PRIVACY',symbol:'▣',title:'Everything stays on your phone',description:'No sign-in, no server and no uploaded media. Your videos and photos are processed in your browser. AI model files download on the first run.'},
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
    $('onboard-step-label').textContent=`${data.label} · ${step+1} OF 4`;
    $('onboard-title').textContent=data.title;
    $('onboard-visual').textContent=data.symbol;
    $('onboard-description').textContent=data.description;
    $('onboard-disclaimer').classList.toggle('hidden',step!==3);
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
    status.textContent='Loading on-device AI…';
    // AI loading starts for real here; the splash has an indeterminate bar and
    // does not pretend that its animation measures downloaded bytes.
    const bootstrap=Promise.resolve().then(initAI).then(()=>{
      onAIReady();$('splash-progress').classList.add('complete');
      return 'ready';
    },err=>{
      console.warn('AI initialization unavailable; manual editing still works:',err);
      return 'failed';
    });
    const outcome=await Promise.race([bootstrap,delay(6500).then(()=>'loading')]);
    if(outcome==='failed')status.textContent='AI unavailable. Manual tools are ready.';
    if(outcome==='loading')status.textContent='AI continues loading in the background…';
    if(outcome==='ready')status.textContent='Your private editor is ready';
    await delay(Math.max(0,650-(performance.now()-begin)));
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
