// Músicos MX — procesadores AudioWorklet (grabación, compuerta, de-esser)
// Copyright (C) 2026 Santiago Miguel — GNU GPL v3 o posterior.
export const WORKLET_SRC = `
class MMXRecorder extends AudioWorkletProcessor {
  constructor(){ super(); this.on=false; this.port.onmessage=(e)=>{ if(e.data==='start') this.on=true; if(e.data==='stop'){ this.on=false; this.port.postMessage({done:true}); } }; }
  process(inputs){
    const inp=inputs[0];
    if(this.on && inp && inp.length){
      const L=inp[0].slice(0); const R=(inp[1]||inp[0]).slice(0);
      this.port.postMessage({L,R},[L.buffer,R.buffer]);
    }
    return true;
  }
}
registerProcessor('mmx-recorder', MMXRecorder);

class MMXGate extends AudioWorkletProcessor {
  static get parameterDescriptors(){ return [
    {name:'threshold',defaultValue:-45,minValue:-90,maxValue:0},
    {name:'range',defaultValue:-80,minValue:-90,maxValue:0},
    {name:'attack',defaultValue:0.002,minValue:0.0001,maxValue:0.2},
    {name:'release',defaultValue:0.12,minValue:0.005,maxValue:2},
    {name:'hold',defaultValue:0.05,minValue:0,maxValue:1}]; }
  constructor(){ super(); this.env=0; this.g=0; this.holdc=0; }
  process(inputs,outputs,p){
    const i=inputs[0], o=outputs[0]; if(!i||!i.length) return true;
    const thr=Math.pow(10,p.threshold[0]/20), rng=Math.pow(10,p.range[0]/20);
    const a=1-Math.exp(-1/(p.attack[0]*sampleRate)), r=1-Math.exp(-1/(p.release[0]*sampleRate));
    const hold=p.hold[0]*sampleRate; const n=i[0].length;
    for(let k=0;k<n;k++){
      let lv=0; for(let c=0;c<i.length;c++){ const v=Math.abs(i[c][k]); if(v>lv) lv=v; }
      this.env = lv>this.env ? lv : this.env*0.9995;
      let target;
      if(this.env>thr){ target=1; this.holdc=hold; } else if(this.holdc>0){ this.holdc--; target=1; } else target=rng;
      this.g += (target-this.g)*(target>this.g?a:r);
      for(let c=0;c<o.length;c++) o[c][k]=(i[c]||i[0])[k]*this.g;
    }
    return true;
  }
}
registerProcessor('mmx-gate', MMXGate);

class MMXDeEsser extends AudioWorkletProcessor {
  static get parameterDescriptors(){ return [
    {name:'freq',defaultValue:6500,minValue:2000,maxValue:12000},
    {name:'threshold',defaultValue:-30,minValue:-60,maxValue:0},
    {name:'reduction',defaultValue:-10,minValue:-24,maxValue:0}]; }
  constructor(){ super(); this.x1=[0,0]; this.y1=[0,0]; this.env=0; this.g=1; }
  process(inputs,outputs,p){
    const i=inputs[0], o=outputs[0]; if(!i||!i.length) return true;
    const f=p.freq[0], rc=1/(2*Math.PI*f), dt=1/sampleRate, al=rc/(rc+dt);
    const thr=Math.pow(10,p.threshold[0]/20), red=Math.pow(10,p.reduction[0]/20);
    const n=i[0].length;
    for(let k=0;k<n;k++){
      let hp=0;
      for(let c=0;c<Math.min(2,i.length);c++){ const x=i[c][k]; const y=al*(this.y1[c]+x-this.x1[c]); this.x1[c]=x; this.y1[c]=y; hp=Math.max(hp,Math.abs(y)); }
      this.env = Math.max(hp, this.env*0.999);
      const t = this.env>thr ? Math.max(red, thr/this.env) : 1;
      this.g += (t-this.g)*0.01;
      for(let c=0;c<o.length;c++){ const x=(i[c]||i[0])[k]; const y=this.y1[Math.min(c,1)]; o[c][k]= (x-y) + y*this.g; }
    }
    return true;
  }
}
registerProcessor('mmx-deesser', MMXDeEsser);
`;

const loaded = new WeakSet();
export async function ensureWorklets(ctx) {
  if (loaded.has(ctx) || !ctx.audioWorklet) return;
  const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
  await ctx.audioWorklet.addModule(url);
  loaded.add(ctx);
}
