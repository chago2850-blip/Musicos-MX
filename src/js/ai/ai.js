// Músicos MX — funciones de inteligencia artificial y análisis musical (todo local y libre)
// Copyright (C) 2026 Santiago Miguel — GNU GPL v3 o posterior.
import { stft, istft, hpss, mono, integratedLUFS, truePeakDb, bandSpectrum, THIRD_OCT, pitchTrack, detectTempo, detectKey, detectOnsets, rmsOf, peakOf, yieldUI, hann, resample } from './dsp.js';
import { freqToMidi, midiToFreq, NOTE_NAMES } from '../util.js';

export const SCALES = {
  mayor: [0, 2, 4, 5, 7, 9, 11], menor: [0, 2, 3, 5, 7, 8, 10], 'menor armónica': [0, 2, 3, 5, 7, 8, 11],
  dórica: [0, 2, 3, 5, 7, 9, 10], mixolidia: [0, 2, 4, 5, 7, 9, 10], 'pentatónica mayor': [0, 2, 4, 7, 9], 'pentatónica menor': [0, 3, 5, 7, 10], blues: [0, 3, 5, 6, 7, 10], cromática: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
};
export const KEYS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function makeBuffer(ctx, chans, sr) { const b = ctx.createBuffer(chans.length, chans[0].length, sr); chans.forEach((c, i) => b.copyToChannel(c, i)); return b; }

// ================= SEPARADOR DE STEMS =================
// Separación espectral por bloques: HPSS (armónico/percusivo) + máscara de fuente central + bandas.
export async function separateStems(ctx, buffer, progress = () => { }) {
  const sr = buffer.sampleRate;
  const L = buffer.getChannelData(0), R = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : L;
  const len = L.length;
  const out = { voz: [new Float32Array(len), new Float32Array(len)], bateria: [new Float32Array(len), new Float32Array(len)], bajo: [new Float32Array(len), new Float32Array(len)], otros: [new Float32Array(len), new Float32Array(len)] };
  const chunk = Math.round(sr * 12), pad = Math.round(sr * 0.75);
  const n = 2048, hop = 512, binHz = sr / n;
  const nChunks = Math.ceil(len / chunk);
  for (let ci = 0; ci < nChunks; ci++) {
    const a = ci * chunk, b = Math.min(len, a + chunk), s = Math.max(0, a - pad), e = Math.min(len, b + pad);
    const l = L.subarray(s, e), r = R.subarray(s, e), m = new Float32Array(e - s);
    for (let i = 0; i < m.length; i++) m[i] = (l[i] + r[i]) * 0.5;
    const rep = (x) => progress((ci + x) / nChunks);
    const SL = await stft(l, n, hop), SR = await stft(r, n, hop), SM = await stft(m, n, hop);
    rep(0.3);
    const { harmonic, percussive } = await hpss(SM, (p) => rep(0.3 + p * 0.4));
    const F = SM.mags.length, B = SM.mags[0].length;
    const mk = { voz: [], bateria: [], bajo: [], otros: [] };
    for (let f = 0; f < F; f++) {
      const v = new Float32Array(B), d = new Float32Array(B), ba = new Float32Array(B), o = new Float32Array(B);
      for (let k = 0; k < B; k++) {
        const hz = k * binHz;
        const mL = SL.mags[f][k], mR = SR.mags[f][k];
        const sim = (2 * mL * mR * Math.cos(SL.phs[f][k] - SR.phs[f][k])) / (mL * mL + mR * mR + 1e-12);
        const center = Math.pow(Math.max(0, sim), 6);
        const H = harmonic[f][k], P = percussive[f][k];
        const lowBand = hz < 160 ? 1 : hz < 260 ? (260 - hz) / 100 : 0;
        const vocBand = hz < 120 ? 0 : hz < 200 ? (hz - 120) / 80 : hz < 9000 ? 1 : Math.max(0, 1 - (hz - 9000) / 4000);
        let dr = P * (hz < 100 ? 0.9 : 1);
        let bs = H * lowBand;
        let vc = H * center * vocBand;
        const rest = Math.max(0, 1 - dr - bs - vc);
        d[k] = dr; ba[k] = bs; v[k] = vc; o[k] = rest;
      }
      mk.voz.push(v); mk.bateria.push(d); mk.bajo.push(ba); mk.otros.push(o);
    }
    rep(0.75);
    let j = 0;
    for (const key of Object.keys(mk)) {
      const yl = await istft(SL, mk[key]), yr = await istft(SR, mk[key]);
      out[key][0].set(yl.subarray(a - s, a - s + (b - a)), a);
      out[key][1].set(yr.subarray(a - s, a - s + (b - a)), a);
      rep(0.75 + (++j) * 0.06);
    }
    await yieldUI();
  }
  progress(1);
  const res = {};
  for (const k in out) res[k] = makeBuffer(ctx, out[k], sr);
  return res;
}

// ================= TRANSCRIPCIÓN DE VOZ A TEXTO (Whisper) =================
let whisperPipe = null;
export async function transcribe(buffer, opts = {}, progress = () => { }) {
  const model = opts.model || 'Xenova/whisper-base';
  if (!whisperPipe || whisperPipe._model !== model) {
    progress(0.02, 'Descargando modelo de IA Whisper (solo la primera vez)…');
    const dynImport = new Function('u', 'return import(u)');
    const tf = await dynImport('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.1');
    whisperPipe = await tf.pipeline('automatic-speech-recognition', model, {
      progress_callback: (p) => { if (p.status === 'progress' && p.total) progress(0.05 + 0.4 * (p.loaded / p.total), 'Descargando ' + (p.file || 'modelo') + '…'); }
    });
    whisperPipe._model = model;
  }
  progress(0.5, 'Transcribiendo…');
  const x = mono(buffer);
  const pcm = resample(x, 16000 / buffer.sampleRate);
  const r = await whisperPipe(pcm, { return_timestamps: true, chunk_length_s: 30, stride_length_s: 5, language: opts.language || 'spanish', task: 'transcribe' });
  progress(1);
  return (r.chunks || [{ text: r.text, timestamp: [0, buffer.duration] }]).map(c => ({ text: c.text.trim(), start: c.timestamp[0] ?? 0, end: c.timestamp[1] ?? buffer.duration }));
}

// ================= ANÁLISIS =================
export function analyze(buffer) {
  const x = mono(buffer);
  const lufs = integratedLUFS(buffer);
  const peak = 20 * Math.log10(peakOf([...Array(buffer.numberOfChannels)].map((_, i) => buffer.getChannelData(i))) || 1e-9);
  const rms = 20 * Math.log10(rmsOf(x) || 1e-9);
  const bands = bandSpectrum(x, buffer.sampleRate);
  // centroide espectral aproximado
  let num = 0, den = 0; bands.forEach((b, i) => { const p = Math.pow(10, b / 10); num += THIRD_OCT[i] * p; den += p; });
  return { lufs, peak, rms, crest: peak - rms, bands, centroid: num / (den || 1) };
}
export function analyzeMusic(buffer) {
  const x = mono(buffer);
  const tempo = detectTempo(x, buffer.sampleRate);
  const key = detectKey(x, buffer.sampleRate);
  return { tempo, key: KEYS[key.root], mode: key.mode, keyName: NOTE_NAMES[key.root] + ' ' + key.mode, confidence: key.confidence };
}

// Clasifica el rol de una pista por nombre y espectro
export function guessRole(name, an) {
  const n = (name || '').toLowerCase();
  const rules = [['bombo', /kick|bombo|bd\b/], ['tarola', /snare|tarola|caja|sd\b/], ['hihat', /hat|hh|charles/], ['bateria', /drum|bater|perc|room|oh\b|overhead|tom/], ['bajo', /bass|bajo|sub/], ['voz', /vox|voz|vocal|voice|lead|cant|coro|choir|bv/], ['guitarra', /gtr|guit|requinto/], ['teclado', /key|piano|teclad|synth|organ|pad/], ['metales', /brass|trompet|sax|metal|trombon/], ['cuerdas', /string|cuerda|violin|viol/]];
  for (const [r, re] of rules) if (re.test(n)) return r;
  if (!an) return 'otro';
  if (an.centroid < 250) return 'bajo';
  if (an.crest > 18) return 'bateria';
  if (an.centroid > 3000) return 'hihat';
  return 'otro';
}

const ROLE_TARGET = { bombo: -18, tarola: -19, bateria: -20, hihat: -27, bajo: -19, voz: -16, guitarra: -22, teclado: -23, metales: -22, cuerdas: -23, otro: -22 };
const ROLE_PAN = { bombo: 0, tarola: 0, bajo: 0, voz: 0, hihat: 0.3, guitarra: -0.45, teclado: 0.4, metales: -0.3, cuerdas: 0.35, bateria: 0, otro: 0.2 };

// ================= ASISTENTE DE MEZCLA AUTOMÁTICA =================
// Devuelve una lista de cambios sugeridos; la interfaz los aplica en un solo paso deshacible.
export async function autoMixPlan(store, renderTrack, progress = () => { }) {
  const tracks = store.project.tracks.filter(t => (t.type === 'audio' || t.type === 'instrument' || t.type === 'midi') && !t.inactive);
  const plan = []; let i = 0;
  const panUse = {};
  for (const t of tracks) {
    progress(i / tracks.length, 'Analizando ' + t.name + '…');
    const buf = await renderTrack(t);
    i++;
    if (!buf) continue;
    const an = analyze(buf);
    if (an.lufs < -65) continue;
    const role = guessRole(t.name, an);
    const target = ROLE_TARGET[role] ?? -22;
    const vol = Math.max(-30, Math.min(10, t.volume + (target - an.lufs)));
    // paneo alternado para roles repetidos
    let pan = ROLE_PAN[role] ?? 0; panUse[role] = (panUse[role] || 0) + 1;
    if (pan !== 0 && panUse[role] % 2 === 0) pan = -pan;
    // EQ: corte de graves en todo menos bombo/bajo; reducción de barro 250-400 Hz si sobresale
    const b = an.bands, idx = (f) => THIRD_OCT.indexOf(f);
    const avg = b.reduce((s, v) => s + v, 0) / b.length;
    const mud = ((b[idx(250)] + b[idx(315)] + b[idx(400)]) / 3) - avg;
    const harsh = ((b[idx(2500)] + b[idx(3150)] + b[idx(4000)]) / 3) - avg;
    const eq = {
      hpf: ['bombo', 'bajo', 'bateria'].includes(role) ? 30 : role === 'voz' ? 90 : 70,
      p1F: 315, p1G: mud > 3 ? -Math.min(5, mud - 2) : 0, p1Q: 1.2,
      p3F: 3150, p3G: harsh > 4 ? -Math.min(4, harsh - 3) : 0, p3Q: 1.4,
      hsF: 10000, hsG: role === 'voz' ? 2 : 0, lsF: 100, lsG: role === 'bombo' ? 2 : 0
    };
    // Compresión según factor de cresta
    const comp = an.crest > 14 ? { threshold: Math.round(an.peak - 12), ratio: role === 'voz' ? 3.5 : 3, attack: role === 'voz' ? 0.008 : 0.02, release: 0.15, knee: 6, makeup: 2 } : null;
    plan.push({ trackId: t.id, name: t.name, role, lufs: an.lufs, volume: Math.round(vol * 10) / 10, pan: Math.round(pan * 100) / 100, eq, comp, deesser: role === 'voz' });
    await yieldUI();
  }
  progress(1);
  return plan;
}

// ================= MASTERIZACIÓN ASISTIDA =================
export const MASTER_TARGETS = { 'Streaming (Spotify/YouTube) −14 LUFS': -14, 'Apple Music −16 LUFS': -16, 'Club/Fuerte −9 LUFS': -9, 'Radio/TV (EBU R128) −23 LUFS': -23, 'Podcast −16 LUFS': -16, 'CD −10 LUFS': -10 };
export function masterPlan(mixBuffer, targetLufs = -14, refBuffer = null) {
  const an = analyze(mixBuffer);
  const plan = { analysis: an, target: targetLufs };
  // EQ por coincidencia de referencia (o curva tonal promedio)
  let refBands = null;
  if (refBuffer) refBands = analyze(refBuffer).bands;
  const b = an.bands;
  const group = (lo, hi) => { let s = 0, k = 0; THIRD_OCT.forEach((f, i) => { if (f >= lo && f <= hi) { s += b[i]; k++; } }); return s / k; };
  const groupR = (lo, hi) => { let s = 0, k = 0; THIRD_OCT.forEach((f, i) => { if (f >= lo && f <= hi) { s += refBands[i]; k++; } }); return s / k; };
  const clampG = (v) => Math.max(-4, Math.min(4, Math.round(v * 10) / 10));
  let eq;
  if (refBands) {
    const off = (group(200, 4000) - groupR(200, 4000));
    eq = { lsF: 90, lsG: clampG(groupR(31, 125) - group(31, 125) + off), p1F: 300, p1G: clampG(groupR(200, 400) - group(200, 400) + off), p1Q: 0.9, p2F: 1500, p2G: clampG(groupR(800, 2500) - group(800, 2500) + off), p2Q: 0.7, p3F: 4000, p3G: clampG(groupR(3000, 6300) - group(3000, 6300) + off), p3Q: 0.9, hsF: 10000, hsG: clampG(groupR(8000, 16000) - group(8000, 16000) + off), hpf: 25 };
  } else {
    // curva objetivo: inclinación natural ~ -4.5 dB/octava desde graves a agudos
    const tilt = group(31, 125) - group(8000, 16000);
    eq = { lsF: 90, lsG: clampG((24 - tilt) * -0.15), p1F: 300, p1G: clampG(-(group(200, 400) - group(500, 2000)) * 0.3), p1Q: 0.9, hsF: 10000, hsG: clampG((tilt - 24) * 0.15), hpf: 25 };
  }
  plan.eq = eq;
  plan.comp = { threshold: Math.round(an.rms + 4), ratio: 2, attack: 0.03, release: 0.25, knee: 10, makeup: 0, mix: 100 };
  // ganancia del limitador para llegar al objetivo (estimación con margen; se refina tras un render)
  plan.limiter = { gain: Math.max(0, Math.min(20, Math.round((targetLufs - an.lufs) * 10) / 10)), ceiling: -1, release: 0.08 };
  plan.stereo = { width: an.centroid < 1500 ? 110 : 105, gain: 0 };
  return plan;
}

// ================= AUDIO A MIDI =================
export async function audioToMidi(buffer, opts = {}, progress = () => { }) {
  const x = mono(buffer), sr = buffer.sampleRate;
  if (opts.mode === 'percusion') {
    const on = detectOnsets(x, sr, 1.4);
    return on.map(t => ({ p: opts.drumNote || 36, t, d: 0.1, v: 100 }));
  }
  const tr = await pitchTrack(x, sr, 0.01, progress);
  const notes = []; let cur = null;
  const maxR = Math.max(...tr.map(f => f.rms), 1e-6);
  for (const f of tr) {
    const m = f.f > 0 && f.conf > 0.8 ? Math.round(freqToMidi(f.f)) : null;
    if (cur && (m === null || Math.abs(m - cur.p) >= 1)) {
      if (f.t - cur.t > 0.06) notes.push({ p: cur.p, t: cur.t, d: f.t - cur.t, v: Math.round(40 + 87 * Math.min(1, cur.vel / maxR)) });
      cur = null;
    }
    if (m !== null && !cur) cur = { p: m, t: f.t, vel: f.rms };
    if (cur) cur.vel = Math.max(cur.vel, f.rms);
  }
  return notes;
}

// ================= AFINACIÓN AUTOMÁTICA (corrección de tono) =================
export async function autoTune(buffer, { key = 'C', scale = 'mayor', strength = 1, speed = 0.3 } = {}, progress = () => { }) {
  const sr = buffer.sampleRate, root = KEYS.indexOf(key), sc = SCALES[scale] || SCALES.mayor;
  const x = mono(buffer);
  const tr = await pitchTrack(x, sr, 0.005, p => progress(p * 0.5));
  // relación de corrección por cuadro, suavizada (velocidad de reafinación)
  const ratios = new Float32Array(tr.length); let r = 1;
  for (let i = 0; i < tr.length; i++) {
    const f = tr[i]; let target = 1;
    if (f.f > 0 && f.conf > 0.75) {
      const m = freqToMidi(f.f); let best = m, bd = 99;
      for (let o = -1; o <= 10; o++) for (const s of sc) { const n = (o + 1) * 12 + root + s; const d = Math.abs(n - m); if (d < bd) { bd = d; best = n; } }
      target = Math.pow(2, ((best - m) * strength) / 12);
    }
    r += (target - r) * (1 - Math.min(0.98, speed));
    ratios[i] = r;
  }
  const hopT = 0.005;
  const chans = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    chans.push(await granularShift(buffer.getChannelData(c), sr, (t) => ratios[Math.min(ratios.length - 1, Math.max(0, Math.round((t - 0.0232) / hopT)))] || 1, p => progress(0.5 + (c + p) / buffer.numberOfChannels * 0.5)));
  }
  return chans;
}
// Desplazamiento de tono variable por granos con alineación por correlación (SOLA)
export async function granularShift(x, sr, ratioAt, progress) {
  const N = Math.round(sr * 0.04) & ~1, Hs = N >> 2, w = hann(N), tol = Math.round(sr * 0.006);
  const y = new Float32Array(x.length + N), norm = new Float32Array(x.length + N);
  const g = new Float32Array(N);
  for (let k = 0, pos = 0; pos < x.length; k++, pos += Hs) {
    const r = ratioAt(pos / sr);
    // grano re-muestreado: lee N*r muestras centradas en pos
    const cIn = pos + N / 2, span = N * r;
    for (let j = 0; j < N; j++) { const p = cIn - span / 2 + j * r; const a = Math.floor(p), f = p - a; g[j] = ((x[a] || 0) * (1 - f) + (x[a + 1] || 0) * f); }
    let best = 0;
    if (k > 0 && Math.abs(r - 1) > 0.001) {
      let bc = -Infinity;
      for (let d = -tol; d <= tol; d += 2) { let c = 0; for (let j = 0; j < N - Hs; j += 3) { const yi = pos + j + d; if (yi < 0) continue; c += g[j] * w[j] * (y[yi] / (norm[yi] || 1)); } if (c > bc) { bc = c; best = d; } }
    }
    for (let j = 0; j < N; j++) { const yi = pos + j + best; if (yi < 0 || yi >= y.length) continue; y[yi] += g[j] * w[j]; norm[yi] += w[j]; }
    if (k % 1000 === 0) { progress?.(pos / x.length); await yieldUI(); }
  }
  const out = new Float32Array(x.length);
  // las primeras N/2 muestras corresponden al centro del primer grano
  for (let i = 0; i < x.length; i++) out[i] = norm[i] > 0.05 ? y[i] / norm[i] : 0;
  return out;
}

// ================= SELECCIÓN AUTOMÁTICA DE TOMAS (auto-comping) =================
export async function scoreTakes(store, track, renderClip, segLen) {
  // evalúa cada lista de reproducción por segmento: penaliza recortes, ruido y nivel inconsistente
  const scores = [];
  for (let pi = 0; pi < track.playlists.length; pi++) {
    const pl = track.playlists[pi];
    const s = [];
    for (const c of pl.clips) {
      if (c.kind !== 'audio') continue;
      const buf = await renderClip(c); if (!buf) continue;
      const x = mono(buf), sr = buf.sampleRate;
      const segN = Math.round(segLen * sr);
      for (let a = 0; a < x.length; a += segN) {
        const seg = x.subarray(a, Math.min(x.length, a + segN));
        let clips = 0; for (let i = 0; i < seg.length; i++) if (Math.abs(seg[i]) > 0.985) clips++;
        const rms = rmsOf(seg); const pk = peakOf([seg]);
        const crest = 20 * Math.log10((pk + 1e-9) / (rms + 1e-9));
        const score = 20 * Math.log10(rms + 1e-9) - clips * 0.5 - Math.abs(crest - 14) * 0.6;
        s.push({ t: c.start + a / sr, score, playlist: pi });
      }
    }
    scores.push(s);
  }
  return scores;
}

// ================= COMPOSITOR IA (patrones, acordes, bajo y melodía) =================
export const GENRES = {
  'Pop': { bpm: 110, kick: [0, 8], snare: [4, 12], hat: 'x8', swing: 0 },
  'Rock': { bpm: 124, kick: [0, 6, 8], snare: [4, 12], hat: 'x8', swing: 0 },
  'Cumbia': { bpm: 95, kick: [0, 8], snare: [], guiro: true, hat: 'off', conga: [2, 6, 10, 14], swing: 0 },
  'Reggaetón': { bpm: 92, kick: [0, 4, 8, 12], snare: [3, 6, 11, 14], hat: 'x8', swing: 0 },
  'Hip-hop': { bpm: 88, kick: [0, 7, 10], snare: [4, 12], hat: 'x16', swing: 0.12 },
  'House': { bpm: 124, kick: [0, 4, 8, 12], snare: [4, 12], clap: true, hat: 'off', swing: 0 },
  'Balada': { bpm: 72, kick: [0, 10], snare: [8], hat: 'x8', swing: 0 },
  'Norteño/Polka': { bpm: 140, kick: [0, 4, 8, 12], snare: [2, 6, 10, 14], hat: 'none', swing: 0 },
  'Bolero': { bpm: 80, kick: [0, 8], snare: [], bongo: true, hat: 'x8', swing: 0 },
  'Trap': { bpm: 140, kick: [0, 11], snare: [8], hat: 'x16r', swing: 0 },
  'Funk': { bpm: 104, kick: [0, 3, 10], snare: [4, 12, 15], hat: 'x16', swing: 0.08 },
  'Jazz': { bpm: 130, kick: [0], snare: [], ride: true, hat: 'pedal', swing: 0.33 }
};
const rnd = (seed) => () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };

export function generateDrums(genre, bars, tempo, opts = {}) {
  const G = GENRES[genre] || GENRES.Pop, r = rnd(opts.seed ?? Math.floor(Math.random() * 1e6));
  const s16 = 60 / tempo / 4, notes = [], var_ = opts.variation ?? 0.3;
  const add = (p, step, bar, v, d = 0.1) => { let t = (bar * 16 + step) * s16; if (step % 2 === 1) t += s16 * (G.swing || 0); notes.push({ p, t, d, v: Math.max(1, Math.min(127, Math.round(v))) }); };
  for (let bar = 0; bar < bars; bar++) {
    const fill = opts.fills !== false && (bar % 4 === 3) && r() < 0.8;
    for (let s = 0; s < 16; s++) {
      if (fill && s >= 12) { const tom = [50, 48, 47, 45][s - 12]; add(tom, s, bar, 95 + r() * 20); if (s === 15 && bar === bars - 1) add(49, 15, bar, 100); continue; }
      if (G.kick.includes(s) || (r() < var_ * 0.12 && s % 2 === 0 && s > 0)) add(36, s, bar, 105 + r() * 15);
      if (G.snare.includes(s)) add(38, s, bar, 100 + r() * 20);
      if (G.clap && G.snare.includes(s)) add(39, s, bar, 90);
      if (r() < var_ * 0.08 && !G.snare.includes(s) && s % 2 === 1 && G.snare.length) add(38, s, bar, 40 + r() * 20); // notas fantasma
      const h = G.hat;
      if (h === 'x8' && s % 2 === 0) add(42, s, bar, (s % 4 === 0 ? 85 : 65) + r() * 12);
      if (h === 'x16' && 1) add(42, s, bar, (s % 4 === 0 ? 85 : s % 2 === 0 ? 70 : 50) + r() * 12);
      if (h === 'x16r') { add(42, s, bar, 60 + r() * 30); if (r() < 0.15) { add(42, s + 0.5, bar, 55); } }
      if (h === 'off' && s % 4 === 2) add(46, s, bar, 75 + r() * 10, 0.2);
      if (h === 'pedal' && s % 8 === 4) add(44, s, bar, 70);
      if (G.ride && s % 4 === 0) add(51, s, bar, 80 + r() * 10); if (G.ride && s % 8 === 6) add(51, s, bar, 65);
      if (G.guiro) { if (s % 4 === 0) add(74, s, bar, 80, 0.2); if (s % 4 === 2 || s % 4 === 3) add(73, s, bar, 70); }
      if (G.conga && G.conga.includes(s)) add(r() < 0.5 ? 63 : 64, s, bar, 85 + r() * 15);
      if (G.bongo && s % 2 === 0) add(s % 4 === 0 ? 61 : 60, s, bar, 70 + r() * 25);
    }
    if (bar === 0 && opts.crash !== false) add(49, 0, 0, 100, 1);
  }
  return notes;
}

const PROGS_MAJ = [[1, 5, 6, 4], [1, 6, 4, 5], [6, 4, 1, 5], [1, 4, 5, 4], [2, 5, 1, 6], [1, 3, 4, 5], [4, 5, 3, 6], [1, 4, 1, 5]];
const PROGS_MIN = [[1, 6, 3, 7], [1, 4, 5, 1], [1, 7, 6, 7], [1, 6, 7, 1], [4, 5, 1, 1], [1, 3, 7, 6]];
export function generateChords(key, scale, bars, tempo, opts = {}) {
  const root = KEYS.indexOf(key), minor = /menor/.test(scale);
  const sc = minor ? SCALES['menor armónica'].map((v, i) => (i === 6 ? 10 : v)) : SCALES.mayor;
  const progs = minor ? PROGS_MIN : PROGS_MAJ;
  const prog = opts.progression || progs[Math.floor(Math.random() * progs.length)];
  const barLen = 60 / tempo * 4, notes = [], chords = [];
  for (let b = 0; b < bars; b++) {
    const deg = prog[b % prog.length] - 1;
    const tri = [0, 2, 4].map(k => sc[(deg + k) % 7] + 12 * Math.floor((deg + k) / 7));
    if (opts.seventh) tri.push(sc[(deg + 6) % 7] + 12 * Math.floor((deg + 6) / 7));
    const base = 48 + root;
    const chord = tri.map(i => base + i);
    chords.push({ t: b * barLen, degree: deg + 1, notes: chord });
    const pattern = opts.pattern || 'sostenido';
    if (pattern === 'sostenido') chord.forEach(p => notes.push({ p, t: b * barLen, d: barLen * 0.98, v: 80 }));
    else if (pattern === 'arpegio') { for (let s = 0; s < 8; s++) notes.push({ p: chord[[0, 1, 2, 1, 0, 2, 1, 2][s] % chord.length] + (s >= 4 ? 12 : 0), t: b * barLen + s * barLen / 8, d: barLen / 8, v: 75 }); }
    else { for (let s = 0; s < 4; s++) chord.forEach(p => notes.push({ p, t: b * barLen + s * barLen / 4 + (s % 2 ? barLen / 8 : 0), d: barLen / 8, v: s % 2 ? 70 : 90 })); }
  }
  return { notes, chords, progression: prog };
}
export function generateBass(chords, tempo, style = 'raíz', bars) {
  const barLen = 60 / tempo * 4, beat = barLen / 4, notes = [];
  for (const c of chords) {
    const r = c.notes[0] - 12, fifth = r + 7;
    if (style === 'raíz') notes.push({ p: r, t: c.t, d: barLen * 0.95, v: 100 });
    else if (style === 'cumbia') { notes.push({ p: r, t: c.t, d: beat * 0.9, v: 105 }); notes.push({ p: fifth - 12, t: c.t + beat * 2, d: beat * 0.9, v: 95 }); notes.push({ p: r, t: c.t + beat * 3, d: beat * 0.5, v: 85 }); }
    else if (style === 'caminante') for (let k = 0; k < 4; k++) notes.push({ p: [r, r + 4, fifth, r + 9][k], t: c.t + k * beat, d: beat * 0.9, v: 90 });
    else for (let k = 0; k < 8; k++) notes.push({ p: k % 4 === 3 ? fifth : r, t: c.t + k * beat / 2, d: beat / 2 * 0.8, v: k % 2 ? 80 : 100 });
  }
  return notes;
}
export function generateMelody(key, scale, bars, tempo, chords = []) {
  const root = KEYS.indexOf(key), sc = SCALES[scale] || SCALES.mayor, barLen = 60 / tempo * 4;
  const notes = []; let deg = 7 + Math.floor(Math.random() * 3); const r = Math.random;
  const rhythms = [[1, 1, 1, 1], [1.5, 0.5, 1, 1], [0.5, 0.5, 1, 2], [2, 1, 1], [1, 0.5, 0.5, 2], [0.75, 0.75, 0.5, 2]];
  let motif = rhythms[Math.floor(r() * rhythms.length)];
  for (let b = 0; b < bars; b++) {
    if (b % 4 === 2) motif = rhythms[Math.floor(r() * rhythms.length)];
    let t = 0;
    for (const len of motif) {
      const step = [-2, -1, -1, 0, 1, 1, 2, 3, -3][Math.floor(r() * 9)];
      deg = Math.max(3, Math.min(14, deg + step));
      // en tiempos fuertes, preferir notas del acorde
      const ch = chords[b % Math.max(1, chords.length)];
      let p = 60 + root + sc[deg % sc.length] + 12 * Math.floor(deg / sc.length) - 12;
      if (ch && t === 0) { const pcs = ch.notes.map(n => n % 12); let best = p, bd = 99; for (let o = -2; o <= 2; o++) for (const pc of pcs) { const c2 = Math.floor(p / 12) * 12 + pc + o * 12; if (Math.abs(c2 - p) < bd) { bd = Math.abs(c2 - p); best = c2; } } p = best; }
      if (r() > 0.1) notes.push({ p, t: b * barLen + t * barLen / 4, d: len * barLen / 4 * 0.9, v: 80 + Math.round(r() * 25) });
      t += len;
    }
  }
  return notes;
}

// Cuantizar notas MIDI a la rejilla con intensidad y swing
export function quantizeNotes(notes, grid, strength = 1, swing = 0) {
  return notes.map(n => {
    const k = Math.round(n.t / grid); let q = k * grid; if (k % 2 === 1) q += grid * swing;
    return { ...n, t: Math.max(0, n.t + (q - n.t) * strength) };
  });
}
// Humanizar: variaciones sutiles de tiempo y velocidad
export function humanize(notes, timeMs = 12, vel = 10) {
  return notes.map(n => ({ ...n, t: Math.max(0, n.t + (Math.random() - 0.5) * timeMs / 500), v: Math.max(1, Math.min(127, Math.round(n.v + (Math.random() - 0.5) * 2 * vel))) }));
}

// Detección de silencios (Strip Silence)
export function findSilence(buffer, thresholdDb = -48, minLen = 0.25, padPre = 0.01, padPost = 0.08) {
  const x = mono(buffer), sr = buffer.sampleRate, thr = Math.pow(10, thresholdDb / 20), win = Math.round(sr * 0.01);
  const regions = []; let inS = null;
  for (let i = 0; i < x.length; i += win) {
    let m = 0; for (let j = i; j < Math.min(x.length, i + win); j++) m = Math.max(m, Math.abs(x[j]));
    const t = i / sr;
    if (m > thr) { if (inS === null) inS = t; }
    else if (inS !== null) { regions.push([inS, t]); inS = null; }
  }
  if (inS !== null) regions.push([inS, x.length / sr]);
  // unir regiones cercanas
  const merged = [];
  for (const r of regions) { if (merged.length && r[0] - merged[merged.length - 1][1] < minLen) merged[merged.length - 1][1] = r[1]; else merged.push(r.slice()); }
  return merged.filter(r => r[1] - r[0] > 0.03).map(([a, b]) => [Math.max(0, a - padPre), Math.min(x.length / sr, b + padPost)]);
}
