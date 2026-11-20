// Músicos MX — Estación de trabajo de audio digital libre
// Copyright (C) 2026 Santiago Miguel
// Licencia: GNU GPL v3 o posterior. Ver LICENSE.

export const uid = (p = 'id') => p + '_' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const dbToGain = (db) => (db <= -144 ? 0 : Math.pow(10, db / 20));
export const gainToDb = (g) => (g <= 0.0000001 ? -144 : 20 * Math.log10(g));
export const lerp = (a, b, t) => a + (b - a) * t;

export function fmtMinSec(t) {
  if (!isFinite(t)) t = 0;
  const neg = t < 0; t = Math.abs(t);
  const m = Math.floor(t / 60), s = t - m * 60;
  return (neg ? '-' : '') + m + ':' + s.toFixed(3).padStart(6, '0');
}
export function fmtBars(t, tempo, ts) {
  const beat = 60 / tempo;
  const totalBeats = t / beat;
  const bar = Math.floor(totalBeats / ts[0]) + 1;
  const b = Math.floor(totalBeats % ts[0]) + 1;
  const ticks = Math.floor((totalBeats % 1) * 960);
  return `${bar}|${b}|${String(ticks).padStart(3, '0')}`;
}
export function fmtSamples(t, sr) { return String(Math.round(t * sr)); }
export function fmtTimecode(t, fps = 30) {
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60), f = Math.floor((t % 1) * fps);
  return [h, m, s, f].map(x => String(x).padStart(2, '0')).join(':');
}

export class Emitter {
  constructor() { this._h = {}; }
  on(e, f) { (this._h[e] ||= []).push(f); return () => this.off(e, f); }
  off(e, f) { this._h[e] = (this._h[e] || []).filter(x => x !== f); }
  emit(e, ...a) { (this._h[e] || []).slice().forEach(f => { try { f(...a); } catch (err) { console.error(err); } }); }
}

export const TRACK_COLORS = ['#4fc3f7', '#ff8a65', '#aed581', '#ba68c8', '#ffd54f', '#4db6ac', '#f06292', '#9575cd', '#81c784', '#e57373', '#64b5f6', '#ffb74d'];

export const sleep = (ms = 0) => new Promise(r => setTimeout(r, ms));

export const NOTE_NAMES = ['Do', 'Do#', 'Re', 'Re#', 'Mi', 'Fa', 'Fa#', 'Sol', 'Sol#', 'La', 'La#', 'Si'];
export const NOTE_NAMES_EN = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);
export const freqToMidi = (f) => 69 + 12 * Math.log2(f / 440);
export const noteName = (m) => NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);

export function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
