// Windowed STFT/iSTFT for UVR MDX-Net ONNX models. 4096 radix-2 and
// 6144 mixed-radix (3 × 2048), native JavaScript: no server or FFT dependency.
export const HOP=1024, FRAMES=256;
export const hann=n=>{const w=new Float32Array(n);for(let i=0;i<n;i++)w[i]=.5-.5*Math.cos(2*Math.PI*i/n);return w;};
export function radix2FFT(re,im,inverse=false){
  const n=re.length;if((n&(n-1))!==0)throw new Error('Radix-2 length required');
  for(let i=1,j=0;i<n;i++){
    let bit=n>>1;for(;j&bit;bit>>=1)j^=bit;j^=bit;
    if(i<j){[re[i],re[j]]=[re[j],re[i]];[im[i],im[j]]=[im[j],im[i]];}
  }
  for(let len=2;len<=n;len*=2){const a=(inverse?2:-2)*Math.PI/len;
    const cs=Math.cos(a),sn=Math.sin(a);
    for(let i=0;i<n;i+=len){let wr=1,wi=0;for(let k=0;k<len/2;k++){
      const j=i+k,l=j+len/2,ur=re[j],ui=im[j],vr=re[l]*wr-im[l]*wi,vi=re[l]*wi+im[l]*wr;
      re[j]=ur+vr;im[j]=ui+vi;re[l]=ur-vr;im[l]=ui-vi;
      const nx=wr*cs-wi*sn;wi=wr*sn+wi*cs;wr=nx;
    }}
  }
  if(inverse){for(let i=0;i<n;i++){re[i]/=n;im[i]/=n;}}
}
export function fft(re,im,inverse=false){
  const n=re.length;if((n&(n-1))===0){radix2FFT(re,im,inverse);return;}
  if(n%3||((n/3)&(n/3-1))!==0)throw new Error('FFT size must be power of 2 or 3 × power of 2');
  if(inverse){for(let i=0;i<n;i++)im[i]=-im[i];fft(re,im,false);for(let i=0;i<n;i++){re[i]/=n;im[i]=-im[i]/n;}return;}
  const m=n/3,rr=[],ii=[];
  for(let a=0;a<3;a++){
    rr[a]=new Float64Array(m);ii[a]=new Float64Array(m);
    for(let j=0;j<m;j++){rr[a][j]=re[3*j+a];ii[a][j]=im[3*j+a];}
    radix2FFT(rr[a],ii[a]);
  }
  for(let k=0;k<n;k++){
    let sr=0,si=0;const base=k%m;
    for(let a=0;a<3;a++){
      const phase=-2*Math.PI*a*k/n,c=Math.cos(phase),s=Math.sin(phase);
      sr+=rr[a][base]*c-ii[a][base]*s;si+=rr[a][base]*s+ii[a][base]*c;
    }re[k]=sr;im[k]=si;
  }
}
export function reflectSample(a,index){let i=index;const n=a.length;if(n<=1)return a[0]||0;
  while(i<0||i>=n){if(i<0)i=-i;else i=2*n-i-2;}return a[i];
}
export function resample(input,srcRate,dstRate){
  if(srcRate===dstRate)return new Float32Array(input);
  const output=new Float32Array(Math.max(1,Math.round(input.length*dstRate/srcRate)));
  // 12-tap windowed-sinc; antialias cutoff for downsampling.
  const cutoff=Math.min(1,dstRate/srcRate);
  for(let i=0;i<output.length;i++){
    const pos=i*srcRate/dstRate,center=Math.floor(pos);let sum=0,weight=0;
    for(let j=-12;j<=12;j++){
      const k=center+j,delta=k-pos;if(k<0||k>=input.length)continue;
      const arg=Math.PI*delta*cutoff;
      const sinc=Math.abs(arg)<1e-9?1:Math.sin(arg)/arg;
      const win=.5+.5*Math.cos(Math.PI*delta/13);
      const w=sinc*win*cutoff;sum+=input[k]*w;weight+=w;
    }output[i]=weight?sum/weight:0;
  }return output;
}
export function stftChunk(channels,start,config){
  const {nfft,dimF,dimT=FRAMES,hop=HOP}=config;const data=new Float32Array(4*dimF*dimT);
  const win=hann(nfft),half=nfft/2;
  for(let c=0;c<2;c++){
    const channel=channels[Math.min(c,channels.length-1)];
    for(let frame=0;frame<dimT;frame++){
      const re=new Float64Array(nfft),im=new Float64Array(nfft),origin=start+frame*hop-half;
      for(let i=0;i<nfft;i++)re[i]=reflectSample(channel,origin+i)*win[i];
      fft(re,im);
      for(let bin=3;bin<dimF;bin++){
        const pos=bin*dimT+frame;
        data[(c*2)*dimF*dimT+pos]=re[bin];
        data[(c*2+1)*dimF*dimT+pos]=im[bin];
      }
    }
  }return data;
}
export function istftChunk(spec,start,config,chunkLen){
  const {nfft,dimF,dimT=FRAMES,hop=HOP}=config,win=hann(nfft),half=nfft/2;
  const outputs=[new Float32Array(chunkLen),new Float32Array(chunkLen)];
  const denom=new Float32Array(chunkLen);
  for(let frame=0;frame<dimT;frame++){
    const loc=frame*hop-half;
    for(let c=0;c<2;c++){
      const re=new Float64Array(nfft),im=new Float64Array(nfft),offset=c*2*dimF*dimT;
      for(let k=0;k<dimF;k++){const a=offset+k*dimT+frame;re[k]=spec[a];im[k]=spec[a+dimF*dimT];}
      // Hermitian symmetry for real signals; dropped Nyquist bin is zero.
      for(let k=1;k<nfft/2;k++){re[nfft-k]=re[k];im[nfft-k]=-im[k];}
      fft(re,im,true);
      for(let i=0;i<nfft;i++){
        const at=loc+i;if(at<0||at>=chunkLen)continue;
        outputs[c][at]+=re[i]*win[i];
        if(c===0)denom[at]+=win[i]*win[i];
      }
    }
  }
  for(let c=0;c<2;c++)for(let i=0;i<chunkLen;i++)outputs[c][i]/=Math.max(denom[i],1e-8);
  return outputs;
}
export function blendChunks(chunks,length){
  const output=[new Float32Array(length),new Float32Array(length)],den=new Float32Array(length);
  for(const {start,data} of chunks){const m=data[0].length;
    for(let i=0;i<m;i++){
      const dst=start+i;if(dst<0||dst>=length)continue;
      // Half-overlap Hann-like crossfade; edges receive full weight.
      const fade=Math.min(1,(i+1)/(m*.26),(m-i)/(m*.26));
      const w=Math.max(.001,fade);
      den[dst]+=w;for(let ch=0;ch<2;ch++)output[ch][dst]+=data[ch][i]*w;
    }
  }
  for(let i=0;i<length;i++)if(den[i]>0)for(let ch=0;ch<2;ch++)output[ch][i]/=den[i];
  return output;
}
export function deriveGate(scores,rate,length,{strength='strong',fadesMs=12}={}){
  const start=rate/16000*512,flags=new Uint8Array(scores.length);
  const threshold=strength==='gentle'?.38:strength==='maximum'?.48:.44;
  for(let i=0;i<scores.length;i++)flags[i]=scores[i]>=threshold?1:0;
  // Protect the beginning and end of words with >=224ms VAD hangover.
  const spread=7,ext=new Uint8Array(flags.length);
  for(let i=0;i<flags.length;i++)if(flags[i])for(let j=Math.max(0,i-spread);j<=Math.min(flags.length-1,i+spread);j++)ext[j]=1;
  const output=new Float32Array(length),fade=Math.max(1,Math.round(fadesMs/1000*rate));
  for(let i=0;i<length;i++){
    const k=Math.min(ext.length-1,Math.floor(i/start));output[i]=ext[k]||0;
  }
  // Fade at the ORIGINAL binary boundaries, not at already faded samples.
  // Using the mutating output for edge detection repeatedly restarts each
  // fade and can otherwise silence speech completely.
  const binary=output.slice();
  for(let i=1;i<length;i++)if(binary[i]&&!binary[i-1]){
    for(let j=0;j<fade&&i+j<length&&binary[i+j];j++)output[i+j]=Math.min(output[i+j],j/fade);
  }
  for(let i=length-2;i>=0;i--)if(binary[i]&&!binary[i+1]){
    for(let j=0;j<fade&&i-j>=0&&binary[i-j];j++)output[i-j]=Math.min(output[i-j],j/fade);
  }
  return output;
}
export function rmsEnergy(arr,lo=0,hi=arr.length){let sum=0;for(let i=lo;i<hi;i++)sum+=arr[i]*arr[i];return Math.sqrt(sum/Math.max(1,hi-lo));}

/**
 * Maximum-only second pass: attenuate narrow, persistent instrumental tones
 * identified in MUSIC-ONLY portions of the ORIGINAL recording, then notch
 * those frequencies in the separated vocal stem during speech.
 *
 * This is a conservative reference-driven notch filter, not a universal music
 * detector. If no trustworthy non-speech reference exists, the original vocal
 * stem is returned untouched. Speech harmonics may overlap instruments, so the
 * user must listen for distortion and can always choose "No audio" instead.
 * Operates locally in the audio worker; no raw audio leaves the browser.
 */
export function suppressSteadyTones({original,vocals,gate,rate,onProgress=()=>{}}){
  const size=4096,hop=1024,half=size/2;
  const length=vocals[0]?.length||0;
  if(!length||!original[0]||gate.length!==length)return {channels:vocals,tones:0};
  const window=hann(size),energy=new Float64Array(half),frames=Math.max(1,Math.ceil((length-size)/hop)+1);
  let references=0;
  const re=new Float64Array(size),im=new Float64Array(size);
  // A non-speech reference is essential. Only use windows that VAD marked
  // silent through the center AND both ends (ignore transition fades).
  for(let f=0;f<frames;f++){
    const start=f*hop;
    const a=Math.min(length-1,start+Math.round(size*.1)),
      m=Math.min(length-1,start+half),b=Math.min(length-1,start+Math.round(size*.9));
    if(gate[a]>.015||gate[m]>.015||gate[b]>.015)continue;
    for(let i=0;i<size;i++){
      const j=start+i;
      const mono=j<length?(original.length>1?(original[0][j]+original[1][j])*.5:original[0][j]):0;
      re[i]=mono*window[i];im[i]=0;
    }
    fft(re,im);
    for(let k=0;k<half;k++)energy[k]+=Math.hypot(re[k],im[k]);
    references++;
  }
  if(references<4)return {channels:vocals,tones:0};
  for(let k=0;k<half;k++)energy[k]/=references;
  let peak=0;for(let k=8;k<half;k++)peak=Math.max(peak,energy[k]);
  const gain=new Float64Array(half+1).fill(1);
  let tones=0;
  for(let k=8;k<half-12;k++){
    const frequency=k*rate/size;
    if(frequency<85||frequency>4200||energy[k]<peak*.018)continue;
    if(energy[k]<energy[k-1]||energy[k]<energy[k+1])continue;
    let local=0,n=0;
    for(let offset=-10;offset<=10;offset++){
      if(Math.abs(offset)<3)continue;
      local+=energy[k+offset];n++;
    }
    const prominence=energy[k]/Math.max(1e-8,local/n);
    if(prominence<1.9)continue;
    tones++;
    // Up to ~20 dB at a strong, stable peak. Feather neighbouring FFT bins
    // so sub-bin frequency drift is also suppressed without a hard ringing notch.
    const depth=Math.min(.91,.66+.07*Math.log2(prominence));
    for(let offset=-3;offset<=3;offset++){
      const at=k+offset;
      const weight=Math.exp(-.5*(offset/1.15)**2);
      gain[at]=Math.min(gain[at],1-depth*weight);
    }
  }
  if(!tones)return {channels:vocals,tones:0};
  const output=vocals.map(()=>new Float32Array(length)),weights=new Float32Array(length);
  for(let f=0;f<frames;f++){
    const start=f*hop;
    for(let c=0;c<output.length;c++){
      const channel=vocals[c];
      for(let i=0;i<size;i++){
        const j=start+i;re[i]=(j<length?channel[j]:0)*window[i];im[i]=0;
      }
      fft(re,im);
      // Real-input spectrum requires Hermitian symmetry after filtering.
      for(let k=1;k<half;k++){
        const g=gain[k];re[k]*=g;im[k]*=g;re[size-k]*=g;im[size-k]*=g;
      }
      fft(re,im,true);
      for(let i=0;i<size&&start+i<length;i++){
        const at=start+i,w=window[i];
        output[c][at]+=re[i]*w;
        if(c===0)weights[at]+=w*w;
      }
    }
    if(f%24===0)onProgress(f/frames);
  }
  for(let c=0;c<output.length;c++){
    for(let i=0;i<length;i++){
      // Retain the original gate: music-only regions cannot become audible
      // through overlap-add or the spectral pass.
      output[c][i]=weights[i]>1e-7?(output[c][i]/weights[i])*gate[i]:vocals[c][i]*gate[i];
    }
  }
  onProgress(1);
  return {channels:output,tones};
}
