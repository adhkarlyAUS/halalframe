import {clamp,seconds} from '../state.js';
export class Timeline {
  constructor({slider,lanes,onSeek,onSelect,onRange,onCommit,onMenu,onGapSelect}={}){
    Object.assign(this,{slider,lanes,onSeek,onSelect,onRange,onCommit,onMenu});this.duration=1;this.activeId=null;this.drag=null;
    slider.addEventListener('input',()=>this.onSeek(Number(slider.value)));
  }
  update(project,selectedId,current){
    if(!project)return;
    const dur=Math.max(0.001,project.video.duration);this.duration=dur;
    this.slider.max=String(dur);this.slider.step=String(1/Math.max(1,project.video.fps));
    if(!this.slider.matches(':active'))this.slider.value=String(clamp(current,0,dur));
    this.lanes.replaceChildren();
    for(const c of project.concealments){
      const lane=document.createElement('div');lane.className='lane';lane.dataset.id=c.id;
      const name=document.createElement('button');name.className=`lane-label ${selectedId===c.id?'selected':''}`;name.textContent=c.label;name.title='Select this concealment';name.onclick=()=>this.onSelect(c.id);lane.append(name);
      const track=document.createElement('div');track.className='lane-track';lane.append(track);
      const bar=document.createElement('div');bar.className=`mask-bar ${selectedId===c.id?'selected':''}`;bar.style.left=`${100*c.startTime/dur}%`;bar.style.width=`${Math.max(.5,100*(c.endTime-c.startTime)/dur)}%`;bar.title=`${seconds(c.startTime)} – ${seconds(c.endTime)}`;
      const startHandle=document.createElement('div');startHandle.className='range-handle left';startHandle.title='Drag start';startHandle.dataset.handle='start';
      const endHandle=document.createElement('div');endHandle.className='range-handle right';endHandle.title='Drag end';endHandle.dataset.handle='end';
      bar.append(startHandle,endHandle);
      for(const point of c.track){const dot=document.createElement('span');dot.className='key-dot';dot.title=`Keyframe at ${seconds(point.t)}`;dot.style.left=`${100*(point.t-c.startTime)/Math.max(.001,c.endTime-c.startTime)}%`;bar.append(dot);}
      for(const gap of c.reviewGaps||[]){
        if(gap.resolved===true||gap.to<=c.startTime||gap.from>=c.endTime)continue;
        const left=Math.max(c.startTime,gap.from),right=Math.min(c.endTime,gap.to);
        const amber=document.createElement('span');amber.className='review-gap-segment';amber.setAttribute('role','button');amber.tabIndex=0;
        amber.style.left=`${100*(left-c.startTime)/Math.max(.001,c.endTime-c.startTime)}%`;
        amber.style.width=`${Math.max(1,100*(right-left)/Math.max(.001,c.endTime-c.startTime))}%`;
        amber.title=`Uncertain ${seconds(left)}–${seconds(right)} — tap to review`;
        amber.setAttribute('aria-label',amber.title);
        amber.addEventListener('click',e=>{e.stopPropagation();this.onGapSelect?.(c.id,gap.id);});
        amber.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();this.onGapSelect?.(c.id,gap.id);}});
        bar.append(amber);
      }
      track.append(bar);this.lanes.append(lane);
      let longTimer=null,longFired=false;
      bar.addEventListener('pointerdown',e=>{
        e.stopPropagation();const edge=e.target.closest('[data-handle]');
        if(edge){e.preventDefault();this.drag={id:c.id,which:edge.dataset.handle,bar,track};bar.setPointerCapture(e.pointerId);return;}
        if(e.target.closest('.review-gap-segment'))return;
        longFired=false;longTimer=setTimeout(()=>{longFired=true;this.onMenu(c.id,bar.getBoundingClientRect());},630);
      });
      bar.addEventListener('pointermove',e=>{
        if(this.drag?.bar===bar){e.preventDefault();const rect=track.getBoundingClientRect();const time=clamp((e.clientX-rect.left)/rect.width*dur,0,dur);this.onRange(this.drag.id,this.drag.which,time);const region=project.concealments.find(x=>x.id===c.id);if(region){bar.style.left=`${100*region.startTime/dur}%`;bar.style.width=`${Math.max(.5,100*(region.endTime-region.startTime)/dur)}%`;}return;}
        if(longTimer&&e.buttons){clearTimeout(longTimer);longTimer=null;}
      });
      const finish=()=>{if(longTimer)clearTimeout(longTimer);longTimer=null;if(this.drag?.bar===bar){this.drag=null;this.onSelect(c.id);this.onCommit();}else if(!longFired)this.onSelect(c.id);};
      bar.addEventListener('pointerup',finish);bar.addEventListener('pointercancel',finish);
      bar.addEventListener('contextmenu',e=>{e.preventDefault();this.onMenu(c.id,bar.getBoundingClientRect());});
    }
  }
  setPlayhead(t){if(!this.slider.matches(':active'))this.slider.value=String(t);}
}
