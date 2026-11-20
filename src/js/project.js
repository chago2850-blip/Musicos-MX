// Músicos MX — modelo de sesión, historial de deshacer y operaciones de edición
// Copyright (C) 2026 Santiago Miguel — GNU GPL v3 o posterior.
import { uid, Emitter, TRACK_COLORS, clamp } from './util.js';

export const TRACK_TYPES = {
  audio: 'Audio', instrument: 'Instrumento', midi: 'MIDI', aux: 'Auxiliar', video: 'Video'
};

export function newProject(name = 'Sesión sin título') {
  return {
    format: 'musicos-mx-session', version: 1,
    name, sampleRate: 48000, bitDepth: 24,
    tempo: 120, timeSig: [4, 4], key: 'C', scale: 'mayor',
    tracks: [],
    markers: [],
    master: { volume: 0, inserts: [], mute: false },
    loop: { enabled: false, start: 0, end: 8 },
    punch: { enabled: false, start: 0, end: 8 },
    selection: { start: 0, end: 0, tracks: [] },
    videoAssetId: null,
    created: new Date().toISOString(),
    notes: ''
  };
}

let colorIdx = 0;
export function newTrack(type = 'audio', name) {
  const t = {
    id: uid('trk'), type, name: name || TRACK_TYPES[type] + ' ' + (++colorIdx),
    color: TRACK_COLORS[colorIdx % TRACK_COLORS.length],
    volume: 0, pan: 0, mute: false, solo: false, recArm: false, monitor: false,
    height: 90, inserts: [], sends: [], output: 'master', input: 1,
    playlists: [{ id: uid('pl'), name: 'Toma 1', clips: [] }], activePlaylist: 0,
    automation: { volume: [], pan: [] }, automationMode: 'read', showAutomation: 'none',
    spatial: { enabled: false, x: 0, y: 0, z: -1 },
    pinned: false, frozen: false, hidden: false, inactive: false, stereo: true
  };
  if (type === 'instrument' || type === 'midi') t.instrument = { type: 'synth', preset: 'Piano eléctrico', params: {} };
  if (type === 'aux') { t.playlists = []; t.activePlaylist = -1; }
  return t;
}

export function clipsOf(track) {
  const pl = track.playlists[track.activePlaylist];
  return pl ? pl.clips : [];
}

export class Store extends Emitter {
  constructor() {
    super();
    this.project = newProject();
    this.assets = new Map(); // id -> {id,name,buffer,peaks,source}
    this.undoStack = []; this.redoStack = [];
    this.selectedClips = new Set();
    this.selectedTrack = null;
    this.dirty = false;
  }
  snapshot() { return JSON.stringify(this.project); }
  // Ejecuta una operación con soporte de deshacer
  edit(label, fn) {
    const before = this.snapshot();
    const r = fn(this.project);
    const after = this.snapshot();
    if (before !== after) {
      this.undoStack.push({ label, before });
      if (this.undoStack.length > 200) this.undoStack.shift();
      this.redoStack = [];
      this.dirty = true;
      this.emit('change', { label });
    }
    return r;
  }
  // Ediciones interactivas (arrastres): se toma la instantánea al inicio y se confirma al soltar
  begin() { this._pendingBefore = this.snapshot(); }
  commit(label) {
    const before = this._pendingBefore; this._pendingBefore = null;
    if (!before || before === this.snapshot()) { this.emit('live'); return; }
    this.undoStack.push({ label, before }); this.redoStack = []; this.dirty = true;
    this.emit('change', { label });
  }
  // Cambios rápidos (fader en vivo) sin crear paso de historial
  live(fn) { fn(this.project); this.emit('live'); }
  undo() {
    const s = this.undoStack.pop(); if (!s) return;
    this.redoStack.push({ label: s.label, before: this.snapshot() });
    this.project = JSON.parse(s.before);
    this.emit('change', { label: 'Deshacer ' + s.label, structural: true });
  }
  redo() {
    const s = this.redoStack.pop(); if (!s) return;
    this.undoStack.push({ label: s.label, before: this.snapshot() });
    this.project = JSON.parse(s.before);
    this.emit('change', { label: 'Rehacer ' + s.label, structural: true });
  }
  load(project, assets) {
    this.project = project; this.assets = assets || new Map();
    this.undoStack = []; this.redoStack = []; this.selectedClips.clear(); this.dirty = false;
    this.emit('change', { label: 'Abrir sesión', structural: true });
  }
  track(id) { return this.project.tracks.find(t => t.id === id); }
  findClip(id) {
    for (const t of this.project.tracks) for (const pl of t.playlists) {
      const c = pl.clips.find(c => c.id === id); if (c) return { track: t, clip: c, playlist: pl };
    }
    return null;
  }
  addAsset(name, buffer, extra = {}) {
    const id = uid('ast');
    const a = { id, name, buffer, ...extra };
    a.peaks = computePeaks(buffer);
    this.assets.set(id, a);
    this.emit('assets');
    return a;
  }
  sessionLength() {
    let end = 0;
    for (const t of this.project.tracks) for (const c of clipsOf(t)) end = Math.max(end, c.start + c.duration);
    return end;
  }
}

// Picos para dibujar forma de onda: 1 pico por cada 256 muestras (min/max por canal mezclado)
export function computePeaks(buffer, spp = 256) {
  const n = Math.ceil(buffer.length / spp);
  const mins = new Float32Array(n), maxs = new Float32Array(n);
  const chs = []; for (let c = 0; c < buffer.numberOfChannels; c++) chs.push(buffer.getChannelData(c));
  for (let i = 0; i < n; i++) {
    let mn = 1, mx = -1; const s = i * spp, e = Math.min(buffer.length, s + spp);
    for (const d of chs) for (let j = s; j < e; j++) { const v = d[j]; if (v < mn) mn = v; if (v > mx) mx = v; }
    mins[i] = mn; maxs[i] = mx;
  }
  return { spp, mins, maxs, sr: buffer.sampleRate };
}

export function newAudioClip(asset, start, extra = {}) {
  return {
    id: uid('clp'), kind: 'audio', assetId: asset.id, name: asset.name,
    start, offset: 0, duration: asset.buffer.duration, gain: 0,
    fadeIn: 0.005, fadeOut: 0.005, muted: false, rate: 1, locked: false, color: null, ...extra
  };
}
export function newMidiClip(start, duration, notes = [], name = 'MIDI') {
  return { id: uid('clp'), kind: 'midi', name, start, offset: 0, duration, notes, gain: 0, muted: false, fadeIn: 0, fadeOut: 0, locked: false };
}

// Dividir un clip en un punto de tiempo absoluto
export function splitClip(clips, clip, t) {
  if (t <= clip.start + 0.001 || t >= clip.start + clip.duration - 0.001) return null;
  const right = JSON.parse(JSON.stringify(clip));
  right.id = uid('clp');
  const d = t - clip.start;
  if (clip.kind === 'midi') {
    right.notes = clip.notes.filter(n => n.t >= d).map(n => ({ ...n, t: n.t - d }));
    clip.notes = clip.notes.filter(n => n.t < d).map(n => ({ ...n, d: Math.min(n.d, d - n.t) }));
  } else {
    right.offset = clip.offset + d * (clip.rate || 1);
  }
  right.start = t; right.duration = clip.duration - d; right.fadeIn = 0.005;
  clip.duration = d; clip.fadeOut = 0.005;
  clips.splice(clips.indexOf(clip) + 1, 0, right);
  return right;
}

// Eliminar un rango de tiempo de una lista de clips (modo Shuffle desplaza lo posterior)
export function clearRange(clips, a, b, shuffle = false) {
  for (const c of clips.slice()) {
    const ce = c.start + c.duration;
    if (ce <= a || c.start >= b) continue;
    if (c.start >= a && ce <= b) { clips.splice(clips.indexOf(c), 1); continue; }
    if (c.start < a && ce > b) { const r = splitClip(clips, c, b); splitClip(clips, c, a); const mid = clips[clips.indexOf(c) + 1]; if (mid && mid !== r) clips.splice(clips.indexOf(mid), 1); continue; }
    if (c.start < a) { c.duration = a - c.start; continue; }
    if (ce > b) { const d = b - c.start; c.offset += d * (c.rate || 1); c.start = b; c.duration -= d; if (c.kind === 'midi') c.notes = c.notes.filter(n => n.t >= d).map(n => ({ ...n, t: n.t - d })); }
  }
  if (shuffle) for (const c of clips) if (c.start >= b - 1e-6) c.start -= (b - a);
  clips.sort((x, y) => x.start - y.start);
}

export function snapTime(p, t, mode, gridDiv) {
  if (mode !== 'grid') return t;
  const beat = 60 / p.tempo;
  const g = beat * 4 / gridDiv; // gridDiv: 4 = negra, 8 = corchea, 16...
  return Math.round(t / g) * g;
}
export function gridSeconds(p, gridDiv) { return (60 / p.tempo) * 4 / gridDiv; }

export function automationValueAt(points, t, def) {
  if (!points || !points.length) return def;
  if (t <= points[0].t) return points[0].v;
  for (let i = 1; i < points.length; i++) {
    if (t <= points[i].t) {
      const a = points[i - 1], b = points[i];
      return a.v + (b.v - a.v) * ((t - a.t) / Math.max(1e-9, b.t - a.t));
    }
  }
  return points[points.length - 1].v;
}

export function normalizeProject(p) {
  // Garantiza campos al abrir sesiones de versiones anteriores
  const base = newProject();
  for (const k of Object.keys(base)) if (p[k] === undefined) p[k] = base[k];
  for (const t of p.tracks) {
    const nt = newTrack(t.type);
    for (const k of Object.keys(nt)) if (t[k] === undefined) t[k] = nt[k];
    t.volume = clamp(t.volume, -144, 12);
  }
  return p;
}
