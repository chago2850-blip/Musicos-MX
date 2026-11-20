// Músicos MX — motor de audio: grafo de mezcla, transporte, grabación, MIDI y render
// Copyright (C) 2026 Santiago Miguel — GNU GPL v3 o posterior.
import { dbToGain, Emitter, uid } from '../util.js';
import { clipsOf, newAudioClip, newMidiClip } from '../project.js';
import { createInsert } from './plugins.js';
import { ensureWorklets } from './worklets.js';
import { playInstrumentNote } from './instruments.js';

const LOOKAHEAD = 0.25, TICK_MS = 40;

// Construye el grafo de una sesión sobre cualquier BaseAudioContext (en vivo o fuera de línea)
export function buildGraph(ctx, project, opts = {}) {
  const g = { tracks: new Map(), ctx };
  const masterIn = ctx.createGain();
  let node = masterIn;
  g.masterInserts = [];
  for (const ins of project.master.inserts) {
    if (ins.bypass) continue;
    const n = createInsert(ctx, ins, { tempo: project.tempo }); if (!n) continue;
    node.connect(n.input); node = n.output; g.masterInserts.push({ ins, n });
  }
  const masterFader = ctx.createGain();
  masterFader.gain.value = project.master.mute ? 0 : dbToGain(project.master.volume);
  node.connect(masterFader);
  g.masterIn = masterIn; g.masterFader = masterFader;
  g.out = masterFader;
  if (!opts.offline) {
    const splitter = ctx.createChannelSplitter(2);
    g.masterAnL = ctx.createAnalyser(); g.masterAnR = ctx.createAnalyser();
    g.masterAnL.fftSize = 2048; g.masterAnR.fftSize = 2048;
    masterFader.connect(splitter); splitter.connect(g.masterAnL, 0); splitter.connect(g.masterAnR, 1);
    // Ponderación K para medidor de sonoridad LUFS (ITU-R BS.1770)
    const k1 = ctx.createBiquadFilter(); k1.type = 'highshelf'; k1.frequency.value = 1681; k1.gain.value = 4;
    const k2 = ctx.createBiquadFilter(); k2.type = 'highpass'; k2.frequency.value = 38; k2.Q.value = 0.5;
    g.lufsAn = ctx.createAnalyser(); g.lufsAn.fftSize = 16384; // ~0.34 s a 48k
    masterFader.connect(k1); k1.connect(k2); k2.connect(g.lufsAn);
    g.spectrum = ctx.createAnalyser(); g.spectrum.fftSize = 4096; g.spectrum.smoothingTimeConstant = 0.8;
    masterFader.connect(g.spectrum);
  }
  const anySolo = project.tracks.some(t => t.solo && t.type !== 'aux');
  // Primero los auxiliares (para que existan como destino)
  const ordered = [...project.tracks.filter(t => t.type === 'aux'), ...project.tracks.filter(t => t.type !== 'aux')];
  for (const t of ordered) {
    if (t.inactive || t.type === 'video') continue;
    if (opts.onlyTracks && !opts.onlyTracks.includes(t.id) && t.type !== 'aux') continue;
    const tr = { track: t };
    tr.input = ctx.createGain();
    let n = tr.input; tr.inserts = [];
    for (const ins of t.inserts) {
      if (ins.bypass) continue;
      const x = createInsert(ctx, ins, { tempo: project.tempo }); if (!x) continue;
      n.connect(x.input); n = x.output; tr.inserts.push({ ins, n: x });
    }
    if (t.spatial && t.spatial.enabled) {
      const pn = ctx.createPanner(); pn.panningModel = 'HRTF'; pn.distanceModel = 'inverse';
      pn.positionX.value = t.spatial.x; pn.positionY.value = t.spatial.y; pn.positionZ.value = t.spatial.z;
      tr.spatial = pn; n.connect(pn); n = pn;
    } else {
      tr.panner = ctx.createStereoPanner(); tr.panner.pan.value = t.pan; n.connect(tr.panner); n = tr.panner;
    }
    tr.fader = ctx.createGain(); tr.fader.gain.value = dbToGain(t.volume);
    tr.muteG = ctx.createGain();
    const muted = t.mute || (anySolo && !t.solo && t.type !== 'aux');
    tr.muteG.gain.value = muted ? 0 : 1;
    n.connect(tr.fader); tr.fader.connect(tr.muteG);
    const dest = t.output === 'master' ? masterIn : (g.tracks.get(t.output)?.input || masterIn);
    tr.muteG.connect(dest);
    tr.sends = [];
    for (const s of t.sends || []) {
      const aux = g.tracks.get(s.bus); if (!aux) continue;
      const sg = ctx.createGain(); sg.gain.value = s.mute ? 0 : dbToGain(s.level);
      (s.pre ? n : tr.muteG).connect(sg); sg.connect(aux.input); tr.sends.push({ s, g: sg });
    }
    if (!opts.offline) { tr.analyser = ctx.createAnalyser(); tr.analyser.fftSize = 1024; tr.muteG.connect(tr.analyser); }
    g.tracks.set(t.id, tr);
  }
  if (opts.onlyTracks) {
    // En stems, no se reproduce material de pistas ajenas pero los auxiliares siguen activos
  }
  return g;
}

function fadeValue(clip, rel) {
  let v = 1;
  if (clip.fadeIn > 0 && rel < clip.fadeIn) v *= rel / clip.fadeIn;
  const toEnd = clip.duration - rel;
  if (clip.fadeOut > 0 && toEnd < clip.fadeOut) v *= Math.max(0, toEnd / clip.fadeOut);
  return v;
}

// Programa un clip de audio a partir de tiempo de línea `from` en el instante de contexto `when`
function scheduleAudioClip(ctx, clip, asset, dest, from, when, until = Infinity) {
  if (!asset || !asset.buffer || clip.muted) return null;
  const cEnd = clip.start + clip.duration;
  if (cEnd <= from || clip.start >= until) return null;
  const rate = clip.rate || 1;
  const tlStart = Math.max(from, clip.start);
  const rel = tlStart - clip.start;
  const startAt = when + (tlStart - from);
  const playDur = Math.min(cEnd, until) - tlStart;
  const src = ctx.createBufferSource(); src.buffer = asset.buffer; src.playbackRate.value = rate;
  if (clip.reverse && asset.reversed) src.buffer = asset.reversed;
  const g = ctx.createGain();
  const base = dbToGain(clip.gain || 0);
  const gp = g.gain;
  gp.setValueAtTime(base * fadeValue(clip, rel), startAt);
  if (clip.fadeIn > 0 && rel < clip.fadeIn) gp.linearRampToValueAtTime(base, startAt + (clip.fadeIn - rel));
  if (clip.fadeOut > 0) {
    const fo = Math.max(rel, clip.duration - clip.fadeOut);
    gp.setValueAtTime(base * fadeValue(clip, fo), startAt + (fo - rel));
    gp.linearRampToValueAtTime(0, startAt + (clip.duration - rel));
  }
  src.connect(g); g.connect(dest);
  const off = clip.offset + rel * rate;
  if (off >= asset.buffer.duration) return null;
  src.start(startAt, off, playDur * rate);
  return src;
}

function scheduleAutomation(ctx, tr, project, from, when) {
  const t = tr.track;
  if (t.automationMode === 'off') return;
  const vol = t.automation?.volume || [];
  if (vol.length) {
    const p = tr.fader.gain; p.cancelScheduledValues(0);
    const vAt = valueAt(vol, from);
    p.setValueAtTime(dbToGain(vAt), when);
    for (const pt of vol) if (pt.t > from) p.linearRampToValueAtTime(dbToGain(pt.v), when + (pt.t - from));
  }
  const pan = t.automation?.pan || [];
  if (pan.length && tr.panner) {
    const p = tr.panner.pan; p.cancelScheduledValues(0);
    p.setValueAtTime(valueAt(pan, from), when);
    for (const pt of pan) if (pt.t > from) p.linearRampToValueAtTime(pt.v, when + (pt.t - from));
  }
}
function valueAt(points, t) {
  if (t <= points[0].t) return points[0].v;
  for (let i = 1; i < points.length; i++) if (t <= points[i].t) { const a = points[i - 1], b = points[i]; return a.v + (b.v - a.v) * (t - a.t) / Math.max(1e-9, b.t - a.t); }
  return points[points.length - 1].v;
}

export class Engine extends Emitter {
  constructor(store) {
    super();
    this.store = store;
    this.ctx = null; this.graph = null;
    this.playing = false; this.recording = false;
    this.position = 0; // posición de línea de tiempo cuando está detenido
    this.sources = []; this.midiVoices = [];
    this.metronome = false; this.countIn = 0; this.metroVol = 0.6;
    this.liveNotes = new Map();
    this.prerollTime = 0;
  }
  async init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC({ latencyHint: 'interactive', sampleRate: this.store.project.sampleRate });
    await ensureWorklets(this.ctx);
    this.rebuild();
    this.emit('ready');
  }
  get sampleRate() { return this.ctx ? this.ctx.sampleRate : this.store.project.sampleRate; }
  rebuild() {
    if (!this.ctx) return;
    const wasPlaying = this.playing; const pos = this.getPosition();
    if (wasPlaying) this._stopSources();
    if (this.graph) { try { this.graph.out.disconnect(); } catch (e) { } this._disposeGraph(this.graph); }
    this.graph = buildGraph(this.ctx, this.store.project);
    this.graph.out.connect(this.ctx.destination);
    this.emit('graph');
    if (wasPlaying) { this.playing = false; this.play(pos, true); }
  }
  _disposeGraph(g) {
    for (const tr of g.tracks.values()) { for (const i of tr.inserts) i.n.dispose?.(); try { tr.muteG.disconnect(); } catch (e) { } }
    for (const i of g.masterInserts) i.n.dispose?.();
  }
  // Actualiza parámetros sin reconstruir (volumen, paneo, mute, solo)
  updateMix() {
    if (!this.graph) return;
    const p = this.store.project, now = this.ctx.currentTime;
    const anySolo = p.tracks.some(t => t.solo && t.type !== 'aux');
    for (const tr of this.graph.tracks.values()) {
      const t = p.tracks.find(x => x.id === tr.track.id); if (!t) continue;
      tr.track = t;
      const automated = this.playing && t.automationMode !== 'off' && t.automationMode !== 'write' && t.automation.volume.length;
      if (!automated) tr.fader.gain.setTargetAtTime(dbToGain(t.volume), now, 0.01);
      if (tr.panner && !(this.playing && t.automationMode !== 'off' && t.automation.pan.length)) tr.panner.pan.setTargetAtTime(t.pan, now, 0.01);
      if (tr.spatial) { tr.spatial.positionX.value = t.spatial.x; tr.spatial.positionY.value = t.spatial.y; tr.spatial.positionZ.value = t.spatial.z; }
      const muted = t.mute || (anySolo && !t.solo && t.type !== 'aux');
      tr.muteG.gain.setTargetAtTime(muted ? 0 : 1, now, 0.005);
      for (const s of tr.sends) { const ns = (t.sends || []).find(x => x.bus === s.s.bus); if (ns) s.g.gain.setTargetAtTime(ns.mute ? 0 : dbToGain(ns.level), now, 0.01); }
      for (const i of tr.inserts) { const ni = t.inserts.find(x => x.id === i.ins.id); if (ni) for (const k in ni.params) i.n.set(k, ni.params[k]); }
    }
    for (const i of this.graph.masterInserts) { const ni = p.master.inserts.find(x => x.id === i.ins.id); if (ni) for (const k in ni.params) i.n.set(k, ni.params[k]); }
    this.graph.masterFader.gain.setTargetAtTime(p.master.mute ? 0 : dbToGain(p.master.volume), now, 0.01);
  }
  setInsertParam(trackId, insId, key, value) {
    if (!this.graph) return;
    const list = trackId === 'master' ? this.graph.masterInserts : this.graph.tracks.get(trackId)?.inserts;
    const i = list?.find(x => x.ins.id === insId); if (i) i.n.set(key, value);
  }
  getInsertNode(trackId, insId) {
    const list = trackId === 'master' ? this.graph?.masterInserts : this.graph?.tracks.get(trackId)?.inserts;
    return list?.find(x => x.ins.id === insId)?.n;
  }

  getPosition() {
    if (!this.playing) return this.position;
    const now = this.ctx.currentTime;
    if (this._pending && now >= this._pending.ctx) { this.map = this._pending; this._pending = null; this.emit('loop'); }
    return this.map.tl + (now - this.map.ctx);
  }
  setPosition(t) {
    t = Math.max(0, t);
    if (this.playing) { this.play(t, true); } else { this.position = t; this.emit('position', t); }
  }

  async play(from = this.position, restart = false) {
    await this.init();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    if (this.playing && !restart) return;
    if (this.playing) this._stopSources();
    const p = this.store.project;
    if (p.loop.enabled && !this.recording && (from >= p.loop.end || from < p.loop.start - 0.0001) && restart === false) from = p.loop.start;
    const when = this.ctx.currentTime + 0.06 + (this.prerollTime || 0);
    this.map = { tl: from, ctx: when }; this._pending = null;
    this.playing = true; this.position = from;
    this._scheduleSegment(from, when, p.loop.enabled && !this.recording ? p.loop.end : Infinity);
    for (const tr of this.graph.tracks.values()) scheduleAutomation(this.ctx, tr, p, from, when);
    this._schedTl = from; this._schedLimit = (p.loop.enabled && !this.recording) ? p.loop.end : Infinity;
    clearInterval(this._timer);
    this._timer = setInterval(() => this._tick(), TICK_MS);
    this._tick();
    this.emit('play');
  }
  _scheduleSegment(from, when, until) {
    const p = this.store.project;
    for (const t of p.tracks) {
      const tr = this.graph.tracks.get(t.id); if (!tr) continue;
      for (const c of clipsOf(t)) {
        if (c.kind !== 'audio') continue;
        const src = scheduleAudioClip(this.ctx, c, this.store.assets.get(c.assetId), tr.input, from, when, until);
        if (src) this.sources.push(src);
      }
    }
  }
  _tick() {
    if (!this.playing) return;
    const p = this.store.project, now = this.ctx.currentTime;
    // tiempo de línea hasta el cual programar
    const curMap = this._pending || this.map;
    const horizonCtx = now + LOOKAHEAD;
    let tlFrom = this._schedTl, tlTo = curMap.tl + (horizonCtx - curMap.ctx);
    const loopOn = p.loop.enabled && !this.recording;
    if (loopOn && tlTo >= p.loop.end && !this._pending) {
      // programar vuelta sin cortes
      const wrapCtx = curMap.ctx + (p.loop.end - curMap.tl);
      this._scheduleMidi(tlFrom, p.loop.end, curMap);
      this._scheduleClick(tlFrom, p.loop.end, curMap);
      for (const s of this.sources) { try { s.stop(wrapCtx); } catch (e) { } }
      this.sources = [];
      this._pending = { tl: p.loop.start, ctx: wrapCtx };
      this._scheduleSegment(p.loop.start, wrapCtx, p.loop.end);
      for (const tr of this.graph.tracks.values()) scheduleAutomation(this.ctx, tr, p, p.loop.start, wrapCtx);
      this._schedTl = p.loop.start;
      return;
    }
    this._scheduleMidi(tlFrom, tlTo, curMap);
    this._scheduleClick(tlFrom, tlTo, curMap);
    this._schedTl = tlTo;
    const pos = this.getPosition();
    const end = this.store.sessionLength();
    if (!loopOn && !this.recording && pos > end + 2 && end > 0 && !this.freeRun) this.stop();
    if (this.recording && p.punch.enabled && pos >= p.punch.end + 0.5 && !this._punchStopped) { this._punchStopped = true; this.stop(); }
  }
  _scheduleMidi(a, b, map) {
    if (b <= a) return;
    const p = this.store.project;
    for (const t of p.tracks) {
      if (t.type !== 'instrument' && t.type !== 'midi') continue;
      const tr = this.graph.tracks.get(t.id); if (!tr) continue;
      for (const c of clipsOf(t)) {
        if (c.kind !== 'midi' || c.muted) continue;
        if (c.start + c.duration <= a || c.start >= b) continue;
        for (const n of c.notes) {
          const nt = c.start + n.t;
          if (nt >= a && nt < b && n.t < c.duration) {
            const when = map.ctx + (nt - map.tl);
            if (when < this.ctx.currentTime - 0.01) continue;
            const dur = Math.min(n.d, c.duration - n.t);
            const v = playInstrumentNote(this.ctx, tr.input, t.instrument, n.p, Math.max(this.ctx.currentTime, when), dur, n.v);
            this.midiVoices.push(...v);
          }
        }
      }
    }
    if (this.midiVoices.length > 2000) this.midiVoices.splice(0, 1000);
  }
  _scheduleClick(a, b, map) {
    if (!this.metronome && !(this.recording && this.countInActive)) return;
    if (b <= a) return;
    const p = this.store.project, beat = 60 / p.tempo;
    let k = Math.ceil(a / beat - 1e-9);
    for (; k * beat < b; k++) {
      const when = map.ctx + (k * beat - map.tl);
      if (when < this.ctx.currentTime) continue;
      this._click(when, k % p.timeSig[0] === 0);
    }
  }
  _click(when, accent) {
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.frequency.value = accent ? 1760 : 1100; o.type = 'square';
    g.gain.setValueAtTime(this.metroVol * 0.3, when); g.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
    o.connect(g); g.connect(this.ctx.destination); o.start(when); o.stop(when + 0.06);
  }
  _stopSources() {
    const now = this.ctx.currentTime;
    for (const s of this.sources) { try { s.stop(now); } catch (e) { } }
    for (const v of this.midiVoices) { try { v.stop(now + 0.02); } catch (e) { } }
    this.sources = []; this.midiVoices = [];
    if (this.graph) for (const tr of this.graph.tracks.values()) {
      tr.fader.gain.cancelScheduledValues(0); tr.fader.gain.setValueAtTime(dbToGain(tr.track.volume), now);
      if (tr.panner) { tr.panner.pan.cancelScheduledValues(0); tr.panner.pan.setValueAtTime(tr.track.pan, now); }
    }
  }
  stop() {
    if (!this.playing) { this.position = this.store.project.loop.enabled ? this.position : this.position; this.emit('stop'); return; }
    const pos = this.getPosition();
    clearInterval(this._timer);
    this._stopSources();
    this.playing = false;
    if (this.recording) this._finishRecording();
    this.position = this.returnToStart ? this.map.tl : pos;
    if (this.returnToStart && this._playStart !== undefined) this.position = this._playStart;
    this.emit('stop');
    this.emit('position', this.position);
  }
  togglePlay() { if (this.playing) this.stop(); else { this._playStart = this.position; this.play(this.position); } }

  // ---------- Escritura de automatización ----------
  writeAutomation(trackId, param, value) {
    if (!this.playing) return;
    const t = this.store.track(trackId); if (!t) return;
    if (!['write', 'touch', 'latch'].includes(t.automationMode)) return;
    const pos = this.getPosition();
    const pts = t.automation[param];
    // eliminar puntos en la ventana reciente y añadir
    const last = this._autoLast?.[trackId + param];
    for (let i = pts.length - 1; i >= 0; i--) if (pts[i].t > (last ?? pos) && pts[i].t <= pos + 0.01) pts.splice(i, 1);
    pts.push({ t: pos, v: value }); pts.sort((a, b) => a.t - b.t);
    (this._autoLast ||= {})[trackId + param] = pos;
  }

  // ---------- Notas en vivo (teclado virtual / MIDI) ----------
  noteOn(trackId, note, vel = 100) {
    if (!this.ctx) return;
    const tr = this.graph.tracks.get(trackId); const t = this.store.track(trackId); if (!tr || !t) return;
    const v = playInstrumentNote(this.ctx, tr.input, t.instrument, note, this.ctx.currentTime, 30, vel);
    this.liveNotes.set(trackId + ':' + note, v);
    if (this.recording && t.recArm) (this._midiRec ||= []).push({ trackId, p: note, v: vel, t: this.getPosition(), on: true });
  }
  noteOff(trackId, note) {
    const k = trackId + ':' + note; const v = this.liveNotes.get(k);
    if (v) { if (v.release) v.release(this.ctx.currentTime); this.liveNotes.delete(k); }
    if (this.recording && this._midiRec) {
      const on = [...this._midiRec].reverse().find(e => e.trackId === trackId && e.p === note && e.on && e.d === undefined);
      if (on) on.d = this.getPosition() - on.t;
    }
  }

  // ---------- Grabación ----------
  async armInput() {
    if (this.inputStream) return this.inputStream;
    const devId = this.inputDeviceId;
    this.inputStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2, ...(devId ? { deviceId: { exact: devId } } : {}) } });
    this.inputNode = this.ctx.createMediaStreamSource(this.inputStream);
    this.inputAnalyser = this.ctx.createAnalyser(); this.inputAnalyser.fftSize = 1024;
    this.inputNode.connect(this.inputAnalyser);
    return this.inputStream;
  }
  setMonitoring() {
    if (!this.inputNode || !this.graph) return;
    try { this.inputNode.disconnect(); } catch (e) { } this.inputNode.connect(this.inputAnalyser);
    for (const t of this.store.project.tracks) {
      if (t.type === 'audio' && (t.monitor || (t.recArm && this.autoMonitor))) {
        const tr = this.graph.tracks.get(t.id); if (tr) this.inputNode.connect(tr.input);
      }
    }
  }
  async record() {
    await this.init();
    const p = this.store.project;
    const armed = p.tracks.filter(t => t.recArm);
    if (!armed.length) { this.emit('message', 'Arma al menos una pista para grabar (botón ●).'); return; }
    const audioArmed = armed.filter(t => t.type === 'audio');
    if (audioArmed.length) {
      try { await this.armInput(); } catch (e) { this.emit('message', 'No se pudo acceder al micrófono/interfaz: ' + e.message); return; }
      this.recNode = new AudioWorkletNode(this.ctx, 'mmx-recorder', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit' });
      this.inputNode.connect(this.recNode);
      this.recChunks = { L: [], R: [] };
      this.recNode.port.onmessage = (e) => { if (e.data.L) { this.recChunks.L.push(e.data.L); this.recChunks.R.push(e.data.R); } };
    }
    this._midiRec = [];
    this.recording = true; this._punchStopped = false;
    const start = p.punch.enabled ? Math.max(0, p.punch.start - 2) : this.position;
    const beat = 60 / p.tempo;
    const pre = this.countIn > 0 ? this.countIn * p.timeSig[0] * beat : 0;
    this.countInActive = pre > 0;
    this.prerollTime = 0;
    const playFrom = Math.max(0, start - pre);
    this.recLoop = p.loop.enabled ? { start: p.loop.start, end: p.loop.end } : null;
    this.freeRun = true;
    await this.play(this.recLoop ? Math.max(0, this.recLoop.start - pre) : playFrom, true);
    this.recStartTl = this.map.tl; this.recStartCtx = this.map.ctx;
    if (this.recNode) {
      // iniciar captura alineada con el inicio de reproducción
      const delayMs = Math.max(0, (this.map.ctx - this.ctx.currentTime) * 1000);
      setTimeout(() => this.recNode && this.recNode.port.postMessage('start'), delayMs);
    }
    this.emit('record', true);
  }
  _finishRecording() {
    this.recording = false; this.freeRun = false; this.countInActive = false;
    const p = this.store.project;
    const armed = p.tracks.filter(t => t.recArm);
    const finish = () => {
      const sr = this.ctx.sampleRate;
      const results = [];
      if (this.recChunks && this.recChunks.L.length) {
        const len = this.recChunks.L.reduce((a, c) => a + c.length, 0);
        const L = new Float32Array(len), R = new Float32Array(len);
        let o = 0; for (let i = 0; i < this.recChunks.L.length; i++) { L.set(this.recChunks.L[i], o); R.set(this.recChunks.R[i], o); o += this.recChunks.L[i].length; }
        // compensación de latencia
        const lat = Math.round(((this.ctx.baseLatency || 0) + (this.ctx.outputLatency || 0)) * sr) + (this.latencyComp || 0);
        const Ls = L.subarray(Math.min(lat, len)), Rs = R.subarray(Math.min(lat, len));
        for (const t of armed.filter(x => x.type === 'audio')) {
          const stereo = t.input === 0;
          const buf = this.ctx.createBuffer(stereo ? 2 : 1, Math.max(1, Ls.length), sr);
          if (stereo) { buf.copyToChannel(Ls, 0); buf.copyToChannel(Rs, 1); } else buf.copyToChannel(t.input === 2 ? Rs : Ls, 0);
          results.push({ t, buf });
        }
      }
      this.store.edit('Grabar', (proj) => {
        for (const { t, buf } of results) {
          const tt = proj.tracks.find(x => x.id === t.id);
          const n = (tt.playlists.length);
          const asset = this.store.addAsset(`${tt.name}_${String(n).padStart(2, '0')}`, buf, { recorded: true });
          const startTl = this.recStartTl;
          if (this.recLoop) {
            // grabación en bucle: cada pasada es una toma (lista de reproducción)
            const L = this.recLoop.end - this.recLoop.start;
            const firstPass = this.recLoop.start - startTl;
            let k = 0;
            for (let off = firstPass; off + 0.05 < buf.duration; off += L, k++) {
              if (off + L > buf.duration + 0.25 && k > 0) break;
              const clip = newAudioClip(asset, this.recLoop.start, { offset: Math.max(0, off), duration: Math.min(L, buf.duration - Math.max(0, off)), name: asset.name + ' T' + (k + 1) });
              const pl = { id: uid('pl'), name: 'Toma ' + (tt.playlists.length + 1), clips: tt.playlists[tt.activePlaylist].clips.filter(c => c.start + c.duration <= this.recLoop.start || c.start >= this.recLoop.end).map(c => ({ ...c, id: uid('clp') })).concat([clip]) };
              tt.playlists.push(pl); tt.activePlaylist = tt.playlists.length - 1;
            }
          } else {
            let a = startTl, b = startTl + buf.duration, off = 0;
            if (proj.punch.enabled) { off = Math.max(0, proj.punch.start - startTl); a = proj.punch.start; b = Math.min(b, proj.punch.end); }
            if (b - a < 0.02) continue;
            const clips = tt.playlists[tt.activePlaylist].clips;
            // borrar lo que había debajo (grabación destructiva sobre la lista de reproducción activa no; se crea capa nueva)
            for (const c of clips.slice()) if (c.start < b && c.start + c.duration > a) {
              if (c.start >= a && c.start + c.duration <= b) clips.splice(clips.indexOf(c), 1);
              else if (c.start < a && c.start + c.duration > a) { c.duration = a - c.start; }
              else if (c.start < b) { const d = b - c.start; c.offset += d * (c.rate || 1); c.start = b; c.duration -= d; }
            }
            clips.push(newAudioClip(asset, a, { offset: off, duration: b - a }));
            clips.sort((x, y) => x.start - y.start);
          }
        }
        // MIDI
        const evs = (this._midiRec || []).filter(e => e.d !== undefined && e.t >= this.recStartTl - 0.01);
        const byTrack = {};
        for (const e of evs) (byTrack[e.trackId] ||= []).push(e);
        for (const id in byTrack) {
          const tt = proj.tracks.find(x => x.id === id); const evs2 = byTrack[id];
          const s = Math.min(...evs2.map(e => e.t)); const e = Math.max(...evs2.map(e => e.t + e.d));
          const st = Math.floor(s / (60 / proj.tempo * proj.timeSig[0])) * (60 / proj.tempo * proj.timeSig[0]);
          tt.playlists[tt.activePlaylist].clips.push(newMidiClip(st, e - st + 0.1, evs2.map(x => ({ p: x.p, v: x.v, t: x.t - st, d: Math.max(0.03, x.d) })), tt.name + ' MIDI'));
        }
      });
      this.recChunks = null; this._midiRec = [];
      this.emit('record', false);
    };
    if (this.recNode) {
      const node = this.recNode; this.recNode = null;
      node.port.onmessage = (e) => { if (e.data.L) { this.recChunks.L.push(e.data.L); this.recChunks.R.push(e.data.R); } if (e.data.done) { try { this.inputNode.disconnect(node); } catch (er) { } finish(); } };
      node.port.postMessage('stop');
    } else finish();
  }

  // ---------- Previsualización de audio (navegador/IA) ----------
  async preview(buffer) {
    await this.init(); this.stopPreview();
    const s = this.ctx.createBufferSource(); s.buffer = buffer; s.connect(this.ctx.destination); s.start(); this._prev = s;
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }
  stopPreview() { if (this._prev) { try { this._prev.stop(); } catch (e) { } this._prev = null; } }

  // ---------- Medidores ----------
  peak(an) {
    if (!an) return 0;
    const d = an._buf || (an._buf = new Float32Array(an.fftSize)); an.getFloatTimeDomainData(d);
    let m = 0; for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); if (v > m) m = v; } return m;
  }
  rms(an) {
    const d = an._buf || (an._buf = new Float32Array(an.fftSize)); an.getFloatTimeDomainData(d);
    let s = 0; for (let i = 0; i < d.length; i++) s += d[i] * d[i]; return Math.sqrt(s / d.length);
  }
  momentaryLUFS() {
    if (!this.graph?.lufsAn) return -70;
    const r = this.rms(this.graph.lufsAn);
    return r > 0 ? -0.691 + 10 * Math.log10(r * r * 2) : -70;
  }
}

// ---------- Render fuera de línea (bounce / stems / commit) ----------
export async function renderOffline(store, opts = {}) {
  const p = store.project;
  const sr = opts.sampleRate || p.sampleRate;
  const start = opts.start ?? 0;
  const end = opts.end ?? (store.sessionLength() + (opts.tail ?? 2));
  const len = Math.max(1, Math.ceil((end - start) * sr));
  const ctx = new OfflineAudioContext(2, len, sr);
  await ensureWorklets(ctx);
  const projCopy = JSON.parse(JSON.stringify(p));
  if (opts.noMaster) projCopy.master.inserts = [];
  if (opts.ignoreMute) for (const t of projCopy.tracks) t.mute = false;
  if (opts.onlyTracks) for (const t of projCopy.tracks) { t.solo = false; }
  const g = buildGraph(ctx, projCopy, { offline: true, onlyTracks: opts.onlyTracks });
  g.out.connect(ctx.destination);
  for (const t of projCopy.tracks) {
    const tr = g.tracks.get(t.id); if (!tr) continue;
    if (opts.onlyTracks && !opts.onlyTracks.includes(t.id)) continue;
    scheduleAutomation(ctx, tr, projCopy, start, 0);
    for (const c of clipsOf(t)) {
      if (c.kind === 'audio') scheduleAudioClip(ctx, c, store.assets.get(c.assetId), tr.input, start, 0, end);
      else if (c.kind === 'midi' && !c.muted) for (const n of c.notes) {
        const nt = c.start + n.t; if (nt < start || nt >= end || n.t >= c.duration) continue;
        playInstrumentNote(ctx, tr.input, t.instrument, n.p, nt - start, Math.min(n.d, c.duration - n.t), n.v);
      }
    }
  }
  const buf = await ctx.startRendering();
  return buf;
}
