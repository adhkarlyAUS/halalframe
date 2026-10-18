import {normalizedBox,clamp} from '../state.js';
export class CanvasInput {
  constructor(canvas,{onDraw=()=>{},onTap=()=>{},onDraft=()=>{}}={}){
    this.canvas=canvas;this.onDraw=onDraw;this.onTap=onTap;this.onDraft=onDraft;this.mode='select';this.down=null;this.preview=null;
    canvas.style.touchAction='none';
    canvas.addEventListener('pointerdown',e=>this.start(e));
    canvas.addEventListener('pointermove',e=>this.move(e));
    canvas.addEventListener('pointerup',e=>this.end(e));
    canvas.addEventListener('pointercancel',()=>this.cancel());
  }
  setMode(mode){this.mode=mode;this.cancel();this.canvas.style.cursor=mode==='draw'?'crosshair':'pointer';}
  coords(e){const r=this.canvas.getBoundingClientRect();return {x:clamp((e.clientX-r.left)/Math.max(r.width,1),0,1),y:clamp((e.clientY-r.top)/Math.max(r.height,1),0,1)};}
  start(e){if(e.button!==0||!this.canvas.width)return;e.preventDefault();this.down={...this.coords(e),id:e.pointerId};this.canvas.setPointerCapture(e.pointerId);if(this.mode==='draw')this.onDraft({x:this.down.x,y:this.down.y,w:0,h:0});}
  move(e){if(!this.down||e.pointerId!==this.down.id||this.mode!=='draw')return;e.preventDefault();const p=this.coords(e);const b=normalizedBox({x:Math.min(this.down.x,p.x),y:Math.min(this.down.y,p.y),w:Math.abs(this.down.x-p.x),h:Math.abs(this.down.y-p.y)});this.onDraft(b);}
  end(e){if(!this.down||e.pointerId!==this.down.id)return;e.preventDefault();const p=this.coords(e),was=this.down;this.down=null;try{this.canvas.releasePointerCapture(e.pointerId);}catch{}
    this.onDraft(null);
    if(this.mode==='draw'){
      const b=normalizedBox({x:Math.min(was.x,p.x),y:Math.min(was.y,p.y),w:Math.abs(was.x-p.x),h:Math.abs(was.y-p.y)});
      if(b.w>=.008&&b.h>=.008)this.onDraw(b);else this.onTap(p.x,p.y);
    }else this.onTap(p.x,p.y);
  }
  cancel(){this.down=null;this.onDraft(null);}
}
