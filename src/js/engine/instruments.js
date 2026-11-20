// Músicos MX — instrumentos virtuales integrados (sintetizador y batería)
// Copyright (C) 2026 Santiago Miguel — GNU GPL v3 o posterior.
import { midiToFreq } from '../util.js';

export const SYNTH_PRESETS = {
  'Piano eléctrico': { wave: 'sine', wave2: 'triangle', mix2: 0.35, detune: 2, a: 0.004, d: 1.2, s: 0.25, r: 0.4, cutoff: 5000, env: 2500, q: 0.5, fm: 3.5, fmAmt: 0.4 },
  'Piano de cola': { wave: 'triangle', wave2: 'sine', mix2: 0.5, detune: 1, a: 0.002, d: 2.2, s: 0.08, r: 0.5, cutoff: 6000, env: 3000, q: 0.3, fm: 2, fmAmt: 0.15 },
  'Pad cálido': { wave: 'sawtooth', wave2: 'sawtooth', mix2: 0.6, detune: 9, a: 0.6, d: 1, s: 0.8, r: 1.6, cutoff: 1400, env: 600, q: 1 },
  'Bajo sintético': { wave: 'sawtooth', wave2: 'square', mix2: 0.5, detune: 0, a: 0.003, d: 0.25, s: 0.6, r: 0.12, cutoff: 600, env: 1800, q: 6, sub: 0.7 },
  'Bajo eléctrico': { wave: 'triangle', wave2: 'sine', mix2: 0.5, detune: 0, a: 0.004, d: 0.6, s: 0.4, r: 0.15, cutoff: 1100, env: 900, q: 1, sub: 0.4 },
  'Lead brillante': { wave: 'square', wave2: 'sawtooth', mix2: 0.5, detune: 6, a: 0.01, d: 0.3, s: 0.7, r: 0.25, cutoff: 3500, env: 2500, q: 3 },
  'Órgano': { wave: 'sine', wave2: 'sine', mix2: 0.6, detune: 0, oct2: 12, a: 0.01, d: 0.1, s: 1, r: 0.08, cutoff: 8000, env: 0, q: 0.2, sub: 0.5 },
  'Cuerdas': { wave: 'sawtooth', wave2: 'sawtooth', mix2: 0.7, detune: 12, a: 0.35, d: 0.5, s: 0.85, r: 0.9, cutoff: 2600, env: 400, q: 0.6 },
  'Metales': { wave: 'sawtooth', wave2: 'square', mix2: 0.3, detune: 4, a: 0.06, d: 0.3, s: 0.8, r: 0.25, cutoff: 1500, env: 3000, q: 1.5 },
  'Marimba': { wave: 'sine', wave2: 'sine', mix2: 0.3, oct2: 24, detune: 0, a: 0.001, d: 0.45, s: 0, r: 0.3, cutoff: 6000, env: 0, q: 0.2 },
  'Campanas': { wave: 'sine', wave2: 'sine', mix2: 0.5, detune: 0, a: 0.001, d: 2.5, s: 0, r: 1.5, cutoff: 9000, env: 0, q: 0.2, fm: 3.5, fmAmt: 2 },
  'Acordeón': { wave: 'square', wave2: 'sawtooth', mix2: 0.5, detune: 14, a: 0.05, d: 0.2, s: 0.9, r: 0.15, cutoff: 3000, env: 300, q: 1.2 },
  'Guitarra pulsada': { wave: 'sawtooth', wave2: 'triangle', mix2: 0.4, detune: 3, a: 0.002, d: 0.9, s: 0.05, r: 0.3, cutoff: 2400, env: 3500, q: 2 }
};

export const DRUM_MAP = {
  35: 'Bombo 2', 36: 'Bombo', 37: 'Aro', 38: 'Tarola', 39: 'Palmas', 40: 'Tarola 2', 41: 'Tom de piso', 42: 'Hi-hat cerrado',
  43: 'Tom de piso 2', 44: 'Hi-hat pedal', 45: 'Tom bajo', 46: 'Hi-hat abierto', 47: 'Tom medio', 48: 'Tom alto', 49: 'Platillo crash',
  50: 'Tom agudo', 51: 'Platillo ride', 54: 'Pandero', 56: 'Cencerro', 60: 'Bongó alto', 61: 'Bongó bajo', 62: 'Conga apagada',
  63: 'Conga alta', 64: 'Conga baja', 69: 'Cabasa', 70: 'Maraca', 73: 'Güiro corto', 74: 'Güiro largo', 75: 'Claves', 76: 'Wood block'
};
export const DRUM_KITS = ['Acústica', 'Electrónica 808', 'Latina'];

let noiseBuf = null;
function noise(ctx) {
  if (noiseBuf && noiseBuf.sampleRate === ctx.sampleRate && noiseBuf._ctx === ctx) return noiseBuf;
  const b = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  b._ctx = ctx; noiseBuf = b; return b;
}

function env(g, t, a, peak, d, s, dur, r) {
  g.gain.cancelScheduledValues(t);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + a);
  g.gain.setTargetAtTime(peak * s, t + a, Math.max(0.001, d / 3));
  const rel = t + Math.max(a, dur);
  g.gain.setTargetAtTime(0, rel, Math.max(0.001, r / 4));
  return rel + r * 1.5;
}

export function playSynth(ctx, dest, note, t, dur, vel, presetName, params = {}) {
  const p = { ...(SYNTH_PRESETS[presetName] || SYNTH_PRESETS['Piano eléctrico']), ...params };
  const f = midiToFreq(note), v = (vel / 127) * 0.28;
  const o1 = ctx.createOscillator(), o2 = ctx.createOscillator(), g2 = ctx.createGain(), flt = ctx.createBiquadFilter(), amp = ctx.createGain();
  o1.type = p.wave; o2.type = p.wave2; o1.frequency.value = f; o2.frequency.value = f * Math.pow(2, (p.oct2 || 0) / 12);
  o1.detune.value = -p.detune; o2.detune.value = p.detune; g2.gain.value = p.mix2;
  flt.type = 'lowpass'; flt.Q.value = p.q;
  const keyTrack = Math.min(18000, p.cutoff + f * 0.5);
  flt.frequency.setValueAtTime(keyTrack, t);
  if (p.env) { flt.frequency.linearRampToValueAtTime(Math.min(18000, keyTrack + p.env * (vel / 127)), t + p.a + 0.005); flt.frequency.setTargetAtTime(keyTrack, t + p.a, p.d / 2); }
  o1.connect(flt); o2.connect(g2); g2.connect(flt); flt.connect(amp); amp.connect(dest);
  let mod;
  if (p.fm) { mod = ctx.createOscillator(); const mg = ctx.createGain(); mod.frequency.value = f * p.fm; mg.gain.setValueAtTime(f * p.fmAmt, t); mg.gain.setTargetAtTime(0, t, p.d / 2); mod.connect(mg); mg.connect(o1.frequency); mod.start(t); }
  let sub;
  if (p.sub) { sub = ctx.createOscillator(); const sg = ctx.createGain(); sub.type = 'sine'; sub.frequency.value = f / 2; sg.gain.value = p.sub; sub.connect(sg); sg.connect(flt); sub.start(t); }
  const end = env(amp, t, p.a, v, p.d, p.s, dur, p.r);
  const oscs = [o1, o2, mod, sub].filter(Boolean);
  o1.start(t); o2.start(t); oscs.forEach(o => o.stop(end));
  oscs.release = (rt) => {
    try { amp.gain.cancelScheduledValues(rt); amp.gain.setValueAtTime(amp.gain.value, rt); amp.gain.setTargetAtTime(0, rt, Math.max(0.005, p.r / 4)); oscs.forEach(o => o.stop(rt + p.r * 1.5 + 0.05)); } catch (e) { }
  };
  return oscs;
}

export function playDrum(ctx, dest, note, t, vel, kit = 'Acústica') {
  const v = vel / 127, out = ctx.createGain(); out.connect(dest);
  const nodes = [];
  const osc = (type, f0, f1, dec, lvl, start = t) => {
    const o = ctx.createOscillator(), g = ctx.createGain(); o.type = type;
    o.frequency.setValueAtTime(f0, start); o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), start + dec * 0.7);
    g.gain.setValueAtTime(lvl * v, start); g.gain.exponentialRampToValueAtTime(0.0001, start + dec);
    o.connect(g); g.connect(out); o.start(start); o.stop(start + dec + 0.05); nodes.push(o);
  };
  const nz = (ftype, freq, q, dec, lvl, start = t) => {
    const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    s.buffer = noise(ctx); f.type = ftype; f.frequency.value = freq; f.Q.value = q;
    g.gain.setValueAtTime(lvl * v, start); g.gain.exponentialRampToValueAtTime(0.0001, start + dec);
    s.connect(f); f.connect(g); g.connect(out); s.start(start, Math.random()); s.stop(start + dec + 0.05); nodes.push(s);
  };
  const is808 = kit === 'Electrónica 808';
  switch (note) {
    case 35: case 36: is808 ? osc('sine', 120, 42, 0.9, 1.1) : (osc('sine', 150, 50, 0.35, 1.1), nz('lowpass', 3000, 0.7, 0.02, 0.4)); break;
    case 37: osc('triangle', 1800, 1700, 0.03, 0.5); nz('bandpass', 3000, 2, 0.03, 0.4); break;
    case 38: case 40: osc('triangle', 220, 160, 0.12, 0.5); nz('highpass', is808 ? 1500 : 1200, 0.8, is808 ? 0.2 : 0.18, 0.7); break;
    case 39: for (let i = 0; i < 3; i++) nz('bandpass', 1300, 1.5, 0.08 + (i === 2 ? 0.12 : 0), 0.7, t + i * 0.011); break;
    case 42: case 44: nz('highpass', 8000, 1, 0.05, 0.45); break;
    case 46: nz('highpass', 7500, 1, 0.35, 0.4); break;
    case 41: case 43: osc('sine', 110, 70, 0.4, 0.9); break;
    case 45: case 47: osc('sine', 150, 95, 0.35, 0.85); break;
    case 48: case 50: osc('sine', 210, 140, 0.3, 0.8); break;
    case 49: case 57: nz('highpass', 5000, 0.5, 1.6, 0.4); nz('bandpass', 9000, 1, 1.2, 0.2); break;
    case 51: case 59: nz('highpass', 7000, 0.7, 0.8, 0.22); osc('square', 5200, 5100, 0.6, 0.04); break;
    case 54: nz('highpass', 9000, 1, 0.12, 0.35); nz('highpass', 9000, 1, 0.1, 0.25, t + 0.03); break;
    case 56: osc('square', 560, 560, 0.25, 0.25); osc('square', 845, 845, 0.25, 0.2); break;
    case 60: osc('sine', 420, 380, 0.12, 0.7); break;
    case 61: osc('sine', 300, 270, 0.15, 0.7); break;
    case 62: osc('sine', 260, 240, 0.06, 0.7); nz('bandpass', 2000, 2, 0.02, 0.3); break;
    case 63: osc('sine', 330, 300, 0.25, 0.75); break;
    case 64: osc('sine', 220, 200, 0.3, 0.75); break;
    case 69: case 70: nz('highpass', 6000, 1, 0.08, 0.35); break;
    case 73: for (let i = 0; i < 4; i++) nz('bandpass', 3500, 4, 0.015, 0.5, t + i * 0.018); break;
    case 74: for (let i = 0; i < 12; i++) nz('bandpass', 3500, 4, 0.015, 0.45, t + i * 0.02); break;
    case 75: osc('sine', 2500, 2500, 0.06, 0.6); break;
    case 76: osc('sine', 1200, 1100, 0.08, 0.6); break;
    default: osc('sine', 200 + (note % 12) * 30, 150, 0.2, 0.5);
  }
  return nodes;
}

export function playInstrumentNote(ctx, dest, inst, note, t, dur, vel) {
  if (!inst) return [];
  if (inst.type === 'drums') return playDrum(ctx, dest, note, t, vel, inst.preset);
  return playSynth(ctx, dest, note, t, dur, vel, inst.preset, inst.params);
}
