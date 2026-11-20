// Músicos MX — complementos de inserción en tiempo real (formato MMX nativo)
// Copyright (C) 2026 Santiago Miguel — GNU GPL v3 o posterior.
import { dbToGain } from '../util.js';

const P = (key, name, min, max, def, unit = '', opts = {}) => ({ key, name, min, max, def, unit, ...opts });

function makeIR(ctx, seconds, decay, preDelay = 0.01, damp = 0.5, stereoWidth = 1) {
  const sr = ctx.sampleRate, len = Math.max(1, Math.floor(sr * (seconds + preDelay)));
  const ir = ctx.createBuffer(2, len, sr);
  const pd = Math.floor(preDelay * sr);
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c); let lp = 0;
    for (let i = pd; i < len; i++) {
      const t = (i - pd) / sr;
      const n = (Math.random() * 2 - 1) * Math.pow(1 - t / seconds, decay) * Math.exp(-t * 1.5);
      lp = lp + (n - lp) * (1 - damp * Math.min(1, t / seconds + 0.2));
      d[i] = c === 1 ? lp * stereoWidth + (1 - stereoWidth) * ir.getChannelData(0)[i] : lp;
    }
  }
  return ir;
}

function satCurve(amount, type = 'tape') {
  const n = 2048, c = new Float32Array(n), k = amount * 50 + 1;
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1) * 2 - 1;
    c[i] = type === 'tube' ? (x >= 0 ? Math.tanh(k * x) : Math.tanh(k * x * 0.7) / 0.9) / Math.tanh(k)
      : Math.tanh(k * x) / Math.tanh(k);
  }
  return c;
}

export const PLUGINS = {
  eq7: {
    name: 'EQ 7 bandas', cat: 'EQ',
    params: [
      P('hpf', 'Pasa altos', 20, 1000, 20, 'Hz', { log: true }),
      P('lsF', 'Grave frec.', 40, 600, 100, 'Hz', { log: true }), P('lsG', 'Grave gan.', -18, 18, 0, 'dB'),
      P('p1F', 'Medio-grave frec.', 100, 2000, 300, 'Hz', { log: true }), P('p1G', 'Medio-grave gan.', -18, 18, 0, 'dB'), P('p1Q', 'Medio-grave Q', 0.1, 10, 1),
      P('p2F', 'Medio frec.', 300, 6000, 1200, 'Hz', { log: true }), P('p2G', 'Medio gan.', -18, 18, 0, 'dB'), P('p2Q', 'Medio Q', 0.1, 10, 1),
      P('p3F', 'Medio-agudo frec.', 1000, 16000, 4000, 'Hz', { log: true }), P('p3G', 'Medio-agudo gan.', -18, 18, 0, 'dB'), P('p3Q', 'Medio-agudo Q', 0.1, 10, 1),
      P('hsF', 'Agudo frec.', 2000, 18000, 10000, 'Hz', { log: true }), P('hsG', 'Agudo gan.', -18, 18, 0, 'dB'),
      P('lpf', 'Pasa bajos', 1000, 22000, 22000, 'Hz', { log: true }), P('out', 'Salida', -24, 24, 0, 'dB')
    ],
    create(ctx, p) {
      const mk = (type) => { const f = ctx.createBiquadFilter(); f.type = type; return f; };
      const hp = mk('highpass'), ls = mk('lowshelf'), p1 = mk('peaking'), p2 = mk('peaking'), p3 = mk('peaking'), hs = mk('highshelf'), lp = mk('lowpass');
      const out = ctx.createGain();
      [hp, ls, p1, p2, p3, hs, lp].reduce((a, b) => (a.connect(b), b)).connect(out);
      const map = { hpf: [hp, 'frequency'], lsF: [ls, 'frequency'], lsG: [ls, 'gain'], p1F: [p1, 'frequency'], p1G: [p1, 'gain'], p1Q: [p1, 'Q'], p2F: [p2, 'frequency'], p2G: [p2, 'gain'], p2Q: [p2, 'Q'], p3F: [p3, 'frequency'], p3G: [p3, 'gain'], p3Q: [p3, 'Q'], hsF: [hs, 'frequency'], hsG: [hs, 'gain'], lpf: [lp, 'frequency'] };
      hp.Q.value = 0.707; lp.Q.value = 0.707;
      const set = (k, v) => { if (k === 'out') out.gain.value = dbToGain(v); else if (map[k]) map[k][0][map[k][1]].value = Math.min(v, ctx.sampleRate / 2 - 100); };
      for (const k in p) set(k, p[k]);
      return { input: hp, output: out, set, filters: [hp, ls, p1, p2, p3, hs, lp] };
    }
  },
  comp: {
    name: 'Compresor/Limitador Dyn', cat: 'Dinámica',
    params: [P('threshold', 'Umbral', -60, 0, -18, 'dB'), P('ratio', 'Proporción', 1, 20, 4, ':1'), P('attack', 'Ataque', 0.0001, 0.2, 0.01, 's'), P('release', 'Liberación', 0.01, 1.5, 0.15, 's'), P('knee', 'Rodilla', 0, 40, 6, 'dB'), P('makeup', 'Ganancia', 0, 24, 0, 'dB'), P('mix', 'Mezcla paralela', 0, 100, 100, '%')],
    create(ctx, p) {
      const inp = ctx.createGain(), c = ctx.createDynamicsCompressor(), mk = ctx.createGain(), wet = ctx.createGain(), dry = ctx.createGain(), out = ctx.createGain();
      inp.connect(c); c.connect(mk); mk.connect(wet); wet.connect(out); inp.connect(dry); dry.connect(out);
      const set = (k, v) => {
        if (k === 'makeup') mk.gain.value = dbToGain(v);
        else if (k === 'mix') { wet.gain.value = v / 100; dry.gain.value = 1 - v / 100; }
        else if (c[k]) c[k].value = v;
      };
      for (const k in p) set(k, p[k]);
      return { input: inp, output: out, set, comp: c };
    }
  },
  limiter: {
    name: 'Maximizador/Limitador', cat: 'Dinámica',
    params: [P('gain', 'Ganancia de entrada', 0, 24, 0, 'dB'), P('ceiling', 'Techo', -12, 0, -1, 'dBFS'), P('release', 'Liberación', 0.01, 1, 0.08, 's')],
    create(ctx, p) {
      const inp = ctx.createGain(), c = ctx.createDynamicsCompressor(), ceil = ctx.createGain();
      c.ratio.value = 20; c.attack.value = 0.0005; c.knee.value = 0; c.threshold.value = -1;
      inp.connect(c); c.connect(ceil);
      const set = (k, v) => { if (k === 'gain') inp.gain.value = dbToGain(v); if (k === 'ceiling') { c.threshold.value = v; ceil.gain.value = 1; } if (k === 'release') c.release.value = v; };
      for (const k in p) set(k, p[k]);
      return { input: inp, output: ceil, set, comp: c };
    }
  },
  gate: {
    name: 'Compuerta de ruido', cat: 'Dinámica', worklet: true,
    params: [P('threshold', 'Umbral', -90, 0, -45, 'dB'), P('range', 'Rango', -90, 0, -80, 'dB'), P('attack', 'Ataque', 0.0001, 0.2, 0.002, 's'), P('hold', 'Retención', 0, 1, 0.05, 's'), P('release', 'Liberación', 0.005, 2, 0.12, 's')],
    create(ctx, p) {
      const n = new AudioWorkletNode(ctx, 'mmx-gate', { outputChannelCount: [2] });
      const set = (k, v) => { const pr = n.parameters.get(k); if (pr) pr.value = v; };
      for (const k in p) set(k, p[k]);
      return { input: n, output: n, set };
    }
  },
  deesser: {
    name: 'De-Esser', cat: 'Dinámica', worklet: true,
    params: [P('freq', 'Frecuencia', 2000, 12000, 6500, 'Hz', { log: true }), P('threshold', 'Umbral', -60, 0, -30, 'dB'), P('reduction', 'Reducción máx.', -24, 0, -10, 'dB')],
    create(ctx, p) {
      const n = new AudioWorkletNode(ctx, 'mmx-deesser', { outputChannelCount: [2] });
      const set = (k, v) => { const pr = n.parameters.get(k); if (pr) pr.value = v; };
      for (const k in p) set(k, p[k]);
      return { input: n, output: n, set };
    }
  },
  reverb: {
    name: 'Reverberación Espacio', cat: 'Reverb',
    params: [P('size', 'Tamaño (s)', 0.2, 8, 2.2, 's'), P('decay', 'Caída', 0.5, 6, 2.5), P('predelay', 'Pre-retardo', 0, 0.2, 0.02, 's'), P('damp', 'Amortiguación', 0, 0.95, 0.4), P('mix', 'Mezcla', 0, 100, 25, '%')],
    create(ctx, p) {
      const inp = ctx.createGain(), conv = ctx.createConvolver(), wet = ctx.createGain(), dry = ctx.createGain(), out = ctx.createGain();
      inp.connect(dry); inp.connect(conv); conv.connect(wet); wet.connect(out); dry.connect(out);
      const st = { ...p };
      let t = null;
      const rebuild = () => { conv.buffer = makeIR(ctx, st.size, st.decay, st.predelay, st.damp); };
      const set = (k, v) => {
        st[k] = v;
        if (k === 'mix') { wet.gain.value = v / 100; dry.gain.value = 1 - (v / 100) * 0.5; }
        else { clearTimeout(t); t = setTimeout(rebuild, 60); }
      };
      rebuild(); set('mix', st.mix);
      return { input: inp, output: out, set };
    }
  },
  delay: {
    name: 'Retardo Mod', cat: 'Retardo',
    params: [P('time', 'Tiempo', 0.01, 2, 0.375, 's'), P('sync', 'Sincronía (0=libre,1/4..1/16)', 0, 16, 0, ''), P('feedback', 'Realimentación', 0, 95, 35, '%'), P('lowcut', 'Corte graves', 20, 2000, 150, 'Hz', { log: true }), P('highcut', 'Corte agudos', 1000, 20000, 6000, 'Hz', { log: true }), P('mix', 'Mezcla', 0, 100, 25, '%'), P('pingpong', 'Ping-pong (0/1)', 0, 1, 0, '', { step: 1 })],
    create(ctx, p, env = {}) {
      const inp = ctx.createGain(), out = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain();
      const dL = ctx.createDelay(4), dR = ctx.createDelay(4), fb = ctx.createGain(), hp = ctx.createBiquadFilter(), lp = ctx.createBiquadFilter();
      const merger = ctx.createChannelMerger(2);
      hp.type = 'highpass'; lp.type = 'lowpass';
      inp.connect(dry); dry.connect(out);
      inp.connect(hp); hp.connect(lp); lp.connect(dL); dL.connect(fb); fb.connect(dR); dR.connect(merger, 0, 1); dL.connect(merger, 0, 0);
      const fb2 = ctx.createGain(); dR.connect(fb2); fb2.connect(hp);
      merger.connect(wet); wet.connect(out);
      const st = { ...p };
      const apply = () => {
        const beat = 60 / (env.tempo || 120);
        const t = st.sync > 0 ? beat * 4 / st.sync : st.time;
        dL.delayTime.value = t; dR.delayTime.value = st.pingpong >= 0.5 ? t : 0.0001;
        fb.gain.value = st.pingpong >= 0.5 ? 1 : 1; fb2.gain.value = st.feedback / 100;
        hp.frequency.value = st.lowcut; lp.frequency.value = st.highcut;
        wet.gain.value = st.mix / 100;
      };
      const set = (k, v) => { st[k] = v; apply(); };
      apply();
      return { input: inp, output: out, set };
    }
  },
  chorus: {
    name: 'Coro/Flanger', cat: 'Modulación',
    params: [P('rate', 'Velocidad', 0.05, 8, 0.8, 'Hz'), P('depth', 'Profundidad', 0, 10, 3, 'ms'), P('delay', 'Retardo base', 0.5, 30, 12, 'ms'), P('feedback', 'Realimentación', 0, 90, 0, '%'), P('mix', 'Mezcla', 0, 100, 40, '%')],
    create(ctx, p) {
      const inp = ctx.createGain(), out = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain();
      const dl = ctx.createDelay(0.1), dr = ctx.createDelay(0.1), lfo = ctx.createOscillator(), dep = ctx.createGain(), depR = ctx.createGain(), fb = ctx.createGain(), mer = ctx.createChannelMerger(2);
      lfo.connect(dep); dep.connect(dl.delayTime); lfo.connect(depR); depR.connect(dr.delayTime);
      inp.connect(dry); dry.connect(out); inp.connect(dl); inp.connect(dr); dl.connect(fb); fb.connect(dl);
      dl.connect(mer, 0, 0); dr.connect(mer, 0, 1); mer.connect(wet); wet.connect(out);
      lfo.start();
      const set = (k, v) => {
        if (k === 'rate') lfo.frequency.value = v;
        if (k === 'depth') { dep.gain.value = v / 1000; depR.gain.value = -v / 1000; }
        if (k === 'delay') { dl.delayTime.value = v / 1000; dr.delayTime.value = v / 1000; }
        if (k === 'feedback') fb.gain.value = v / 100;
        if (k === 'mix') { wet.gain.value = v / 100; dry.gain.value = 1 - v / 200; }
      };
      for (const k in p) set(k, p[k]);
      return { input: inp, output: out, set, dispose: () => { try { lfo.stop(); } catch (e) { } } };
    }
  },
  saturator: {
    name: 'Saturación Cinta/Válvula', cat: 'Armónicos',
    params: [P('drive', 'Impulso', 0, 1, 0.25), P('type', 'Tipo (0 cinta, 1 válvula)', 0, 1, 0, '', { step: 1 }), P('tone', 'Tono', 1000, 20000, 12000, 'Hz', { log: true }), P('out', 'Salida', -24, 12, -2, 'dB'), P('mix', 'Mezcla', 0, 100, 100, '%')],
    create(ctx, p) {
      const inp = ctx.createGain(), ws = ctx.createWaveShaper(), tone = ctx.createBiquadFilter(), o = ctx.createGain(), wet = ctx.createGain(), dry = ctx.createGain(), out = ctx.createGain();
      ws.oversample = '4x'; tone.type = 'lowpass';
      inp.connect(ws); ws.connect(tone); tone.connect(o); o.connect(wet); wet.connect(out); inp.connect(dry); dry.connect(out);
      const st = { ...p };
      const set = (k, v) => {
        st[k] = v;
        if (k === 'drive' || k === 'type') ws.curve = satCurve(st.drive, st.type >= 0.5 ? 'tube' : 'tape');
        if (k === 'tone') tone.frequency.value = v;
        if (k === 'out') o.gain.value = dbToGain(v);
        if (k === 'mix') { wet.gain.value = v / 100; dry.gain.value = 1 - v / 100; }
      };
      for (const k in p) set(k, p[k]);
      return { input: inp, output: out, set };
    }
  },
  filter: {
    name: 'Filtro Barrido', cat: 'Filtro',
    params: [P('type', 'Tipo (0 LP,1 HP,2 BP)', 0, 2, 0, '', { step: 1 }), P('freq', 'Corte', 20, 20000, 2000, 'Hz', { log: true }), P('q', 'Resonancia', 0.1, 20, 1), P('lfoRate', 'LFO velocidad', 0, 10, 0, 'Hz'), P('lfoDepth', 'LFO profundidad', 0, 5000, 0, 'Hz')],
    create(ctx, p) {
      const f = ctx.createBiquadFilter(), lfo = ctx.createOscillator(), d = ctx.createGain();
      lfo.connect(d); d.connect(f.frequency); lfo.start();
      const set = (k, v) => {
        if (k === 'type') f.type = ['lowpass', 'highpass', 'bandpass'][Math.round(v)] || 'lowpass';
        if (k === 'freq') f.frequency.value = v; if (k === 'q') f.Q.value = v;
        if (k === 'lfoRate') lfo.frequency.value = v; if (k === 'lfoDepth') d.gain.value = v;
      };
      for (const k in p) set(k, p[k]);
      return { input: f, output: f, set, dispose: () => { try { lfo.stop(); } catch (e) { } } };
    }
  },
  tremolo: {
    name: 'Trémolo/Auto-paneo', cat: 'Modulación',
    params: [P('rate', 'Velocidad', 0.1, 20, 5, 'Hz'), P('depth', 'Profundidad', 0, 100, 50, '%'), P('pan', 'Auto-paneo (0/1)', 0, 1, 0, '', { step: 1 })],
    create(ctx, p) {
      const inp = ctx.createGain(), g = ctx.createGain(), pan = ctx.createStereoPanner(), lfo = ctx.createOscillator(), dg = ctx.createGain(), dp = ctx.createGain();
      inp.connect(g); g.connect(pan); lfo.connect(dg); dg.connect(g.gain); lfo.connect(dp); dp.connect(pan.pan); lfo.start();
      const st = { ...p };
      const apply = () => { lfo.frequency.value = st.rate; const d = st.depth / 100; if (st.pan >= 0.5) { dg.gain.value = 0; g.gain.value = 1; dp.gain.value = d; } else { dp.gain.value = 0; dg.gain.value = d / 2; g.gain.value = 1 - d / 2; } };
      const set = (k, v) => { st[k] = v; apply(); }; apply();
      return { input: inp, output: pan, set, dispose: () => { try { lfo.stop(); } catch (e) { } } };
    }
  },
  stereo: {
    name: 'Imagen estéreo', cat: 'Utilidad',
    params: [P('width', 'Anchura', 0, 200, 100, '%'), P('gain', 'Ganancia', -24, 24, 0, 'dB'), P('phaseL', 'Invertir fase I (0/1)', 0, 1, 0, '', { step: 1 }), P('mono', 'Mono (0/1)', 0, 1, 0, '', { step: 1 })],
    create(ctx, p) {
      const inp = ctx.createGain(), sp = ctx.createChannelSplitter(2), mer = ctx.createChannelMerger(2);
      // M = (L+R)/2 ; S = (L-R)/2 ; L' = M + wS ; R' = M - wS
      const lM = ctx.createGain(), rM = ctx.createGain(), lS = ctx.createGain(), rS = ctx.createGain();
      const M = ctx.createGain(), S = ctx.createGain(), sW = ctx.createGain(), sWn = ctx.createGain(), out = ctx.createGain(), inv = ctx.createGain();
      inp.connect(sp); sp.connect(inv, 0); inv.connect(lM); inv.connect(lS); sp.connect(rM, 1); sp.connect(rS, 1);
      lM.gain.value = 0.5; rM.gain.value = 0.5; lS.gain.value = 0.5; rS.gain.value = -0.5;
      lM.connect(M); rM.connect(M); lS.connect(S); rS.connect(S);
      S.connect(sW); S.connect(sWn); sWn.gain.value = -1;
      M.connect(mer, 0, 0); M.connect(mer, 0, 1); sW.connect(mer, 0, 0); sWn.connect(mer, 0, 1);
      mer.connect(out);
      const st = { ...p };
      const apply = () => { const w = st.mono >= 0.5 ? 0 : st.width / 100; sW.gain.value = w; sWn.gain.value = -w; out.gain.value = dbToGain(st.gain); inv.gain.value = st.phaseL >= 0.5 ? -1 : 1; };
      const set = (k, v) => { st[k] = v; apply(); }; apply();
      return { input: inp, output: out, set };
    }
  },
  pitchrt: {
    name: 'Desafinador/Doblador', cat: 'Tono',
    params: [P('cents', 'Desafinación', 0, 50, 12, 'cents'), P('delay', 'Retardo', 5, 40, 18, 'ms'), P('mix', 'Mezcla', 0, 100, 50, '%')],
    create(ctx, p) {
      // Doblador de voz: dos retardos modulados lentamente desfasados (ADT)
      const inp = ctx.createGain(), out = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain();
      const d1 = ctx.createDelay(0.1), d2 = ctx.createDelay(0.1), l1 = ctx.createOscillator(), l2 = ctx.createOscillator(), g1 = ctx.createGain(), g2 = ctx.createGain(), mer = ctx.createChannelMerger(2);
      l1.frequency.value = 0.31; l2.frequency.value = 0.27; l1.connect(g1); g1.connect(d1.delayTime); l2.connect(g2); g2.connect(d2.delayTime); l1.start(); l2.start();
      inp.connect(dry); dry.connect(out); inp.connect(d1); inp.connect(d2); d1.connect(mer, 0, 0); d2.connect(mer, 0, 1); mer.connect(wet); wet.connect(out);
      const st = { ...p };
      const apply = () => { d1.delayTime.value = st.delay / 1000; d2.delayTime.value = st.delay / 1000 * 1.3; g1.gain.value = st.cents / 12000; g2.gain.value = st.cents / 11000; wet.gain.value = st.mix / 100; dry.gain.value = 1 - st.mix / 200; };
      const set = (k, v) => { st[k] = v; apply(); }; apply();
      return { input: inp, output: out, set, dispose: () => { try { l1.stop(); l2.stop(); } catch (e) { } } };
    }
  }
};

export function defaultParams(type) {
  const o = {}; for (const p of PLUGINS[type].params) o[p.key] = p.def; return o;
}

export function createInsert(ctx, ins, env) {
  const def = PLUGINS[ins.type]; if (!def) return null;
  try { return def.create(ctx, { ...defaultParams(ins.type), ...ins.params }, env); }
  catch (e) { console.warn('No se pudo crear el complemento', ins.type, e); return null; }
}
