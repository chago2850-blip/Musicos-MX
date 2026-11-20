// Músicos MX — biblioteca DSP: FFT, STFT, estiramiento de tiempo, tono, análisis
// Copyright (C) 2026 Santiago Miguel — GNU GPL v3 o posterior.

export const yieldUI = () => new Promise(r => setTimeout(r, 0));

// ---------- FFT radix-2 in-place ----------
const twCache = new Map();
function twiddles(n) {
  if (twCache.has(n)) return twCache.get(n);
  const c = new Float32Array(n / 2), s = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) { c[i] = Math.cos(-2 * Math.PI * i / n); s[i] = Math.sin(-2 * Math.PI * i / n); }
  const r = { c, s }; twCache.set(n, r); return r;
}
export function fft(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  const { c, s } = twiddles(n);
  for (let len = 2; len <= n; len <<= 1) {
    const step = n / len, half = len >> 1;
    for (let i = 0; i < n; i += len) for (let k = 0; k < half; k++) {
      const wr = c[k * step], wi = inverse ? -s[k * step] : s[k * step];
      const a = i + k, b = a + half;
      const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
      re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}
export function hann(n) { const w = new Float32Array(n); for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n); return w; }

// STFT -> {mag: Float32Array[], phase: Float32Array[]}
export async function stft(x, n = 2048, hop = 512, progress) {
  const w = hann(n), frames = Math.ceil((x.length + n) / hop);
  const mags = [], phs = [];
  const re = new Float32Array(n), im = new Float32Array(n);
  for (let f = 0; f < frames; f++) {
    const s = f * hop - n / 2;
    for (let i = 0; i < n; i++) { const k = s + i; re[i] = (k >= 0 && k < x.length ? x[k] : 0) * w[i]; im[i] = 0; }
    fft(re, im);
    const m = new Float32Array(n / 2 + 1), p = new Float32Array(n / 2 + 1);
    for (let i = 0; i <= n / 2; i++) { m[i] = Math.hypot(re[i], im[i]); p[i] = Math.atan2(im[i], re[i]); }
    mags.push(m); phs.push(p);
    if (f % 400 === 0) { progress?.(f / frames); await yieldUI(); }
  }
  return { mags, phs, n, hop, len: x.length };
}
export async function istft(S, masks, progress) {
  const { n, hop, len } = S, w = hann(n);
  const out = new Float32Array(len), norm = new Float32Array(len);
  const re = new Float32Array(n), im = new Float32Array(n);
  for (let f = 0; f < S.mags.length; f++) {
    const m = S.mags[f], p = S.phs[f], mk = masks ? masks[f] : null;
    for (let i = 0; i <= n / 2; i++) { const a = m[i] * (mk ? mk[i] : 1); re[i] = a * Math.cos(p[i]); im[i] = a * Math.sin(p[i]); }
    for (let i = 1; i < n / 2; i++) { re[n - i] = re[i]; im[n - i] = -im[i]; }
    fft(re, im, true);
    const s = f * hop - n / 2;
    for (let i = 0; i < n; i++) { const k = s + i; if (k >= 0 && k < len) { out[k] += re[i] * w[i]; norm[k] += w[i] * w[i]; } }
    if (f % 400 === 0) { progress?.(f / S.mags.length); await yieldUI(); }
  }
  for (let i = 0; i < len; i++) if (norm[i] > 1e-6) out[i] /= norm[i];
  return out;
}

// ---------- Utilidades ----------
export function mono(buffer) {
  const n = buffer.length, out = new Float32Array(n), ch = buffer.numberOfChannels;
  for (let c = 0; c < ch; c++) { const d = buffer.getChannelData(c); for (let i = 0; i < n; i++) out[i] += d[i] / ch; }
  return out;
}
export function peakOf(arrs) { let m = 0; for (const a of arrs) for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i]); if (v > m) m = v; } return m; }
export function rmsOf(a) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s / Math.max(1, a.length)); }

// Biquad simple para análisis fuera de línea
function biquad(x, b0, b1, b2, a1, a2) {
  const y = new Float32Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) { const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v; }
  return y;
}
function kWeight(x, sr) {
  // coeficientes BS.1770 recalculados para la frecuencia de muestreo
  let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  let K = Math.tan(Math.PI * f0 / sr), Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const s1 = biquad(x, (Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0);
  f0 = 38.13547087602444; Q = 0.5003270373238773; K = Math.tan(Math.PI * f0 / sr);
  a0 = 1 + K / Q + K * K;
  return biquad(s1, 1, -2, 1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0);
}
// Sonoridad integrada (LUFS) con compuertas absoluta y relativa
export function integratedLUFS(buffer) {
  const sr = buffer.sampleRate, chs = [];
  for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) chs.push(kWeight(buffer.getChannelData(c), sr));
  const blk = Math.round(0.4 * sr), hop = Math.round(0.1 * sr), z = [];
  for (let s = 0; s + blk <= chs[0].length; s += hop) {
    let sum = 0; for (const c of chs) { let a = 0; for (let i = s; i < s + blk; i++) a += c[i] * c[i]; sum += a / blk; }
    if (chs.length === 1) sum *= 2; // mono reproducido en ambos canales
    z.push(sum);
  }
  if (!z.length) return -70;
  const L = (v) => -0.691 + 10 * Math.log10(v);
  const abs = z.filter(v => L(v) > -70); if (!abs.length) return -70;
  const rel = L(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const g = abs.filter(v => L(v) > rel);
  return L(g.reduce((a, b) => a + b, 0) / g.length);
}
export function truePeakDb(buffer) {
  // sobremuestreo 4x por interpolación de Hermite (aproximación de pico verdadero)
  let m = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 1; i < d.length - 2; i++) {
      const y0 = d[i - 1], y1 = d[i], y2 = d[i + 1], y3 = d[i + 2];
      for (let k = 0; k < 4; k++) {
        const t = k / 4, c0 = y1, c1 = 0.5 * (y2 - y0), c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3, c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
        const v = Math.abs(((c3 * t + c2) * t + c1) * t + c0); if (v > m) m = v;
      }
    }
  }
  return 20 * Math.log10(m || 1e-9);
}

// Espectro promedio en bandas de 1/3 de octava (para EQ por referencia)
export const THIRD_OCT = [31, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000];
export function bandSpectrum(x, sr, n = 4096) {
  const re = new Float32Array(n), im = new Float32Array(n), w = hann(n), acc = new Float64Array(n / 2 + 1);
  let frames = 0;
  const step = Math.max(n, Math.floor(x.length / 300));
  for (let s = 0; s + n < x.length; s += step) {
    for (let i = 0; i < n; i++) { re[i] = x[s + i] * w[i]; im[i] = 0; }
    fft(re, im); for (let i = 0; i <= n / 2; i++) acc[i] += re[i] * re[i] + im[i] * im[i]; frames++;
  }
  const bands = THIRD_OCT.map(fc => {
    const lo = fc / Math.pow(2, 1 / 6), hi = fc * Math.pow(2, 1 / 6);
    let s = 0, k = 0; for (let i = Math.floor(lo / sr * n); i <= Math.ceil(hi / sr * n) && i <= n / 2; i++) { s += acc[i]; k++; }
    return 10 * Math.log10((s / Math.max(1, k) / Math.max(1, frames)) + 1e-12);
  });
  return bands;
}

// ---------- WSOLA: estirar tiempo sin cambiar el tono ----------
export async function timeStretch(x, factor, sr, progress) {
  // factor > 1 alarga; factor < 1 acorta
  const N = Math.round(sr * 0.05) & ~1, Hs = N >> 1, tol = Math.round(sr * 0.012);
  const w = hann(N);
  const outLen = Math.round(x.length * factor) + N;
  const y = new Float32Array(outLen), norm = new Float32Array(outLen);
  const Ha = Hs / factor;
  let prevStart = 0;
  for (let k = 0, i = 0; k * Hs < outLen - N; k++, i++) {
    const ideal = Math.round(k * Ha);
    let best = ideal;
    if (k > 0) {
      // buscar el desplazamiento que mejor continúa el segmento anterior
      const nat = prevStart + Hs; let bestC = -Infinity;
      for (let d = -tol; d <= tol; d += 2) {
        const s = ideal + d; if (s < 0 || s + Hs >= x.length) continue;
        let c = 0; for (let j = 0; j < Hs; j += 4) c += x[s + j] * (x[nat + j] || 0);
        if (c > bestC) { bestC = c; best = s; }
      }
    }
    if (best >= x.length) break;
    for (let j = 0; j < N; j++) { const v = x[best + j] || 0; y[k * Hs + j] += v * w[j]; norm[k * Hs + j] += w[j]; }
    prevStart = best;
    if (k % 500 === 0) { progress?.(k * Hs / outLen); await yieldUI(); }
  }
  const L = Math.round(x.length * factor), out = new Float32Array(L);
  for (let i = 0; i < L; i++) out[i] = norm[i] > 1e-3 ? y[i] / norm[i] : 0;
  return out;
}
export function resample(x, ratio) {
  // ratio > 1 => más muestras (tono más grave al reproducir a la misma tasa)
  const L = Math.floor(x.length * ratio), y = new Float32Array(L);
  for (let i = 0; i < L; i++) { const p = i / ratio, a = Math.floor(p), f = p - a; y[i] = (x[a] || 0) * (1 - f) + (x[a + 1] || 0) * f; }
  return y;
}
export async function pitchShift(x, semitones, sr, progress) {
  const r = Math.pow(2, semitones / 12);
  const st = await timeStretch(x, r, sr, progress);
  const y = resample(st, 1 / r);
  const out = new Float32Array(x.length); out.set(y.subarray(0, x.length)); return out;
}

// ---------- Detección de tono (YIN) ----------
export function yin(frame, sr, thr = 0.15, fmin = 60, fmax = 1100) {
  const W = frame.length >> 1, d = new Float32Array(W);
  const tmin = Math.floor(sr / fmax), tmax = Math.min(W - 1, Math.floor(sr / fmin));
  for (let t = 1; t <= tmax; t++) { let s = 0; for (let i = 0; i < W; i++) { const v = frame[i] - frame[i + t]; s += v * v; } d[t] = s; }
  let run = 0; d[0] = 1;
  for (let t = 1; t <= tmax; t++) { run += d[t]; d[t] = d[t] * t / (run || 1); }
  for (let t = tmin; t <= tmax; t++) {
    if (d[t] < thr) {
      while (t + 1 <= tmax && d[t + 1] < d[t]) t++;
      const a = d[t - 1] || d[t], b = d[t], c = d[t + 1] || d[t];
      const sh = (a - c) / (2 * (a - 2 * b + c) || 1);
      return { f: sr / (t + sh), conf: 1 - b };
    }
  }
  return { f: 0, conf: 0 };
}
export async function pitchTrack(x, sr, hopSec = 0.01, progress) {
  const N = 2048, hop = Math.round(sr * hopSec), out = [];
  const fr = new Float32Array(N);
  for (let s = 0, k = 0; s + N < x.length; s += hop, k++) {
    let e = 0; for (let i = 0; i < N; i++) { fr[i] = x[s + i]; e += fr[i] * fr[i]; }
    const rms = Math.sqrt(e / N);
    const r = rms > 0.01 ? yin(fr, sr) : { f: 0, conf: 0 };
    out.push({ t: (s + N / 2) / sr, f: r.f, conf: r.conf, rms });
    if (k % 200 === 0) { progress?.(s / x.length); await yieldUI(); }
  }
  return out;
}

// ---------- Ataques, tempo y tonalidad ----------
export function onsetEnvelope(x, sr, hop = 512) {
  const n = 1024, w = hann(n), re = new Float32Array(n), im = new Float32Array(n);
  let prev = new Float32Array(n / 2), env = [];
  for (let s = 0; s + n < x.length; s += hop) {
    for (let i = 0; i < n; i++) { re[i] = x[s + i] * w[i]; im[i] = 0; }
    fft(re, im); let flux = 0; const cur = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) { cur[i] = Math.log1p(100 * Math.hypot(re[i], im[i])); const d = cur[i] - prev[i]; if (d > 0) flux += d; }
    prev = cur; env.push(flux);
  }
  return { env, rate: sr / hop };
}
export function detectOnsets(x, sr, sensitivity = 1.5) {
  const { env, rate } = onsetEnvelope(x, sr), on = [];
  const W = 10;
  for (let i = 1; i < env.length - 1; i++) {
    let m = 0; for (let k = Math.max(0, i - W); k < Math.min(env.length, i + W); k++) m += env[k]; m /= 2 * W;
    if (env[i] > m * sensitivity && env[i] > env[i - 1] && env[i] >= env[i + 1] && env[i] > 1) {
      const t = i / rate; if (!on.length || t - on[on.length - 1] > 0.06) on.push(t);
    }
  }
  return on;
}
export function detectTempo(x, sr) {
  const { env, rate } = onsetEnvelope(x, sr);
  const mean = env.reduce((a, b) => a + b, 0) / env.length;
  const e = env.map(v => Math.max(0, v - mean));
  let best = 120, bestS = -1;
  for (let bpm = 60; bpm <= 200; bpm += 0.5) {
    const lag = rate * 60 / bpm; let s = 0;
    for (let i = 0; i + 2 * lag < e.length; i++) s += e[i] * (e[Math.round(i + lag)] + 0.5 * e[Math.round(i + 2 * lag)]);
    // preferencia suave por 90-140 BPM
    s *= Math.exp(-Math.pow(Math.log2(bpm / 115), 2) * 0.6);
    if (s > bestS) { bestS = s; best = bpm; }
  }
  return Math.round(best * 10) / 10;
}
const MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MIN = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
export function detectKey(x, sr) {
  const n = 8192, re = new Float32Array(n), im = new Float32Array(n), w = hann(n), chroma = new Float64Array(12);
  const step = Math.max(n, Math.floor(x.length / 200));
  for (let s = 0; s + n < x.length; s += step) {
    for (let i = 0; i < n; i++) { re[i] = x[s + i] * w[i]; im[i] = 0; } fft(re, im);
    for (let i = 4; i < n / 2; i++) { const f = i * sr / n; if (f < 55 || f > 2000) continue; const m = 69 + 12 * Math.log2(f / 440); chroma[((Math.round(m) % 12) + 12) % 12] += Math.hypot(re[i], im[i]); }
  }
  const corr = (prof, k) => { let sx = 0, sy = 0; for (let i = 0; i < 12; i++) { sx += chroma[(i + k) % 12]; sy += prof[i]; } sx /= 12; sy /= 12; let a = 0, b = 0, c = 0; for (let i = 0; i < 12; i++) { const dx = chroma[(i + k) % 12] - sx, dy = prof[i] - sy; a += dx * dy; b += dx * dx; c += dy * dy; } return a / Math.sqrt(b * c || 1); };
  let best = { k: 0, mode: 'mayor', r: -2 };
  for (let k = 0; k < 12; k++) { const a = corr(MAJ, k), b = corr(MIN, k); if (a > best.r) best = { k, mode: 'mayor', r: a }; if (b > best.r) best = { k, mode: 'menor', r: b }; }
  return { root: best.k, mode: best.mode, confidence: best.r };
}

// ---------- Reducción de ruido por compuerta espectral ----------
export async function spectralDenoise(x, sr, opts = {}, progress) {
  const { reduction = 18, sensitivity = 1.5, noiseProfile } = opts;
  const S = await stft(x, 2048, 512, p => progress?.(p * 0.4));
  const bins = S.mags[0].length;
  let prof = noiseProfile;
  if (!prof) {
    // estimar el perfil de ruido con el percentil 10 de energía por bin
    prof = new Float32Array(bins);
    const energies = S.mags.map(m => m.reduce((a, b) => a + b, 0));
    const idx = energies.map((e, i) => [e, i]).sort((a, b) => a[0] - b[0]).slice(0, Math.max(3, Math.floor(energies.length * 0.1))).map(v => v[1]);
    for (const i of idx) for (let b = 0; b < bins; b++) prof[b] += S.mags[i][b] / idx.length;
  }
  const floor = Math.pow(10, -reduction / 20);
  const masks = S.mags.map(m => { const k = new Float32Array(bins); for (let b = 0; b < bins; b++) k[b] = m[b] > prof[b] * sensitivity * 1.5 ? 1 : floor; return k; });
  // suavizado temporal y frecuencial de la máscara
  for (let f = 1; f < masks.length - 1; f++) for (let b = 1; b < bins - 1; b++) masks[f][b] = (masks[f][b] * 2 + masks[f - 1][b] + masks[f + 1][b] + masks[f][b - 1] + masks[f][b + 1]) / 6;
  return await istft(S, masks, p => progress?.(0.4 + p * 0.6));
}

// ---------- Separación armónico/percusiva y de fuente central ----------
function medianFilter(arr, k) {
  const n = arr.length, out = new Float32Array(n), h = k >> 1, win = [];
  for (let i = 0; i < n; i++) {
    win.length = 0; for (let j = i - h; j <= i + h; j++) win.push(arr[Math.min(n - 1, Math.max(0, j))]);
    win.sort((a, b) => a - b); out[i] = win[h];
  }
  return out;
}
export async function hpss(S, progress) {
  const F = S.mags.length, B = S.mags[0].length;
  const harm = S.mags.map(() => new Float32Array(B)), perc = S.mags.map(() => new Float32Array(B));
  const col = new Float32Array(F);
  for (let b = 0; b < B; b++) {
    for (let f = 0; f < F; f++) col[f] = S.mags[f][b];
    const m = medianFilter(col, 17); for (let f = 0; f < F; f++) harm[f][b] = m[f];
    if (b % 64 === 0) { progress?.(b / B * 0.5); await yieldUI(); }
  }
  for (let f = 0; f < F; f++) { perc[f] = medianFilter(S.mags[f], 17); if (f % 300 === 0) { progress?.(0.5 + f / F * 0.5); await yieldUI(); } }
  const mh = [], mp = [];
  for (let f = 0; f < F; f++) {
    const a = new Float32Array(B), c = new Float32Array(B);
    for (let b = 0; b < B; b++) { const H = harm[f][b] ** 2, P = perc[f][b] ** 2, s = H + P + 1e-12; a[b] = H / s; c[b] = P / s; }
    mh.push(a); mp.push(c);
  }
  return { harmonic: mh, percussive: mp };
}
