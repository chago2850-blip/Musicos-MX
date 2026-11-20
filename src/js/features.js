// Músicos MX — AudioSuite, bounce/exportación, funciones de IA y asistente
// Copyright (C) 2026 Santiago Miguel — GNU GPL v3 o posterior.
import JSZip from 'jszip';
import { clipsOf, newAudioClip, newMidiClip, newTrack, splitClip, clearRange } from './project.js';
import { renderOffline } from './engine/engine.js';
import { PLUGINS, defaultParams } from './engine/plugins.js';
import { encodeWav, encodeMp3, decodeFile } from './io.js';
import { $, h, modal, toast, floatWindow, formBox, progressBox, confirmBox } from './ui/dialogs.js';
import { timeStretch, pitchShift, spectralDenoise, mono, integratedLUFS, truePeakDb, detectOnsets, yieldUI } from './ai/dsp.js';
import { separateStems, transcribe, analyze, analyzeMusic, autoMixPlan, masterPlan, MASTER_TARGETS, audioToMidi, autoTune, scoreTakes, GENRES, generateDrums, generateChords, generateBass, generateMelody, findSilence, KEYS, SCALES } from './ai/ai.js';
import { parseCommand, askLocalLLM, COMMAND_HELP } from './ai/assistant.js';
import { fmtMinSec, fmtBars, uid, clamp, dbToGain, escapeHtml } from './util.js';

export function installFeatures(App) {
  const P = App.constructor.prototype === Object.prototype ? App : Object.getPrototypeOf(App);
  Object.assign(P, features);
}

const features = {
  // ===== utilidades de render =====
  clipBuffer(clip) {
    const a = this.store.assets.get(clip.assetId); if (!a?.buffer) return null;
    const sr = a.buffer.sampleRate, s = Math.floor(clip.offset * sr), n = Math.max(1, Math.min(a.buffer.length - s, Math.round(clip.duration * (clip.rate || 1) * sr)));
    const b = this.engine.ctx.createBuffer(a.buffer.numberOfChannels, n, sr);
    for (let c = 0; c < b.numberOfChannels; c++) b.copyToChannel(a.buffer.getChannelData(c).subarray(s, s + n), c);
    return b;
  },
  async renderTrackBuffer(track, opts = {}) {
    const end = Math.min(this.store.sessionLength(), opts.maxLen ?? 1e9);
    if (end <= 0) return null;
    return await renderOffline(this.store, { onlyTracks: [track.id], noMaster: true, end, tail: 0.5, ignoreMute: true, ...opts });
  },
  makeBuffer(chans, sr) { const b = this.engine.ctx.createBuffer(chans.length, chans[0].length, sr); chans.forEach((c, i) => b.copyToChannel(c, i)); return b; },
  // Sustituye el audio de un clip por un nuevo buffer procesado (AudioSuite)
  replaceClipAudio(clipId, buf, suffix) {
    const f = this.store.findClip(clipId); if (!f) return;
    const base = (f.clip.name || 'clip').replace(/ \[[^\]]*\]$/, '');
    const prev = ((f.clip.name || '').match(/ \[([^\]]*)\]$/) || [])[1];
    const a = this.store.addAsset(base + ' [' + (prev ? prev + '+' : '') + suffix + ']', buf);
    const c = this.store.findClip(clipId).clip;
    c.assetId = a.id; c.offset = 0; c.duration = buf.duration / (c.rate || 1); c.name = a.name; c.reverse = false;
  },
  async audioSuite(op) {
    await this.engine.init();
    // dividir en los límites de la selección para procesar solo el rango
    const sel = this.edit.selectedRange();
    if (sel && !this.store.selectedClips.size) this.edit.splitAtCursor();
    const tg = this.targets().filter(x => x.clip.kind === 'audio');
    if (!tg.length) return toast('Selecciona un clip de audio (o un rango) para procesar.');
    let opts = {};
    const p = this.store.project;
    if (op === 'normalize') { const r = await formBox('Normalizar', [{ key: 'peak', label: 'Pico objetivo (dBFS)', type: 'number', value: -1, step: 0.1 }, { key: 'mode', label: 'Modo', type: 'select', options: [['peak', 'Pico'], ['lufs', 'Sonoridad (LUFS)']], value: 'peak' }, { key: 'lufs', label: 'LUFS objetivo', type: 'number', value: -16 }]); if (!r) return; opts = r; }
    if (op === 'gain') { const r = await formBox('Ganancia', [{ key: 'db', label: 'Ganancia (dB)', type: 'number', value: 3, step: 0.1 }]); if (!r) return; opts = r; }
    if (op === 'stretch') { const r = await formBox('Compresión/Expansión de tiempo', [{ key: 'factor', label: 'Factor de duración (1 = igual)', type: 'number', value: 1, step: 0.001 }, { key: 'fromBpm', label: 'o BPM original del audio', type: 'number', value: '' }, { key: 'toBpm', label: 'BPM destino', type: 'number', value: p.tempo }], 'Procesar', 'Conserva el tono (algoritmo WSOLA). Para ajustar un loop al tempo de la sesión indica su BPM original.'); if (!r) return; opts = r; }
    if (op === 'pitch') { const r = await formBox('Cambio de tono', [{ key: 'semi', label: 'Semitonos', type: 'number', value: 0, step: 0.1, min: -24, max: 24 }, { key: 'cents', label: 'Cents', type: 'number', value: 0 }], 'Procesar', 'Conserva la duración.'); if (!r) return; opts = r; }
    if (op === 'denoise') { const r = await formBox('Reducción de ruido (IA espectral)', [{ key: 'reduction', label: 'Reducción (dB)', type: 'number', value: 18 }, { key: 'sensitivity', label: 'Sensibilidad (1–4)', type: 'number', value: 1.6, step: 0.1 }], 'Limpiar', 'Aprende automáticamente el perfil de ruido de las partes más silenciosas del clip (aire acondicionado, zumbido, hiss) y lo atenúa.'); if (!r) return; opts = r; }
    if (op === 'autotune') { const r = await formBox('Afinación automática (IA)', [{ key: 'key', label: 'Tónica', type: 'select', options: KEYS, value: p.key }, { key: 'scale', label: 'Escala', type: 'select', options: Object.keys(SCALES), value: p.scale }, { key: 'strength', label: 'Intensidad (0–1)', type: 'number', value: 0.85, step: 0.05 }, { key: 'speed', label: 'Velocidad (0 = robótica, 0.9 = natural)', type: 'number', value: 0.5, step: 0.05 }], 'Afinar', 'Detecta el tono de la voz/instrumento monofónico y lo corrige hacia la escala elegida.'); if (!r) return; opts = r; }
    if (op === 'render') { const t = tg[0].track; if (!t.inserts.length) return toast('La pista no tiene inserciones para renderizar.'); }
    const pr = progressBox('AudioSuite', 'Procesando…');
    try {
      const results = [];
      let i = 0;
      for (const { clip, track } of tg) {
        const buf = this.clipBuffer(clip); if (!buf) continue;
        const sr = buf.sampleRate, prog = (x) => pr.set((i + x) / tg.length);
        const chans = []; for (let c = 0; c < buf.numberOfChannels; c++) chans.push(new Float32Array(buf.getChannelData(c)));
        let out = chans;
        switch (op) {
          case 'normalize': {
            let g;
            if (opts.mode === 'lufs') g = dbToGain(opts.lufs - integratedLUFS(buf));
            else { let m = 0; for (const ch of chans) for (const v of ch) m = Math.max(m, Math.abs(v)); g = m > 0 ? dbToGain(opts.peak) / m : 1; }
            out = chans.map(ch => ch.map(v => v * g)); break;
          }
          case 'gain': { const g = dbToGain(opts.db); out = chans.map(ch => ch.map(v => v * g)); break; }
          case 'reverse': out = chans.map(ch => ch.slice().reverse()); break;
          case 'invert': out = chans.map(ch => ch.map(v => -v)); break;
          case 'silence': out = chans.map(ch => new Float32Array(ch.length)); break;
          case 'dc': out = chans.map(ch => { const m = ch.reduce((a, b) => a + b, 0) / ch.length; let y = 0, x1 = 0; return ch.map(v => { const x = v - m; y = x - x1 + 0.9995 * y; x1 = x; return y; }); }); break;
          case 'stretch': { const f = opts.fromBpm > 0 ? opts.fromBpm / (opts.toBpm || p.tempo) : opts.factor; if (!(f > 0.1 && f < 10)) throw new Error('Factor inválido'); out = []; for (let c = 0; c < chans.length; c++) out.push(await timeStretch(chans[c], f, sr, x => prog((c + x) / chans.length))); break; }
          case 'pitch': { const st = (opts.semi || 0) + (opts.cents || 0) / 100; out = []; for (let c = 0; c < chans.length; c++) out.push(await pitchShift(chans[c], st, sr, x => prog((c + x) / chans.length))); break; }
          case 'denoise': out = []; for (let c = 0; c < chans.length; c++) out.push(await spectralDenoise(chans[c], sr, opts, x => prog((c + x) / chans.length))); break;
          case 'autotune': out = await autoTune(buf, opts, prog); break;
          case 'render': {
            const ctx = new OfflineAudioContext(buf.numberOfChannels, buf.length + Math.round(sr * 0.5), sr);
            const { ensureWorklets } = await import('./engine/worklets.js'); await ensureWorklets(ctx);
            const { createInsert } = await import('./engine/plugins.js');
            const src = ctx.createBufferSource(); src.buffer = buf; let node = src;
            for (const ins of track.inserts) { if (ins.bypass) continue; const n = createInsert(ctx, ins, { tempo: p.tempo }); if (n) { node.connect(n.input); node = n.output; } }
            node.connect(ctx.destination); src.start();
            const r = await ctx.startRendering(); out = []; for (let c = 0; c < r.numberOfChannels; c++) out.push(r.getChannelData(c).slice(0, buf.length));
            break;
          }
        }
        results.push({ id: clip.id, buf: this.makeBuffer(out, sr) }); i++;
        await yieldUI();
      }
      const label = { normalize: 'normalizado', gain: 'ganancia', reverse: 'invertido', invert: 'polaridad', silence: 'silencio', dc: 'sinDC', stretch: 'estirado', pitch: 'tono', denoise: 'limpio', autotune: 'afinado', render: 'render' }[op];
      this.store.edit('AudioSuite: ' + label, () => { for (const r of results) this.replaceClipAudio(r.id, r.buf, label); });
      if (op === 'render') toast('Inserciones renderizadas en el clip. Considera omitirlas (bypass) para no aplicarlas dos veces.');
    } catch (e) { console.error(e); toast('Error en AudioSuite: ' + e.message, true); }
    pr.close();
  },
  async stripSilence() {
    await this.engine.init();
    const tg = this.targets().filter(x => x.clip.kind === 'audio'); if (!tg.length) return toast('Selecciona un clip de audio.');
    const r = await formBox('Quitar silencios (Strip Silence)', [{ key: 'thr', label: 'Umbral (dBFS)', type: 'number', value: -45 }, { key: 'min', label: 'Duración mínima del silencio (s)', type: 'number', value: 0.25, step: 0.05 }, { key: 'pre', label: 'Margen inicial (s)', type: 'number', value: 0.01, step: 0.005 }, { key: 'post', label: 'Margen final (s)', type: 'number', value: 0.08, step: 0.01 }], 'Quitar', 'Divide el clip en las partes con sonido y elimina los silencios entre ellas (ideal para voces, tambores y diálogos).');
    if (!r) return;
    this.store.edit('Quitar silencios', () => {
      for (const { clip } of tg) {
        const f = this.store.findClip(clip.id); const buf = this.clipBuffer(f.clip); if (!buf) continue;
        const regions = findSilence(buf, r.thr, r.min, r.pre, r.post);
        const rate = f.clip.rate || 1;
        const pieces = regions.map(([a, b]) => ({ ...JSON.parse(JSON.stringify(f.clip)), id: uid('clp'), start: f.clip.start + a / rate, offset: f.clip.offset + a, duration: (b - a) / rate, fadeIn: 0.005, fadeOut: 0.02 }));
        f.playlist.clips.splice(f.playlist.clips.indexOf(f.clip), 1, ...pieces);
      }
    });
    toast('Silencios eliminados.');
  },
  async consolidate() {
    await this.engine.init();
    const sel = this.edit.selectedRange(); const tid = sel ? sel.tracks[0] : this.store.selectedTrack;
    const t = this.store.track(tid); if (!t || t.type !== 'audio') return toast('Selecciona un rango en una pista de audio.');
    const a = sel ? sel.start : Math.min(...clipsOf(t).map(c => c.start)), b = sel ? sel.end : Math.max(...clipsOf(t).map(c => c.start + c.duration));
    if (!(b > a)) return;
    const pr = progressBox('Consolidando…');
    const copy = JSON.parse(JSON.stringify(this.store.project));
    copy.tracks.forEach(x => { if (x.id === tid) { x.inserts = []; x.volume = 0; x.pan = 0; x.sends = []; x.automation = { volume: [], pan: [] }; } });
    const saved = this.store.project; this.store.project = copy;
    let buf; try { buf = await renderOffline(this.store, { onlyTracks: [tid], noMaster: true, start: a, end: b, tail: 0 }); } finally { this.store.project = saved; }
    pr.close();
    this.store.edit('Consolidar', p => { const tt = p.tracks.find(x => x.id === tid); clearRange(clipsOf(tt), a, b); const as = this.store.addAsset(tt.name + '-consolidado', buf); clipsOf(tt).push(newAudioClip(as, a)); clipsOf(tt).sort((x, y) => x.start - y.start); });
  },
  async commitTrack(id = this.store.selectedTrack) {
    const t = this.store.track(id); if (!t || t.type === 'aux' || t.type === 'video') return toast('Selecciona una pista de audio o instrumento.');
    await this.engine.init();
    const pr = progressBox('Congelando “' + t.name + '”…', 'Renderizando con inserciones…');
    const buf = await renderOffline(this.store, { onlyTracks: [id], noMaster: true, ignoreMute: true });
    pr.close();
    this.store.edit('Commit de pista', p => {
      const src = p.tracks.find(x => x.id === id);
      const nt = newTrack('audio', src.name + ' (commit)'); nt.color = src.color; nt.input = 0;
      const as = this.store.addAsset(nt.name, buf);
      nt.playlists[0].clips.push(newAudioClip(as, 0));
      src.inactive = true; src.hidden = false;
      p.tracks.splice(p.tracks.indexOf(src) + 1, 0, nt);
    });
    toast('Pista renderizada a audio; la original quedó desactivada (puedes reactivarla).');
  },

  // ===== Bounce / exportación =====
  async bounceDialog(mode = 'mix') {
    if (!this.store.project.tracks.length) return toast('No hay nada que exportar.');
    await this.engine.init();
    const sel = this.edit.selectedRange(), p = this.store.project;
    const r = await formBox(mode === 'stems' ? 'Exportar stems' : 'Bounce / exportar mezcla', [
      { key: 'name', label: 'Nombre', value: p.name + (mode === 'stems' ? ' stems' : '') },
      { key: 'range', label: 'Rango', type: 'select', options: [['all', 'Sesión completa'], ...(sel ? [['sel', `Selección (${fmtMinSec(sel.start)}–${fmtMinSec(sel.end)})`]] : []), ...(p.loop.end > p.loop.start ? [['loop', 'Región de bucle']] : [])], value: sel ? 'sel' : 'all' },
      { key: 'mode', label: 'Contenido', type: 'select', options: [['mix', 'Mezcla estéreo'], ['stems', 'Stems (una pista por archivo)'], ['both', 'Mezcla + stems']], value: mode },
      { key: 'fmt', label: 'Formato', type: 'select', options: [['wav24', 'WAV 24 bits'], ['wav16', 'WAV 16 bits (CD)'], ['wav32', 'WAV 32 bits flotante'], ['mp3_320', 'MP3 320 kbps'], ['mp3_192', 'MP3 192 kbps'], ['wav24+mp3', 'WAV 24 + MP3 320']], value: 'wav24' },
      { key: 'sr', label: 'Frecuencia de muestreo', type: 'select', options: [[44100, '44.1 kHz'], [48000, '48 kHz'], [96000, '96 kHz']], value: p.sampleRate },
      { key: 'tail', label: 'Cola adicional (s)', type: 'number', value: 2, step: 0.5 },
      { key: 'import', label: 'Añadir el bounce a la sesión', type: 'check', value: false }
    ], 'Exportar');
    if (!r) return;
    const range = r.range === 'sel' ? { start: sel.start, end: sel.end, tail: 0 } : r.range === 'loop' ? { start: p.loop.start, end: p.loop.end, tail: 0 } : { start: 0, end: this.store.sessionLength() + (r.tail || 0) };
    const pr = progressBox('Exportando', 'Renderizando…');
    try {
      const files = [];
      const add = async (name, buf) => {
        if (r.fmt.startsWith('wav')) files.push([name + '.wav', encodeWav(buf, r.fmt.startsWith('wav16') ? 16 : r.fmt.startsWith('wav32') ? 32 : 24)]);
        if (r.fmt.includes('mp3')) files.push([name + '.mp3', await encodeMp3(buf, r.fmt === 'mp3_192' ? 192 : 320)]);
      };
      let mixBuf;
      if (r.mode !== 'stems') { pr.set(0.1, 'Mezcla…'); mixBuf = await renderOffline(this.store, { ...range, sampleRate: +r.sr }); await add(r.name, mixBuf); }
      if (r.mode !== 'mix') {
        const ts = p.tracks.filter(t => !t.inactive && (t.type === 'audio' || t.type === 'instrument' || t.type === 'midi') && clipsOf(t).length);
        for (let i = 0; i < ts.length; i++) { pr.set(0.2 + 0.7 * i / ts.length, 'Stem: ' + ts[i].name); const b = await renderOffline(this.store, { ...range, sampleRate: +r.sr, onlyTracks: [ts[i].id], noMaster: true }); await add(`${r.name} - ${String(i + 1).padStart(2, '0')} ${ts[i].name}`, b); }
      }
      pr.set(0.95, 'Guardando…');
      if (files.length === 1) await this.saveBlob(files[0][1], files[0][0], true, [{ name: 'Audio', extensions: [files[0][0].split('.').pop()] }]);
      else { const z = new JSZip(); files.forEach(([n, b]) => z.file(n, b)); await this.saveBlob(await z.generateAsync({ type: 'blob' }), r.name + '.zip', true, [{ name: 'ZIP', extensions: ['zip'] }]); }
      if (r.import && mixBuf) { const a = this.store.addAsset('Bounce ' + r.name, mixBuf); this.placeAsset(a.id, null, range.start, true); }
      if (mixBuf) toast(`Exportado. Sonoridad integrada ${integratedLUFS(mixBuf).toFixed(1)} LUFS · pico verdadero ${truePeakDb(mixBuf).toFixed(1)} dBTP`, false, 7000);
    } catch (e) { console.error(e); toast('Error al exportar: ' + e.message, true); }
    pr.close();
  },
  async bounceFactory() {
    await this.engine.init();
    const p = this.store.project;
    const r = await formBox('Fábrica de bounces (lote)', [
      { key: 'mix', label: 'Mezcla principal', type: 'check', value: true },
      { key: 'inst', label: 'Instrumental (sin voces)', type: 'check', value: true },
      { key: 'acap', label: 'A cappella (solo voces)', type: 'check', value: true },
      { key: 'stems', label: 'Stems por pista', type: 'check', value: true },
      { key: 'tv', label: 'TV mix (voz −3 dB... instrumental)', type: 'check', value: false },
      { key: 'mp3', label: 'Incluir también MP3 320', type: 'check', value: true }
    ], 'Generar', 'Genera de una vez todas las versiones de entrega en un archivo ZIP. Las voces se identifican por el nombre de la pista (voz, vocal, coro, lead…).');
    if (!r) return;
    const isVox = (t) => /voz|vox|vocal|coro|lead|cant|bv|choir|rap/i.test(t.name);
    const playable = p.tracks.filter(t => !t.inactive && (t.type === 'audio' || t.type === 'instrument' || t.type === 'midi'));
    const vox = playable.filter(isVox).map(t => t.id), novox = playable.filter(t => !isVox(t)).map(t => t.id);
    const z = new JSZip(), pr = progressBox('Fábrica de bounces');
    const add = async (name, buf) => { z.file(name + '.wav', encodeWav(buf, 24)); if (r.mp3) z.file(name + '.mp3', await encodeMp3(buf, 320)); };
    try {
      if (r.mix) { pr.set(0.05, 'Mezcla…'); await add(p.name + ' - Mezcla', await renderOffline(this.store, {})); }
      if (r.inst && vox.length) { pr.set(0.2, 'Instrumental…'); await add(p.name + ' - Instrumental', await renderOffline(this.store, { onlyTracks: novox })); }
      if (r.acap && vox.length) { pr.set(0.35, 'A cappella…'); await add(p.name + ' - A cappella', await renderOffline(this.store, { onlyTracks: vox })); }
      if (r.tv && vox.length) { pr.set(0.45, 'TV mix…'); await add(p.name + ' - TV Mix', await renderOffline(this.store, { onlyTracks: novox })); }
      if (r.stems) { for (let i = 0; i < playable.length; i++) { pr.set(0.5 + 0.45 * i / playable.length, 'Stem ' + playable[i].name); await add(`Stems/${String(i + 1).padStart(2, '0')} ${playable[i].name}`, await renderOffline(this.store, { onlyTracks: [playable[i].id], noMaster: true })); } }
      z.file('LEAME.txt', `Entregables de "${p.name}" generados por Músicos MX el ${new Date().toLocaleString()}.\nTempo: ${p.tempo} BPM · Tonalidad: ${p.key} ${p.scale}`);
      pr.set(0.97, 'Comprimiendo…');
      await this.saveBlob(await z.generateAsync({ type: 'blob' }), p.name + ' - entregables.zip', true, [{ name: 'ZIP', extensions: ['zip'] }]);
    } catch (e) { toast('Error: ' + e.message, true); }
    pr.close();
  },

  // ===== IA =====
  pickAudioClip() { const tg = this.targets().filter(x => x.clip.kind === 'audio'); if (!tg.length) { toast('Selecciona un clip de audio (clic en la mitad inferior del clip).'); return null; } return tg[0]; },
  async aiStems(trackId) {
    await this.engine.init();
    if (trackId) { const t = this.store.track(trackId); const c = t && clipsOf(t).find(x => x.kind === 'audio'); if (c) { this.store.selectedClips.clear(); this.store.selectedClips.add(c.id); } }
    const x = this.pickAudioClip(); if (!x) return;
    const buf = this.clipBuffer(x.clip);
    if (buf.duration > 900 && !(await confirmBox('Separar stems', 'El clip dura más de 15 minutos; el proceso puede tardar varios minutos. ¿Continuar?'))) return;
    const pr = progressBox('✨ Separando stems', 'Analizando espectro (armónico/percusivo/centro)…');
    try {
      const st = await separateStems(this.engine.ctx, buf, (v) => pr.set(v));
      const names = { voz: 'Voz', bateria: 'Batería', bajo: 'Bajo', otros: 'Otros instrumentos' };
      this.store.edit('Separar stems', p => {
        const src = p.tracks.find(t => t.id === x.track.id); let idx = p.tracks.indexOf(src);
        for (const k of Object.keys(st)) {
          const t = newTrack('audio', `${names[k]} (${src.name})`); t.input = 0;
          const a = this.store.addAsset(t.name, st[k]);
          t.playlists[0].clips.push(newAudioClip(a, x.clip.start, { duration: x.clip.duration }));
          p.tracks.splice(++idx, 0, t);
        }
        src.mute = true;
      });
      toast('Stems creados en 4 pistas nuevas; la pista original se silenció.', false, 6000);
    } catch (e) { console.error(e); toast('Error al separar: ' + e.message, true); }
    pr.close();
  },
  async aiTranscribe(trackId) {
    await this.engine.init();
    if (trackId) { const t = this.store.track(trackId); const c = t && clipsOf(t).find(q => q.kind === 'audio'); if (c) { this.store.selectedClips.clear(); this.store.selectedClips.add(c.id); } }
    const x = this.pickAudioClip(); if (!x) return;
    const buf = this.clipBuffer(x.clip);
    const r = await formBox('Transcribir voz a texto', [{ key: 'lang', label: 'Idioma', type: 'select', options: [['spanish', 'Español'], ['english', 'Inglés'], ['portuguese', 'Portugués'], ['french', 'Francés'], ['italian', 'Italiano'], ['german', 'Alemán']], value: 'spanish' }, { key: 'model', label: 'Modelo', type: 'select', options: [['Xenova/whisper-tiny', 'Whisper tiny (rápido, ~40 MB)'], ['Xenova/whisper-base', 'Whisper base (equilibrado, ~75 MB)'], ['Xenova/whisper-small', 'Whisper small (preciso, ~250 MB)']], value: this.settings.whisperModel }], 'Transcribir', 'Usa el modelo libre Whisper ejecutándose en tu equipo. La primera vez descarga el modelo (requiere Internet); después funciona sin conexión.');
    if (!r) return;
    this.settings.whisperModel = r.model; this.saveSettings();
    const pr = progressBox('✨ Transcribiendo', 'Preparando…');
    try {
      const segs = await transcribe(buf, { language: r.lang, model: r.model }, (v, t) => pr.set(v, t));
      pr.close();
      this.transcriptWindow(segs.map(s => ({ ...s, start: x.clip.start + s.start / (x.clip.rate || 1), end: x.clip.start + s.end / (x.clip.rate || 1) })), x.track.name);
    } catch (e) { pr.close(); console.error(e); toast('No se pudo transcribir: ' + e.message + '. Verifica tu conexión para la primera descarga del modelo.', true, 9000); }
  },
  transcriptWindow(segs, name) {
    const body = h('div', { style: { width: '460px', maxHeight: '60vh', overflow: 'auto' } });
    for (const s of segs) body.append(h('div', { class: 'mitem', style: { userSelect: 'text' }, onclick: () => this.engine.setPosition(s.start) }, h('span', { style: { fontFamily: 'var(--mono)', color: 'var(--teal)', flex: '0 0 70px' } }, fmtMinSec(s.start).slice(0, -2)), h('span', { style: { flex: 1 } }, s.text)));
    const srt = () => segs.map((s, i) => { const f = (t) => { const hh = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), ss = Math.floor(t % 60), ms = Math.round(t % 1 * 1000); return `${String(hh).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')},${String(ms).padStart(3, '0')}`; }; return `${i + 1}\n${f(s.start)} --> ${f(s.end)}\n${s.text}\n`; }).join('\n');
    body.append(h('div', { style: { display: 'flex', gap: '6px', marginTop: '10px', flexWrap: 'wrap' } },
      h('button', { class: 'btn small', onclick: () => { this.store.edit('Marcadores de transcripción', p => { for (const s of segs) p.markers.push({ id: uid('mk'), t: s.start, name: s.text.slice(0, 40), color: '#2ee6c5' }); p.markers.sort((a, b) => a.t - b.t); }); toast('Marcadores creados.'); } }, 'Crear marcadores'),
      h('button', { class: 'btn small', onclick: () => navigator.clipboard?.writeText(segs.map(s => s.text).join('\n')).then(() => toast('Texto copiado.')) }, 'Copiar texto'),
      h('button', { class: 'btn small', onclick: () => this.saveBlob(new Blob([srt()], { type: 'text/plain' }), name + '.srt', true, [{ name: 'Subtítulos', extensions: ['srt'] }]) }, 'Exportar SRT'),
      h('button', { class: 'btn small', onclick: () => this.saveBlob(new Blob([segs.map(s => `[${fmtMinSec(s.start)}] ${s.text}`).join('\n')], { type: 'text/plain' }), name + '.txt', true, [{ name: 'Texto', extensions: ['txt'] }]) }, 'Exportar TXT')));
    floatWindow('transcript', '📝 Transcripción — ' + name, body, { w: 490 });
  },
  async aiAudioToMidi() {
    await this.engine.init();
    const x = this.pickAudioClip(); if (!x) return;
    const r = await formBox('Audio a MIDI', [{ key: 'mode', label: 'Tipo de material', type: 'select', options: [['melodia', 'Melodía (voz, bajo, instrumento solista)'], ['percusion', 'Percusión (ataques → notas)']], value: 'melodia' }, { key: 'note', label: 'Nota de percusión', type: 'select', options: [[36, 'Bombo'], [38, 'Tarola'], [42, 'Hi-hat'], [39, 'Palmas']], value: 36 }]);
    if (!r) return;
    const pr = progressBox('✨ Audio a MIDI', 'Detectando notas…');
    try {
      const notes = await audioToMidi(this.clipBuffer(x.clip), { mode: r.mode, drumNote: +r.note }, v => pr.set(v));
      const rate = x.clip.rate || 1;
      const [id] = this.addTracks('instrument', 1, x.track.name + ' MIDI', r.mode === 'percusion' ? 'drums:Acústica' : 'synth:Piano eléctrico');
      this.store.edit('Audio a MIDI', p => { p.tracks.find(t => t.id === id).playlists[0].clips.push(newMidiClip(x.clip.start, x.clip.duration, notes.map(n => ({ ...n, t: n.t / rate, d: n.d / rate })), x.clip.name + ' MIDI')); });
      toast(`${notes.length} notas detectadas.`);
    } catch (e) { toast('Error: ' + e.message, true); }
    pr.close();
  },
  async aiDetect() {
    await this.engine.init();
    const x = this.pickAudioClip(); if (!x) return;
    const pr = progressBox('✨ Analizando', 'Tempo, tonalidad y sonoridad…');
    await yieldUI();
    const buf = this.clipBuffer(x.clip);
    const m = analyzeMusic(buf), an = analyze(buf);
    pr.close();
    const res = await modal('Análisis del clip', `<table class="list"><tr><td>Tempo estimado</td><td><b>${m.tempo} BPM</b> (o ${(m.tempo / 2).toFixed(1)} / ${(m.tempo * 2).toFixed(1)})</td></tr><tr><td>Tonalidad estimada</td><td><b>${m.keyName}</b> (confianza ${(m.confidence * 100).toFixed(0)}%)</td></tr><tr><td>Sonoridad integrada</td><td>${an.lufs.toFixed(1)} LUFS</td></tr><tr><td>Pico</td><td>${an.peak.toFixed(1)} dBFS</td></tr><tr><td>Factor de cresta</td><td>${an.crest.toFixed(1)} dB</td></tr><tr><td>Centroide espectral</td><td>${Math.round(an.centroid)} Hz</td></tr></table>`,
      [{ label: 'Cerrar', value: null }, { label: 'Ajustar clip al tempo de la sesión', value: 'stretch' }, { label: 'Aplicar a la sesión', primary: true, value: 'apply' }]);
    if (res === 'apply') this.store.edit('Tempo y tonalidad detectados', p => { p.tempo = m.tempo; p.key = m.key; p.scale = m.mode; });
    if (res === 'stretch') {
      const f = m.tempo / this.store.project.tempo; const pr2 = progressBox('Estirando…');
      const chans = []; for (let c = 0; c < buf.numberOfChannels; c++) chans.push(await timeStretch(buf.getChannelData(c), f, buf.sampleRate, v => pr2.set((c + v) / buf.numberOfChannels)));
      this.store.edit('Ajustar a tempo', () => this.replaceClipAudio(x.clip.id, this.makeBuffer(chans, buf.sampleRate), 'atempo')); pr2.close();
    }
  },
  async aiBeatQuantize() {
    await this.engine.init();
    const x = this.pickAudioClip(); if (!x) return;
    const r = await formBox('Cuantizar audio por ataques', [{ key: 'sens', label: 'Sensibilidad (1 = alta, 3 = baja)', type: 'number', value: 1.6, step: 0.1 }, { key: 'strength', label: 'Intensidad (0–1)', type: 'number', value: 1, step: 0.05 }], 'Cuantizar', 'Detecta los ataques (golpes, notas), divide el clip en esos puntos y mueve cada fragmento a la rejilla actual. Usa una rejilla adecuada (p. ej. 1/16).');
    if (!r) return;
    const buf = this.clipBuffer(x.clip); const on = detectOnsets(mono(buf), buf.sampleRate, r.sens);
    const rate = x.clip.rate || 1;
    this.store.edit('Cuantizar por ataques', () => {
      const f = this.store.findClip(x.clip.id); const clips = f.playlist.clips; let cur = f.clip; const pieces = [cur];
      for (const t of on) { const at = x.clip.start + t / rate - 0.005; const nr = splitClip(clips, cur, at); if (nr) { pieces.push(nr); cur = nr; } }
      for (const c of pieces) { const target = this.edit.snap(c.start + 0.005, true) - 0.005; c.start = Math.max(0, c.start + (target - c.start) * r.strength); c.fadeIn = 0.003; c.fadeOut = 0.01; }
    });
    toast(`${on.length} ataques detectados y cuantizados.`);
  },
  async aiAutoMix() {
    await this.engine.init();
    if (!this.store.project.tracks.length) return toast('No hay pistas para mezclar.');
    const pr = progressBox('✨ Mezcla automática', 'Analizando pistas…');
    let plan;
    try { plan = await autoMixPlan(this.store, (t) => this.renderTrackBuffer(t, { maxLen: 120 }), (v, t) => pr.set(v, t)); } catch (e) { pr.close(); return toast('Error: ' + e.message, true); }
    pr.close();
    if (!plan.length) return toast('No se encontró audio para analizar.');
    const rows = plan.map(x => `<tr><td>${escapeHtml(x.name)}</td><td>${x.role}</td><td>${x.lufs.toFixed(1)}</td><td>${x.volume > 0 ? '+' : ''}${x.volume} dB</td><td>${x.pan === 0 ? 'C' : (x.pan < 0 ? 'I' : 'D') + Math.round(Math.abs(x.pan) * 100)}</td><td>EQ${x.comp ? ' + Comp' : ''}${x.deesser ? ' + De-Esser' : ''}</td></tr>`).join('');
    const ok = await modal('✨ Plan de mezcla automática', `<p>La IA analizó la sonoridad, el espectro y la dinámica de cada pista y propone este punto de partida:</p><table class="list"><tr><th>Pista</th><th>Rol</th><th>LUFS</th><th>Volumen</th><th>Paneo</th><th>Procesos</th></tr>${rows}</table><p style="color:var(--dim)">Se añadirán EQ/compresión a las inserciones y se ajustarán volumen y paneo. Todo se puede deshacer con Ctrl+Z.</p>`, [{ label: 'Cancelar', value: false }, { label: 'Solo niveles y paneo', value: 'levels' }, { label: 'Aplicar todo', primary: true, value: true }], { width: '720px' });
    if (!ok) return;
    this.store.edit('Mezcla automática', p => {
      for (const x of plan) {
        const t = p.tracks.find(q => q.id === x.trackId); if (!t) continue;
        t.volume = x.volume; t.pan = x.pan;
        if (ok === true) {
          t.inserts = t.inserts.filter(i => !i.auto);
          t.inserts.push({ id: uid('ins'), type: 'eq7', params: { ...defaultParams('eq7'), ...x.eq }, bypass: false, auto: true });
          if (x.comp) t.inserts.push({ id: uid('ins'), type: 'comp', params: { ...defaultParams('comp'), ...x.comp }, bypass: false, auto: true });
          if (x.deesser) t.inserts.push({ id: uid('ins'), type: 'deesser', params: defaultParams('deesser'), bypass: false, auto: true });
        }
      }
    });
    this.mix.build(); toast('Mezcla automática aplicada. Ajusta a tu gusto.');
  },
  async aiMaster() {
    await this.engine.init();
    if (!this.store.sessionLength()) return toast('No hay audio en la sesión.');
    let refFile = null;
    const refBtn = h('button', { class: 'btn small', onclick: () => this.pickFiles('audio/*', f => { refFile = f[0]; refBtn.textContent = '✓ ' + f[0].name; }) }, 'Elegir pista de referencia (opcional)…');
    const sel = h('select', {}); for (const [k, v] of Object.entries(MASTER_TARGETS)) sel.append(h('option', { value: v }, k));
    const ok = await modal('✨ Masterización asistida', h('div', {}, h('p', {}, 'La IA analiza tu mezcla (sonoridad, balance tonal, dinámica) y configura una cadena de mastering en el Master: EQ → compresor → imagen estéreo → limitador, apuntando a la sonoridad objetivo.'), h('div', { class: 'form' }, h('label', {}, 'Destino'), sel, h('label', {}, 'Referencia'), refBtn)), [{ label: 'Cancelar', value: false }, { label: 'Masterizar', primary: true, value: true }]);
    if (!ok) return;
    const target = +sel.value;
    const pr = progressBox('✨ Masterizando', 'Renderizando mezcla…');
    try {
      const mix = await renderOffline(this.store, { noMaster: true, end: Math.min(this.store.sessionLength(), 240) });
      pr.set(0.4, 'Analizando…');
      const ref = refFile ? await decodeFile(this.engine.ctx, refFile) : null;
      const plan = masterPlan(mix, target, ref);
      const chain = [['eq7', plan.eq], ['comp', plan.comp], ['stereo', plan.stereo], ['limiter', plan.limiter]];
      this.store.edit('Masterización asistida', p => { p.master.inserts = chain.map(([type, params]) => ({ id: uid('ins'), type, params: { ...defaultParams(type), ...params }, bypass: false })); });
      // refinar la ganancia del limitador midiendo el resultado
      for (let it = 0; it < 2; it++) {
        pr.set(0.6 + it * 0.2, 'Verificando sonoridad…');
        const out = await renderOffline(this.store, { end: Math.min(this.store.sessionLength(), 240) });
        const l = integratedLUFS(out), diff = target - l;
        if (Math.abs(diff) < 0.5) break;
        this.store.live(p => { const lim = p.master.inserts.find(i => i.type === 'limiter'); lim.params.gain = clamp(lim.params.gain + diff, 0, 24); });
      }
      const out = await renderOffline(this.store, { end: Math.min(this.store.sessionLength(), 240) });
      this.engine.rebuild(); this.mix.build();
      pr.close();
      modal('Masterización lista', `<table class="list"><tr><td>Antes</td><td>${plan.analysis.lufs.toFixed(1)} LUFS · pico ${plan.analysis.peak.toFixed(1)} dBFS</td></tr><tr><td>Después</td><td><b>${integratedLUFS(out).toFixed(1)} LUFS</b> · pico verdadero ${truePeakDb(out).toFixed(1)} dBTP</td></tr><tr><td>Objetivo</td><td>${target} LUFS</td></tr></table><p>Cadena creada en el Master: EQ, compresor, imagen estéreo y limitador. Ábrelos en la ventana de Mezcla para afinar.</p>`);
    } catch (e) { pr.close(); console.error(e); toast('Error: ' + e.message, true); }
  },
  async aiLoudness() {
    await this.engine.init();
    if (!this.store.sessionLength()) return toast('No hay audio.');
    const pr = progressBox('Analizando sonoridad…'); const b = await renderOffline(this.store, {}); pr.close();
    const an = analyze(b);
    modal('📊 Análisis de sonoridad de la mezcla', `<table class="list"><tr><td>Sonoridad integrada</td><td><b>${an.lufs.toFixed(1)} LUFS</b></td></tr><tr><td>Pico verdadero</td><td>${truePeakDb(b).toFixed(2)} dBTP</td></tr><tr><td>RMS</td><td>${an.rms.toFixed(1)} dBFS</td></tr><tr><td>Rango dinámico (cresta)</td><td>${an.crest.toFixed(1)} dB</td></tr><tr><td>Duración</td><td>${fmtMinSec(b.duration)}</td></tr></table><p style="color:var(--dim)">Referencias: Spotify/YouTube −14 LUFS, Apple Music −16, broadcast EBU R128 −23. Pico verdadero recomendado ≤ −1 dBTP.</p>`);
  },
  async aiBestTakes(trackId = this.store.selectedTrack) {
    await this.engine.init();
    const t = this.store.track(trackId); if (!t || t.playlists.length < 2) return toast('La pista necesita al menos 2 listas de reproducción (tomas). Graba en bucle o duplica listas.');
    const bar = 60 / this.store.project.tempo * this.store.project.timeSig[0];
    const pr = progressBox('✨ Eligiendo mejores tomas', 'Evaluando cada toma por compás…');
    const scores = await scoreTakes(this.store, t, (c) => this.clipBuffer(c), bar);
    pr.close();
    // para cada segmento elegir la lista con mayor puntuación
    const segs = new Map();
    scores.forEach(list => list.forEach(s => { const k = Math.round(s.t / bar); const cur = segs.get(k); if (!cur || s.score > cur.score) segs.set(k, s); }));
    if (!segs.size) return toast('No se encontró audio en las tomas.');
    this.store.edit('Comp automático', p => {
      const tt = p.tracks.find(x => x.id === trackId);
      const comp = { id: uid('pl'), name: 'Comp IA', clips: [] };
      const keys = [...segs.keys()].sort((a, b) => a - b);
      for (const k of keys) {
        const s = segs.get(k), a = k * bar, b = a + bar;
        const src = JSON.parse(JSON.stringify(tt.playlists[s.playlist].clips));
        clearRange(src, 0, a); clearRange(src, b, 1e9);
        for (const c of src) { c.id = uid('clp'); c.fadeIn = c.fadeOut = 0.01; comp.clips.push(c); }
      }
      comp.clips.sort((x, y) => x.start - y.start);
      tt.playlists.push(comp); tt.activePlaylist = tt.playlists.length - 1;
    });
    toast('Se creó la lista “Comp IA” con el mejor compás de cada toma.');
  },
  async aiCompose(trackId) {
    await this.engine.init();
    const p = this.store.project;
    const r = await formBox('✨ Compositor IA', [
      { key: 'genre', label: 'Género / estilo', type: 'select', options: Object.keys(GENRES), value: 'Pop' },
      { key: 'bars', label: 'Compases', type: 'number', value: 8, min: 1, max: 64 },
      { key: 'key', label: 'Tónica', type: 'select', options: KEYS, value: p.key },
      { key: 'scale', label: 'Escala', type: 'select', options: ['mayor', 'menor'], value: /menor/.test(p.scale) ? 'menor' : 'mayor' },
      { key: 'drums', label: 'Batería', type: 'check', value: true },
      { key: 'chords', label: 'Acordes', type: 'check', value: true },
      { key: 'pattern', label: 'Patrón de acordes', type: 'select', options: [['sostenido', 'Sostenidos'], ['arpegio', 'Arpegio'], ['ritmico', 'Rítmico']], value: 'sostenido' },
      { key: 'bass', label: 'Bajo', type: 'check', value: true },
      { key: 'bassStyle', label: 'Estilo de bajo', type: 'select', options: [['raíz', 'Notas largas'], ['octavas', 'Corcheas'], ['cumbia', 'Cumbia'], ['caminante', 'Caminante (jazz)']], value: 'raíz' },
      { key: 'melody', label: 'Melodía', type: 'check', value: false },
      { key: 'useTempo', label: 'Usar tempo típico del género', type: 'check', value: false }
    ], 'Componer', 'Genera ideas musicales originales con reglas de teoría musical y aleatoriedad controlada. Cada clic produce una variación distinta.');
    if (!r) return;
    if (r.useTempo) this.store.edit('Tempo del género', pp => { pp.tempo = GENRES[r.genre].bpm; });
    const tempo = this.store.project.tempo, at = this.edit.snap(this.engine.getPosition(), true), bars = clamp(r.bars | 0, 1, 64);
    const len = bars * 60 / tempo * this.store.project.timeSig[0];
    const mk = (name, inst, notes, existing) => {
      let id = existing;
      if (!id) [id] = this.addTracks('instrument', 1, name, inst);
      this.store.edit('Compositor: ' + name, pp => { pp.tracks.find(t => t.id === id).playlists[0].clips.push(newMidiClip(at, len, notes, name + ' IA')); });
    };
    const tsel = trackId && this.store.track(trackId);
    if (r.drums) mk('Batería', r.genre === 'Trap' || r.genre === 'Reggaetón' || r.genre === 'House' ? 'drums:Electrónica 808' : (/Cumbia|Bolero/.test(r.genre) ? 'drums:Latina' : 'drums:Acústica'), generateDrums(r.genre, bars, tempo), tsel?.instrument?.type === 'drums' ? trackId : null);
    let ch = null;
    if (r.chords || r.bass || r.melody) ch = generateChords(r.key, r.scale, bars, tempo, { pattern: r.pattern });
    if (r.chords) mk('Acordes', r.pattern === 'arpegio' ? 'synth:Marimba' : 'synth:Piano eléctrico', ch.notes, tsel?.instrument?.type === 'synth' && !r.drums ? trackId : null);
    if (r.bass) mk('Bajo', 'synth:Bajo eléctrico', generateBass(ch.chords, tempo, r.bassStyle, bars));
    if (r.melody) mk('Melodía', 'synth:Lead brillante', generateMelody(r.key, r.scale, bars, tempo, ch.chords));
    if (ch) toast('Progresión: ' + ch.progression.map(d => ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'][d - 1]).join(' – '), false, 6000);
  },
  async aiSettings() {
    const s = this.settings;
    const r = await formBox('Configuración de IA', [
      { key: 'ollamaUrl', label: 'Servidor LLM local (Ollama)', value: s.ollamaUrl },
      { key: 'ollamaModel', label: 'Modelo LLM', value: s.ollamaModel },
      { key: 'useLLM', label: 'Usar LLM local para peticiones libres', type: 'check', value: !!s.useLLM },
      { key: 'whisperModel', label: 'Modelo de transcripción', type: 'select', options: [['Xenova/whisper-tiny', 'Whisper tiny'], ['Xenova/whisper-base', 'Whisper base'], ['Xenova/whisper-small', 'Whisper small']], value: s.whisperModel }
    ], 'Guardar', 'Todas las funciones de IA de Músicos MX se ejecutan en tu equipo. El asistente entiende órdenes en español sin conexión; opcionalmente puede apoyarse en un modelo de lenguaje libre local con Ollama (ollama.com) para peticiones más libres.');
    if (!r) return; Object.assign(s, r); this.saveSettings(); toast('Configuración de IA guardada.');
  },

  // ===== Panel del asistente =====
  renderAIPanel() {
    const b = $('#aiBody'); if (b.dataset.init) return; b.dataset.init = 1;
    const tool = (icon, title, sub, f) => h('button', { class: 'btn', onclick: f }, h('b', {}, icon + ' ' + title), h('small', {}, sub));
    b.append(h('div', { class: 'ai-tools' },
      tool('🎚', 'Separar stems', 'Voz, batería, bajo, otros', () => this.aiStems()),
      tool('📝', 'Transcribir', 'Voz a texto (Whisper)', () => this.aiTranscribe()),
      tool('🎹', 'Audio a MIDI', 'Melodía o percusión', () => this.aiAudioToMidi()),
      tool('🎤', 'Afinación', 'Corrección de tono', () => this.audioSuite('autotune')),
      tool('🧹', 'Limpiar ruido', 'Reducción espectral', () => this.audioSuite('denoise')),
      tool('⏱', 'Tempo y tono', 'Detección automática', () => this.aiDetect()),
      tool('🥁', 'Cuantizar audio', 'Alinear ataques', () => this.aiBeatQuantize()),
      tool('✂', 'Quitar silencios', 'Strip silence', () => this.stripSilence()),
      tool('🎛', 'Mezcla automática', 'Niveles, paneo, EQ, comp', () => this.aiAutoMix()),
      tool('💿', 'Masterizar', 'LUFS objetivo + referencia', () => this.aiMaster()),
      tool('⭐', 'Mejores tomas', 'Auto-comping', () => this.aiBestTakes()),
      tool('🎼', 'Compositor', 'Batería, acordes, bajo…', () => this.aiCompose())));
    this.aiLog = h('div', { class: 'ai-chat' });
    b.append(this.aiLog);
    this.aiSay('¡Hola! Soy el asistente de Músicos MX. Escríbeme lo que necesitas en español, por ejemplo:\n• ' + COMMAND_HELP.slice(0, 6).join('\n• ') + '\n\nEscribe “ayuda” para ver todas las órdenes.');
  },
  aiSay(text, user = false) { this.aiLog.append(h('div', { class: 'ai-msg' + (user ? ' user' : '') }, text)); this.aiLog.parentElement.scrollTop = 1e9; },
  async sendAI() {
    const inp = $('#aiInput'); const text = inp.value.trim(); if (!text) return; inp.value = '';
    this.renderAIPanel(); this.aiSay(text, true);
    if (/^(ayuda|help|\?)$/i.test(text)) return this.aiSay('Puedo hacer esto (combina órdenes con “y luego” o “;”):\n• ' + COMMAND_HELP.join('\n• '));
    let cmds = parseCommand(text, this.store.project);
    if (!cmds.length && this.settings.useLLM) {
      try { this.aiSay('Consultando el modelo local…'); const lines = await askLocalLLM(text, this.store.project, this.settings); for (const l of lines) cmds.push(...parseCommand(l, this.store.project)); }
      catch (e) { this.aiSay('No pude contactar al LLM local (' + e.message + ').'); }
    }
    if (!cmds.length) return this.aiSay('No entendí esa orden. Escribe “ayuda” para ver ejemplos' + (this.settings.useLLM ? '.' : ', o activa el LLM local en IA › Configuración para peticiones libres.'));
    for (const c of cmds) { try { const msg = await this.execCommand(c); if (msg) this.aiSay('✓ ' + msg); } catch (e) { this.aiSay('✗ ' + e.message); } }
  },
  async execCommand(c) {
    const need = () => { if (!c.trackId) throw new Error('No encontré esa pista. Menciónala por su nombre o número.'); return this.store.track(c.trackId); };
    const selectFirstClip = (t) => { const cl = clipsOf(t).find(x => x.kind === 'audio'); if (!cl) throw new Error('La pista “' + t.name + '” no tiene audio.'); this.store.selectedClips.clear(); this.store.selectedClips.add(cl.id); this.edit.sel = { start: 0, end: 0, tracks: new Set() }; };
    const p = this.store.project, bar = 60 / p.tempo * p.timeSig[0];
    if ($('#welcome').style.display !== 'none' && !['undo', 'redo'].includes(c.cmd)) await this.createSession('Sesión del asistente');
    switch (c.cmd) {
      case 'undo': this.store.undo(); return 'Deshecho.';
      case 'redo': this.store.redo(); return 'Rehecho.';
      case 'addTracks': { const inst = c.drums ? 'drums:Acústica' : (c.type === 'instrument' ? 'synth:Piano eléctrico' : null); this.addTracks(c.type, clamp(c.count, 1, 64), c.name, inst); return `Creé ${c.count} pista(s).`; }
      case 'tempo': this.store.edit('Tempo', pp => pp.tempo = clamp(c.bpm, 20, 300)); return 'Tempo ' + c.bpm + ' BPM.';
      case 'timeSig': this.store.edit('Compás', pp => pp.timeSig = [c.a, c.b]); return `Compás ${c.a}/${c.b}.`;
      case 'metronome': this.engine.metronome = c.on; this.refreshTransport(); return 'Metrónomo ' + (c.on ? 'encendido' : 'apagado') + '.';
      case 'gotoBar': this.engine.setPosition((c.bar - 1) * bar); return 'Cabezal en el compás ' + c.bar + '.';
      case 'gotoStart': this.engine.setPosition(0); return 'Al inicio.';
      case 'play': this.engine.play(); return 'Reproduciendo.';
      case 'stop': this.engine.stop(); return 'Detenido.';
      case 'record': await this.toggleRecord(); return this.engine.recording ? 'Grabando.' : null;
      case 'loop': this.store.edit('Bucle', pp => pp.loop = { enabled: true, start: (c.from - 1) * bar, end: (c.to - 1) * bar }); return `Bucle del compás ${c.from} al ${c.to}.`;
      case 'loopOff': this.store.edit('Bucle', pp => pp.loop.enabled = false); return 'Bucle desactivado.';
      case 'marker': this.store.edit('Marcador', pp => { pp.markers.push({ id: uid('mk'), t: this.engine.getPosition(), name: c.name, color: '#ffd23f' }); pp.markers.sort((a, b) => a.t - b.t); }); return 'Marcador “' + c.name + '”.';
      case 'rename': need(); this.store.edit('Renombrar', pp => pp.tracks.find(t => t.id === c.trackId).name = c.name); return 'Renombrada a ' + c.name + '.';
      case 'deleteTrack': { const t = need(); this.store.edit('Eliminar pista', pp => { pp.tracks = pp.tracks.filter(x => x.id !== t.id); }); return 'Eliminé ' + t.name + '.'; }
      case 'mute': { const t = need(); this.store.edit('Silenciar', pp => pp.tracks.find(x => x.id === t.id).mute = c.on); return (c.on ? 'Silencié ' : 'Activé ') + t.name + '.'; }
      case 'solo': { const t = need(); this.store.edit('Solo', pp => pp.tracks.find(x => x.id === t.id).solo = c.on); return 'Solo ' + (c.on ? 'en ' : 'fuera de ') + t.name + '.'; }
      case 'arm': { const t = need(); this.store.edit('Armar', pp => pp.tracks.find(x => x.id === t.id).recArm = c.on); return t.name + (c.on ? ' armada.' : ' desarmada.'); }
      case 'volume': { const t = need(); this.store.edit('Volumen', pp => pp.tracks.find(x => x.id === t.id).volume = clamp(c.db, -90, 12)); return `Volumen de ${t.name}: ${c.db} dB.`; }
      case 'volumeRel': { const t = need(); this.store.edit('Volumen', pp => { const x = pp.tracks.find(q => q.id === t.id); x.volume = clamp(x.volume + c.db, -90, 12); }); return `Volumen de ${t.name}: ${this.store.track(t.id).volume.toFixed(1)} dB.`; }
      case 'pan': { const t = need(); this.store.edit('Paneo', pp => pp.tracks.find(x => x.id === t.id).pan = clamp(c.value, -1, 1)); return 'Paneo ajustado.'; }
      case 'insert': { if (!c.trackId) throw new Error('¿En qué pista? Ej.: “agrega reverb a Voz”.'); this.addInsert(c.trackId, c.plugin); return `Inserté ${PLUGINS[c.plugin].name} en ${c.trackId === 'master' ? 'Master' : this.store.track(c.trackId).name}.`; }
      case 'audiosuite': { const t = need(); selectFirstClip(t); await this.audioSuite(c.op); return null; }
      case 'autotune': { const t = need(); selectFirstClip(t); await this.audioSuite('autotune'); return null; }
      case 'stripSilence': { const t = need(); selectFirstClip(t); await this.stripSilence(); return null; }
      case 'genDrums': { const [id] = this.addTracks('instrument', 1, 'Batería ' + c.genre, 'drums:' + (/Trap|Reggae|House/.test(c.genre) ? 'Electrónica 808' : /Cumbia|Bolero/.test(c.genre) ? 'Latina' : 'Acústica')); const at = this.edit.snap(this.engine.getPosition(), true); this.store.edit('Batería IA', pp => pp.tracks.find(t => t.id === id).playlists[0].clips.push(newMidiClip(at, c.bars * bar, generateDrums(c.genre, c.bars, p.tempo), c.genre))); return `Batería de ${c.genre}, ${c.bars} compases.`; }
      case 'genChords': { const key = c.key ? c.key.toUpperCase().replace(/^(LA|SI|DO|RE|MI|FA|SOL)/i, m => ({ LA: 'A', SI: 'B', DO: 'C', RE: 'D', MI: 'E', FA: 'F', SOL: 'G' })[m.toUpperCase()]) : p.key; const k = KEYS.includes(key) ? key : p.key; const sc = c.mode || (/menor/.test(p.scale) ? 'menor' : 'mayor'); const ch = generateChords(k, sc, c.bars, p.tempo); this._lastChords = ch; const [id] = this.addTracks('instrument', 1, 'Acordes', 'synth:Piano eléctrico'); const at = this.edit.snap(this.engine.getPosition(), true); this.store.edit('Acordes IA', pp => pp.tracks.find(t => t.id === id).playlists[0].clips.push(newMidiClip(at, c.bars * bar, ch.notes, 'Acordes ' + k))); return `Acordes en ${k} ${sc}: ${ch.progression.join('-')}.`; }
      case 'genBass': { const ch = this._lastChords || generateChords(p.key, p.scale, 8, p.tempo); const [id] = this.addTracks('instrument', 1, 'Bajo', 'synth:Bajo eléctrico'); const at = this.edit.snap(this.engine.getPosition(), true); this.store.edit('Bajo IA', pp => pp.tracks.find(t => t.id === id).playlists[0].clips.push(newMidiClip(at, ch.chords.length * bar, generateBass(ch.chords, p.tempo, 'octavas'), 'Bajo'))); return 'Línea de bajo creada.'; }
      case 'genMelody': { const ch = this._lastChords || generateChords(p.key, p.scale, 8, p.tempo); const [id] = this.addTracks('instrument', 1, 'Melodía', 'synth:Lead brillante'); const at = this.edit.snap(this.engine.getPosition(), true); this.store.edit('Melodía IA', pp => pp.tracks.find(t => t.id === id).playlists[0].clips.push(newMidiClip(at, ch.chords.length * bar, generateMelody(p.key, p.scale, ch.chords.length, p.tempo, ch.chords), 'Melodía'))); return 'Melodía creada.'; }
      case 'stems': { const t = need(); selectFirstClip(t); await this.aiStems(); return null; }
      case 'transcribe': { const t = need(); selectFirstClip(t); await this.aiTranscribe(); return null; }
      case 'detectTempo': case 'detectKey': { const t = need(); selectFirstClip(t); await this.aiDetect(); return null; }
      case 'audioToMidi': { const t = need(); selectFirstClip(t); await this.aiAudioToMidi(); return null; }
      case 'automix': await this.aiAutoMix(); return null;
      case 'master': await this.aiMaster(); return null;
      case 'export': await this.bounceDialog('mix'); return null;
      case 'exportStems': await this.bounceDialog('stems'); return null;
      case 'save': await this.saveSessionFile(); return null;
    }
    throw new Error('Orden no reconocida.');
  }
};
