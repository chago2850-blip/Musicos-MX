// Músicos MX — controlador principal de la aplicación
// Copyright (C) 2026 Santiago Miguel — GNU GPL v3 o posterior.
//
// Este programa es software libre: puede redistribuirlo y/o modificarlo bajo los términos de la
// Licencia Pública General GNU publicada por la Free Software Foundation, ya sea la versión 3 de
// la Licencia o (a su elección) cualquier versión posterior. Se distribuye con la esperanza de que
// sea útil, pero SIN GARANTÍA ALGUNA. Consulte el archivo LICENSE.
import { Store, newProject, newTrack, clipsOf, newAudioClip, newMidiClip, splitClip, clearRange, computePeaks, normalizeProject } from './project.js';
import { Engine } from './engine/engine.js';
import { PLUGINS, defaultParams } from './engine/plugins.js';
import { SYNTH_PRESETS, DRUM_KITS } from './engine/instruments.js';
import { EditView } from './ui/edit.js';
import { MixView } from './ui/mix.js';
import { PianoRoll } from './ui/pianoroll.js';
import { $, $$, h, modal, toast, contextMenu, floatWindow, formBox, promptBox, confirmBox, progressBox, alertBox } from './ui/dialogs.js';
import { saveSession, loadSession, decodeFile, parseMidi, writeMidi } from './io.js';
import { fmtBars, fmtMinSec, fmtSamples, fmtTimecode, uid, clamp, dbToGain, TRACK_COLORS, downloadBlob, escapeHtml } from './util.js';
import { KEYS, SCALES } from './ai/ai.js';
import { installFeatures } from './features.js';

export const VERSION = '1.0.0';

class App {
  constructor() {
    this.store = new Store();
    this.engine = new Engine(this.store);
    this.view = 'edit';
    this.settings = Object.assign({ theme: 'dark', autosave: true, counter: 'bars', ollamaUrl: 'http://localhost:11434', ollamaModel: 'llama3.2', whisperModel: 'Xenova/whisper-base', latencyComp: 0, autoMonitor: false, followPlayhead: true, returnToStart: false }, JSON.parse(localStorage.getItem('mmx-settings') || '{}'));
    this.clipboard = null; this.fileName = null;
    installFeatures(this);
  }
  async start() {
    document.body.classList.toggle('light', this.settings.theme === 'light');
    this.edit = new EditView(this);
    this.mix = new MixView(this);
    this.roll = new PianoRoll(this);
    this.engine.latencyComp = this.settings.latencyComp; this.engine.autoMonitor = this.settings.autoMonitor; this.engine.returnToStart = this.settings.returnToStart;
    this.edit.follow = this.settings.followPlayhead;
    this.buildMenus(); this.bindToolbar(); this.bindKeys(); this.bindPanels();
    this.store.on('change', (e) => this.onChange(e));
    this.engine.on('message', (m) => toast(m, true, 6000));
    this.engine.on('stop', () => { this.refreshTransport(); this.video?.pause(); });
    this.engine.on('play', () => { this.refreshTransport(); this.syncVideo(true); });
    this.engine.on('record', () => this.refreshTransport());
    this.engine.on('position', () => { this.edit.dirty = true; this.syncVideo(false); });
    this.engine.on('loop', () => this.syncVideo(true));
    this.counterLoop();
    this.welcome();
    this.initMIDI();
    setInterval(() => this.autosave(), 90000);
    window.addEventListener('beforeunload', (e) => { if (this.store.dirty) { e.preventDefault(); e.returnValue = ''; } });
    if (window.mmxNative?.onOpenFile) window.mmxNative.onOpenFile((f) => this.openSessionBlob(new Blob([f.data]), f.name));
    if (window.mmxNative?.onMenu) window.mmxNative.onMenu((cmd) => this.runMenuCommand(cmd));
  }
  saveSettings() { localStorage.setItem('mmx-settings', JSON.stringify(this.settings)); }
  setStatus(m) { $('#status').textContent = m; }
  prompt(t, l, v) { return promptBox(t, l, v); }

  onChange(e) {
    if (e?.label) this.setStatus(e.label);
    const p = this.store.project;
    $('#sessionName').textContent = p.name + (this.store.dirty ? ' •' : '');
    this.refreshTransport();
    // reconstruir el grafo si cambia la estructura
    const sig = JSON.stringify(p.tracks.map(t => [t.id, t.type, t.inactive, t.output, t.inserts.map(i => i.id + i.type + (i.bypass ? 1 : 0)), (t.sends || []).map(s => s.bus + (s.pre ? 1 : 0)), t.spatial?.enabled, t.instrument?.type])) + JSON.stringify(p.master.inserts.map(i => i.id + i.type + (i.bypass ? 1 : 0)));
    if (sig !== this._graphSig || e?.structural) { this._graphSig = sig; this.engine.rebuild(); }
    else this.engine.updateMix();
    if (this.engine.playing && /Mover|Recortar|Dividir|Fundido|Grabar|Borrar|Pegar|Duplicar|AudioSuite|Ganancia/.test(e?.label || '')) this.engine.play(this.engine.getPosition(), true);
    this.renderAssets();
    if (this.view === 'midi') this.roll.refreshBar();
  }

  // ---------- Menús ----------
  buildMenus() {
    const M = (label, items) => ({ label, items });
    const I = (label, key, action) => ({ label, key, action });
    this.menus = [
      M('Archivo', [I('Nueva sesión…', 'Ctrl+N', () => this.newSessionDialog()), I('Abrir sesión…', 'Ctrl+O', () => this.openSessionDialog()), I('Guardar', 'Ctrl+S', () => this.saveSessionFile()), I('Guardar como…', 'Ctrl+Shift+S', () => this.saveSessionFile(true)), '-',
        I('Importar audio…', 'Ctrl+Shift+I', () => this.pickFiles('audio/*,.wav,.mp3,.flac,.ogg,.m4a,.aac,.aif,.aiff,.opus,.webm', (f) => this.importFiles(f))), I('Importar MIDI…', '', () => this.pickFiles('.mid,.midi', (f) => this.importFiles(f))), I('Importar video…', '', () => this.pickFiles('video/*', (f) => this.importVideo(f[0]))), '-',
        I('Exportar / Bounce de mezcla…', 'Ctrl+Alt+B', () => this.bounceDialog()), I('Exportar stems…', '', () => this.bounceDialog('stems')), I('Fábrica de bounces (lote)…', '', () => this.bounceFactory()), I('Exportar MIDI de la sesión…', '', () => this.exportAllMidi()), '-',
        I('Preferencias…', 'Ctrl+,', () => this.settingsDialog()), ...(window.mmxNative ? [I('Salir', 'Ctrl+Q', () => window.close())] : [])]),
      M('Edición', [I('Deshacer', 'Ctrl+Z', () => this.store.undo()), I('Rehacer', 'Ctrl+Shift+Z', () => this.store.redo()), '-',
        I('Cortar', 'Ctrl+X', () => this.cut()), I('Copiar', 'Ctrl+C', () => this.copy()), I('Pegar', 'Ctrl+V', () => this.paste()), I('Borrar', 'Supr', () => this.deleteSel()), I('Duplicar', 'Ctrl+D', () => this.duplicate()), '-',
        I('Seleccionar todo', 'Ctrl+A', () => this.selectAll()), I('Dividir (separar clip)', 'Ctrl+E / B', () => this.edit.splitAtCursor()), I('Recortar al rango seleccionado', 'Ctrl+T', () => this.trimToSel()), I('Consolidar clip', 'Alt+Shift+3', () => this.consolidate()), I('Quitar silencios (Strip Silence)…', 'Ctrl+U', () => this.stripSilence()), '-',
        I('Fundidos desde la selección', 'Ctrl+F', () => this.fadesFromSel()), I('Ganancia de clip +1 dB', 'Ctrl+Shift+↑', () => this.clipGain(1)), I('Ganancia de clip −1 dB', 'Ctrl+Shift+↓', () => this.clipGain(-1)), I('Silenciar/activar clip', 'Ctrl+M', () => this.muteClips()), I('Cuantizar inicio de clips a la rejilla', '', () => this.quantizeClips()), I('Varispeed/Elastic (velocidad del clip)…', '', () => this.clipRate())]),
      M('Vista', [I('Ventana de Edición', 'Ctrl+=', () => this.setView('edit')), I('Ventana de Mezcla', 'Ctrl+=', () => this.setView('mix')), I('Editor MIDI', 'Ctrl+Alt+=', () => this.setView('midi')), '-', I('Acercar', 'T', () => this.edit.zoomIn()), I('Alejar', 'R', () => this.edit.zoomOut()), I('Ajustar sesión a la ventana', 'Alt+A', () => this.edit.zoomFit()), I('Seguir el cabezal (on/off)', 'F', () => { this.edit.follow = !this.edit.follow; this.settings.followPlayhead = this.edit.follow; this.saveSettings(); toast('Seguir cabezal: ' + (this.edit.follow ? 'sí' : 'no')); }), '-', I('Tema claro/oscuro', '', () => { this.settings.theme = this.settings.theme === 'light' ? 'dark' : 'light'; document.body.classList.toggle('light'); this.saveSettings(); this.edit.dirty = true; })]),
      M('Pista', [I('Nuevas pistas…', 'Ctrl+Shift+N', () => this.newTrackDialog()), I('Duplicar pista', '', () => this.duplicateTrack()), I('Eliminar pista', '', () => this.deleteTrack()), I('Renombrar…', '', () => this.renameTrack()), I('Color…', '', () => this.colorTrack()), '-',
        I('Congelar / Commit (render a audio)', '', () => this.commitTrack()), I('Activar/Desactivar pista', '', () => this.toggleTrack(this.store.selectedTrack, 'inactive')), I('Ocultar pista', '', () => this.toggleTrack(this.store.selectedTrack, 'hidden')), I('Mostrar todas las pistas', '', () => this.store.edit('Mostrar pistas', p => p.tracks.forEach(t => t.hidden = false))), I('Fijar arriba (Track Pin)', '', () => this.toggleTrack(this.store.selectedTrack, 'pinned')), '-',
        I('Panoramizador 3D / binaural', '', () => this.toggleSpatial()), I('Instrumento de la pista…', '', () => this.instrumentDialog(this.store.selectedTrack)), I('Limpiar automatización', '', () => this.clearAutomation())]),
      M('Clip', [I('Renombrar clip…', '', () => this.renameClip()), I('Color de clip…', '', () => this.colorClip()), I('Abrir en Editor MIDI', '', () => { const id = [...this.store.selectedClips][0]; if (id) this.openPianoRoll(id); }), I('Ubicar (Spot)…', '', () => { const id = [...this.store.selectedClips][0]; if (id) this.spotClip(id); }), I('Clip a nueva lista (toma)', '', () => this.playlistAction(this.store.selectedTrack, 'dup'))]),
      M('Evento', [I('Tempo, compás y tonalidad…', '', () => this.tempoDialog()), I('Marcadores (ubicaciones de memoria)', 'Ctrl+5', () => this.markersWindow()), I('Nuevo marcador en el cabezal', 'Enter (num)', () => this.addMarker(this.engine.getPosition())), '-', I('Región de bucle = selección', 'Ctrl+Shift+L', () => this.loopFromSel()), I('Punch in/out = selección', '', () => this.punchFromSel()), I('Activar/desactivar punch', '', () => { this.store.edit('Punch', p => p.punch.enabled = !p.punch.enabled); toast('Punch ' + (this.store.project.punch.enabled ? 'activado' : 'desactivado')); }), '-', I('Configuración MIDI y audio…', '', () => this.settingsDialog())]),
      M('AudioSuite', [{ head: 'Procesamiento fuera de línea del clip/selección' }, I('Normalizar…', '', () => this.audioSuite('normalize')), I('Ganancia…', '', () => this.audioSuite('gain')), I('Invertir (reversa)', '', () => this.audioSuite('reverse')), I('Invertir polaridad', '', () => this.audioSuite('invert')), I('Eliminar DC', '', () => this.audioSuite('dc')), I('Silencio', '', () => this.audioSuite('silence')), '-',
        I('Compresión/Expansión de tiempo…', '', () => this.audioSuite('stretch')), I('Cambio de tono…', '', () => this.audioSuite('pitch')), '-', I('Reducción de ruido (IA)…', '', () => this.audioSuite('denoise')), I('Afinación automática (IA)…', '', () => this.audioSuite('autotune')), '-', I('Renderizar inserciones de la pista en el clip', '', () => this.audioSuite('render'))]),
      M('IA', [I('Asistente de sesión (lenguaje natural)', 'Ctrl+K', () => this.toggleAI(true)), '-', I('Separar stems (voz, batería, bajo, otros)', '', () => this.aiStems()), I('Transcribir voz a texto (Whisper)', '', () => this.aiTranscribe()), I('Audio a MIDI', '', () => this.aiAudioToMidi()), I('Afinación automática', '', () => this.audioSuite('autotune')), I('Limpieza de ruido de voz', '', () => this.audioSuite('denoise')), I('Detectar tempo y tonalidad', '', () => this.aiDetect()), I('Cuantizar audio por ataques', '', () => this.aiBeatQuantize()), I('Quitar silencios inteligente', '', () => this.stripSilence()), '-',
        I('Mezcla automática', '', () => this.aiAutoMix()), I('Masterización asistida', '', () => this.aiMaster()), I('Elegir las mejores tomas (auto-comping)', '', () => this.aiBestTakes()), I('Análisis de sonoridad (LUFS / pico verdadero)', '', () => this.aiLoudness()), '-', I('Compositor IA (batería, acordes, bajo, melodía)…', '', () => this.aiCompose()), '-', I('Configuración de IA…', '', () => this.aiSettings())]),
      M('Ventana', [I('Navegador de clips', '', () => this.togglePanel('#leftPanel')), I('Asistente IA', '', () => this.toggleAI()), I('Video', '', () => this.videoWindow()), I('Marcadores', '', () => this.markersWindow()), I('Contador grande', '', () => this.bigCounter()), I('Analizador de espectro', '', () => this.spectrumWindow()), I('Historial de deshacer', '', () => this.historyWindow())]),
      M('Ayuda', [I('Manual del usuario', 'F1', () => this.openManual()), I('Atajos de teclado', '', () => this.shortcutsHelp()), I('Acerca de Músicos MX', '', () => this.about())])
    ];
    const bar = $('#menus');
    for (const m of this.menus) {
      const el = h('div', { class: 'menu' }, h('div', { class: 'mlabel' }, m.label));
      const drop = h('div', { class: 'mdrop' });
      for (const it of m.items) {
        if (it === '-') drop.append(h('div', { class: 'msep' }));
        else if (it.head) drop.append(h('div', { class: 'mhead' }, it.head));
        else drop.append(h('div', { class: 'mitem', onclick: () => { closeAll(); it.action(); } }, h('span', {}, it.label), h('span', { class: 'k' }, it.key || '')));
      }
      el.append(drop);
      el.firstChild.addEventListener('pointerdown', (e) => { e.stopPropagation(); const open = el.classList.contains('open'); closeAll(); if (!open) el.classList.add('open'); });
      el.addEventListener('pointerenter', () => { if ($('.menu.open') && !el.classList.contains('open')) { closeAll(); el.classList.add('open'); } });
      bar.append(el);
    }
    const closeAll = () => $$('.menu.open').forEach(x => x.classList.remove('open'));
    document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.menu')) closeAll(); });
  }
  runMenuCommand(cmd) {
    for (const m of this.menus) for (const it of m.items) if (it.label === cmd) return it.action();
  }

  // ---------- Barra de herramientas y transporte ----------
  bindToolbar() {
    $$('#editModes button').forEach(b => b.onclick = () => this.setMode(b.dataset.m));
    $$('#tools button').forEach(b => b.onclick = () => this.setTool(b.dataset.t));
    $('#gridSel').onchange = (e) => { this.edit.gridDiv = +e.target.value; this.edit.dirty = true; };
    $('#btnPlay').onclick = () => this.engine.togglePlay();
    $('#btnStop').onclick = () => { if (this.engine.playing) this.engine.stop(); else this.engine.setPosition(0); };
    $('#btnRtz').onclick = () => this.engine.setPosition(0);
    $('#btnEnd').onclick = () => this.engine.setPosition(this.store.sessionLength());
    $('#btnRew').onclick = () => this.engine.setPosition(Math.max(0, this.engine.getPosition() - 60 / this.store.project.tempo * this.store.project.timeSig[0]));
    $('#btnFf').onclick = () => this.engine.setPosition(this.engine.getPosition() + 60 / this.store.project.tempo * this.store.project.timeSig[0]);
    $('#btnRec').onclick = () => this.toggleRecord();
    $('#btnLoop').onclick = () => this.toggleLoop();
    $('#btnClick').onclick = () => { this.engine.metronome = !this.engine.metronome; this.refreshTransport(); };
    $('#ctrMain').onclick = () => { const order = ['bars', 'min', 'tc', 'samples']; this.settings.counter = order[(order.indexOf(this.settings.counter) + 1) % 4]; this.saveSettings(); };
    $('#tempoIn').onchange = (e) => { const v = clamp(+e.target.value || 120, 20, 300); this.store.edit('Tempo', p => { p.tempo = v; }); };
    $('#sigIn').onchange = (e) => { const m = e.target.value.match(/(\d+)\s*\/\s*(\d+)/); if (m) this.store.edit('Compás', p => { p.timeSig = [clamp(+m[1], 1, 32), +m[2]]; }); };
    const ks = $('#keyIn'); for (const k of KEYS) for (const s of ['mayor', 'menor']) ks.append(h('option', { value: k + '|' + s }, k + (s === 'menor' ? 'm' : '')));
    ks.onchange = () => { const [k, s] = ks.value.split('|'); this.store.edit('Tonalidad', p => { p.key = k; p.scale = s; }); };
    $('#countIn').onchange = (e) => { this.engine.countIn = +e.target.value; };
    $('#zIn').onclick = () => this.edit.zoomIn(); $('#zOut').onclick = () => this.edit.zoomOut(); $('#zFit').onclick = () => this.edit.zoomFit();
    $$('#tabs .tab').forEach(t => t.onclick = () => this.setView(t.dataset.v));
    $('#addTrackBtn').onclick = () => this.newTrackDialog();
    $('#importBtn').onclick = () => this.pickFiles('audio/*,.mid,.midi,.wav,.mp3,.flac,.ogg,.m4a,.aif,.aiff', (f) => this.importFiles(f, null, null, true));
    $('#tglLeft').onclick = () => this.togglePanel('#leftPanel');
    $('#tglAI').onclick = () => this.toggleAI();
    $('#aiClose').onclick = () => this.toggleAI(false);
    $('#tglVideo').onclick = () => this.videoWindow();
  }
  setMode(m) { this.edit.mode = m; $$('#editModes button').forEach(b => b.classList.toggle('on', b.dataset.m === m)); this.setStatus('Modo ' + m); }
  setTool(t) { this.edit.tool = t; $$('#tools button').forEach(b => b.classList.toggle('on', b.dataset.t === t)); }
  setView(v) {
    this.view = v;
    $$('#tabs .tab').forEach(t => t.classList.toggle('on', t.dataset.v === v));
    $('#editView').classList.toggle('on', v === 'edit'); $('#mixView').classList.toggle('on', v === 'mix'); $('#midiView').classList.toggle('on', v === 'midi');
    if (v === 'mix') this.mix.show();
    if (v === 'edit') { this.edit.resize(); this.edit.buildHeaders(); }
    if (v === 'midi') { this.roll.refreshBar(); requestAnimationFrame(() => this.roll.draw()); }
  }
  togglePanel(sel) { $(sel).classList.toggle('open'); setTimeout(() => { this.edit.resize(); }, 200); }
  toggleAI(force) { const p = $('#aiPanel'); p.classList.toggle('open', force); if (p.classList.contains('open')) { this.renderAIPanel(); setTimeout(() => $('#aiInput').focus(), 200); } setTimeout(() => this.edit.resize(), 200); }
  refreshTransport() {
    const p = this.store.project, e = this.engine;
    $('#btnPlay').classList.toggle('on', e.playing); $('#btnRec').classList.toggle('on', e.recording);
    $('#btnLoop').classList.toggle('on', p.loop.enabled); $('#btnClick').classList.toggle('on', e.metronome);
    if (document.activeElement !== $('#tempoIn')) $('#tempoIn').value = p.tempo;
    if (document.activeElement !== $('#sigIn')) $('#sigIn').value = p.timeSig.join('/');
    $('#keyIn').value = p.key + '|' + (/menor/.test(p.scale) ? 'menor' : 'mayor');
    $('#srInfo').textContent = `${(e.sampleRate / 1000).toFixed(1)} kHz · ${p.bitDepth} bits`;
    $('#cpu').textContent = e.ctx ? `Latencia ${Math.round(((e.ctx.baseLatency || 0) + (e.ctx.outputLatency || 0)) * 1000)} ms` : '';
  }
  counterLoop() {
    const tick = () => {
      const p = this.store.project, t = this.engine.getPosition();
      const fm = { bars: () => fmtBars(t, p.tempo, p.timeSig), min: () => fmtMinSec(t), tc: () => fmtTimecode(t), samples: () => fmtSamples(t, this.engine.sampleRate) };
      $('#ctrMain').textContent = fm[this.settings.counter]();
      $('#ctrSub').textContent = this.settings.counter === 'min' ? fmtBars(t, p.tempo, p.timeSig) : fmtMinSec(t);
      if (this.engine.playing && this.engine.graph) { const l = this.engine.momentaryLUFS(); this.lufsM = this.lufsM === undefined ? l : this.lufsM * 0.85 + l * 0.15; $('#lufs').textContent = 'LUFS-M ' + this.lufsM.toFixed(1); }
      if (this._big) this._big.textContent = $('#ctrMain').textContent;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
  toggleLoop() {
    const sel = this.edit.selectedRange();
    this.store.edit('Bucle', p => { if (!p.loop.enabled && sel) { p.loop.start = sel.start; p.loop.end = sel.end; } p.loop.enabled = !p.loop.enabled; if (p.loop.end <= p.loop.start) p.loop.end = p.loop.start + 60 / p.tempo * p.timeSig[0] * 4; });
    if (this.engine.playing) this.engine.play(this.engine.getPosition(), true);
  }
  loopFromSel() { const s = this.edit.selectedRange(); if (!s) return toast('Primero selecciona un rango con la herramienta Selector.'); this.store.edit('Bucle desde selección', p => { p.loop = { enabled: true, start: s.start, end: s.end }; }); }
  punchFromSel() { const s = this.edit.selectedRange(); if (!s) return toast('Primero selecciona un rango.'); this.store.edit('Punch desde selección', p => { p.punch = { enabled: true, start: s.start, end: s.end }; }); toast('Punch in/out definido: graba solo dentro del rango.'); }
  async toggleRecord() {
    if (this.engine.recording) { this.engine.stop(); return; }
    if (this.engine.playing) this.engine.stop();
    await this.engine.record();
  }
  toggleTrack(id, key, exclusive) {
    if (!id) return toast('Selecciona una pista primero.');
    this.store.edit(key === 'mute' ? 'Silenciar' : key === 'solo' ? 'Solo' : key === 'recArm' ? 'Armar grabación' : 'Pista', p => {
      const t = p.tracks.find(x => x.id === id); if (!t) return;
      if (key === 'solo' && exclusive) { const v = !t.solo; p.tracks.forEach(x => x.solo = false); t.solo = v; }
      else t[key] = !t[key];
    });
    if (key === 'recArm' || key === 'monitor') {
      const t = this.store.track(id);
      if (t && t.type === 'audio' && (t.recArm || t.monitor)) this.engine.init().then(() => this.engine.armInput()).then(() => this.engine.setMonitoring()).catch(e => toast('Sin acceso al micrófono: ' + e.message, true));
      else this.engine.setMonitoring();
    }
    if (key === 'inactive') this.engine.rebuild();
    this.mix.stale = true; if (this.view === 'mix') this.mix.build();
  }

  // ---------- Atajos de teclado ----------
  bindKeys() {
    addEventListener('keydown', (e) => {
      if (e.target.closest('input,textarea,select') && !(e.key === 'Escape')) return;
      if ($('#modalBack').classList.contains('on')) return;
      const k = e.key, c = e.ctrlKey || e.metaKey, s = e.shiftKey, a = e.altKey;
      const run = (f) => { e.preventDefault(); f(); };
      if (k === ' ' && c) return run(() => this.toggleRecord());
      if (k === ' ') return run(() => this.engine.togglePlay());
      if (k === 'F12' || (k === '3' && e.code === 'Numpad3')) return run(() => this.toggleRecord());
      if (k === 'Enter' && e.code === 'NumpadEnter') return run(() => this.addMarker(this.engine.getPosition()));
      if (k === 'Enter' || k === 'Home') return run(() => this.engine.setPosition(0));
      if (k === 'End') return run(() => this.engine.setPosition(this.store.sessionLength()));
      if (c && k.toLowerCase() === 'z') return run(() => s ? this.store.redo() : this.store.undo());
      if (c && k.toLowerCase() === 'y') return run(() => this.store.redo());
      if (c && k.toLowerCase() === 's') return run(() => this.saveSessionFile(s));
      if (c && k.toLowerCase() === 'o') return run(() => this.openSessionDialog());
      if (c && s && k.toLowerCase() === 'n') return run(() => this.newTrackDialog());
      if (c && k.toLowerCase() === 'n') return run(() => this.newSessionDialog());
      if (c && s && k.toLowerCase() === 'i') return run(() => this.pickFiles('audio/*', f => this.importFiles(f)));
      if (c && s && k.toLowerCase() === 'l') return run(() => this.toggleLoop());
      if (c && a && k.toLowerCase() === 'b') return run(() => this.bounceDialog());
      if (c && k.toLowerCase() === 'e') return run(() => this.edit.splitAtCursor());
      if (c && k.toLowerCase() === 'd') return run(() => this.duplicate());
      if (c && k.toLowerCase() === 'x') return run(() => this.cut());
      if (c && k.toLowerCase() === 'c') return run(() => this.copy());
      if (c && k.toLowerCase() === 'v') return run(() => this.paste());
      if (c && k.toLowerCase() === 'a') return run(() => this.selectAll());
      if (c && k.toLowerCase() === 't') return run(() => this.trimToSel());
      if (c && k.toLowerCase() === 'f') return run(() => this.fadesFromSel());
      if (c && k.toLowerCase() === 'm') return run(() => this.muteClips());
      if (c && k.toLowerCase() === 'u') return run(() => this.stripSilence());
      if (c && k.toLowerCase() === 'k') return run(() => this.toggleAI(true));
      if (c && k === ',') return run(() => this.settingsDialog());
      if (c && k === '5') return run(() => this.markersWindow());
      if (c && k === '=') return run(() => this.setView(a ? 'midi' : this.view === 'mix' ? 'edit' : 'mix'));
      if (c && s && k === 'ArrowUp') return run(() => this.clipGain(1));
      if (c && s && k === 'ArrowDown') return run(() => this.clipGain(-1));
      if (k === 'Delete' || k === 'Backspace') return run(() => this.deleteSel());
      if (k === 'Escape') { this.store.selectedClips.clear(); this.edit.sel = { start: 0, end: 0, tracks: new Set() }; this.edit.dirty = true; return; }
      if (/^F([1-9]|10)$/.test(k)) {
        const n = +k.slice(1);
        if (n === 1 && !c && this.view === 'edit' && s) return run(() => this.openManual());
        if (n <= 4) return run(() => this.setMode(['shuffle', 'slip', 'spot', 'grid'][n - 1]));
        return run(() => this.setTool(['zoom', 'trim', 'select', 'grab', 'scrub', 'pencil'][n - 5]));
      }
      if (a && !c && k.toLowerCase() === 'a') return run(() => this.edit.zoomFit());
      if (c || a) return;
      if (this.view === 'midi') return;
      const lk = k.toLowerCase();
      if (lk === 't') return run(() => this.edit.zoomIn());
      if (lk === 'r') return run(() => this.edit.zoomOut());
      if (lk === 'b') return run(() => this.edit.splitAtCursor());
      if (lk === 'f') return run(() => { this.edit.follow = !this.edit.follow; toast('Seguir cabezal: ' + (this.edit.follow ? 'sí' : 'no')); });
      if (lk === 'l') return run(() => this.toggleLoop());
      if (lk === 'c' || e.code === 'Numpad7') return run(() => { this.engine.metronome = !this.engine.metronome; this.refreshTransport(); });
      if (k === '+' || k === '=') return run(() => this.nudge(1));
      if (k === '-') return run(() => this.nudge(-1));
      if (k === 'ArrowLeft') return run(() => this.engine.setPosition(Math.max(0, this.edit.snap(this.engine.getPosition() - 60 / this.store.project.tempo, true))));
      if (k === 'ArrowRight') return run(() => this.engine.setPosition(this.edit.snap(this.engine.getPosition() + 60 / this.store.project.tempo, true)));
      if (k === 'ArrowUp' || k === 'ArrowDown') return run(() => this.selectTrackRel(k === 'ArrowUp' ? -1 : 1));
    });
  }
  selectTrackRel(d) {
    const ts = this.edit.displayTracks(); if (!ts.length) return;
    let i = ts.findIndex(t => t.id === this.store.selectedTrack); i = clamp(i + d, 0, ts.length - 1);
    this.store.selectedTrack = ts[i].id; this.edit.buildHeaders();
  }

  // ---------- Paneles ----------
  bindPanels() {
    $('#aiSend').onclick = () => this.sendAI();
    $('#aiInput').addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') this.sendAI(); });
    $('#fileIn').addEventListener('change', (e) => { const f = [...e.target.files]; e.target.value = ''; this._fileCb?.(f); });
  }
  pickFiles(accept, cb) { const i = $('#fileIn'); i.accept = accept || ''; this._fileCb = cb; i.click(); }
  renderAssets() {
    const list = $('#assetList'); if (!$('#leftPanel').classList.contains('open')) { this._assetsStale = true; return; }
    list.innerHTML = '';
    const used = new Map();
    for (const t of this.store.project.tracks) for (const pl of t.playlists) for (const c of pl.clips) if (c.assetId) used.set(c.assetId, (used.get(c.assetId) || 0) + 1);
    const assets = [...this.store.assets.values()].filter(a => !a.video);
    if (!assets.length) list.append(h('p', { style: { color: 'var(--dim)' } }, 'Aún no hay audio. Importa archivos o graba. Arrastra un clip de esta lista a una pista para colocarlo.'));
    for (const a of assets.reverse()) {
      const cv = h('canvas', { width: 220, height: 26 });
      const el = h('div', { class: 'asset', draggable: 'true', title: 'Arrastra a la línea de tiempo · doble clic: escuchar' },
        h('div', { class: 'an' }, a.name), h('div', { class: 'ai' }, `${fmtMinSec(a.buffer.duration)} · ${a.buffer.numberOfChannels === 2 ? 'estéreo' : 'mono'} · ${(a.buffer.sampleRate / 1000).toFixed(1)} kHz · usado ${used.get(a.id) || 0}×`), cv);
      el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/mmx-asset', a.id); });
      el.addEventListener('dblclick', () => this.engine.preview(a.buffer));
      el.addEventListener('contextmenu', (e) => { e.preventDefault(); contextMenu(e.clientX, e.clientY, [{ label: 'Escuchar', action: () => this.engine.preview(a.buffer) }, { label: 'Detener escucha', action: () => this.engine.stopPreview() }, { label: 'Colocar en pista seleccionada (cabezal)', action: () => this.placeAsset(a.id, this.store.selectedTrack, this.engine.getPosition()) }, { label: 'Renombrar…', action: async () => { const n = await promptBox('Renombrar', 'Nombre del clip:', a.name); if (n) { a.name = n; this.renderAssets(); } } }]); });
      const c = cv.getContext('2d'); c.fillStyle = '#4fa3ff';
      const pk = a.peaks; const step = pk.mins.length / 220;
      for (let x = 0; x < 220; x++) { let mn = 0, mx = 0; for (let i = Math.floor(x * step); i < Math.floor((x + 1) * step); i++) { mn = Math.min(mn, pk.mins[i]); mx = Math.max(mx, pk.maxs[i]); } c.fillRect(x, 13 - mx * 13, 1, Math.max(1, (mx - mn) * 13)); }
      list.append(el);
    }
  }

  // ---------- Sesiones ----------
  welcome() {
    const w = $('#welcome'); w.style.display = 'grid';
    w.innerHTML = '';
    const card = h('div', { class: 'card' },
      h('img', { src: 'img/logo.png', alt: 'Músicos MX' }), h('h1', {}, 'Músicos MX'),
      h('p', {}, `Estación de trabajo de audio digital libre · v${VERSION} · GPL-3.0-o-posterior`),
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary', onclick: () => this.newSessionDialog() }, '＋ Nueva sesión'),
        h('button', { class: 'btn', onclick: () => this.openSessionDialog() }, '📂 Abrir sesión…'),
        h('button', { class: 'btn', id: 'recoverBtn', style: { display: 'none' }, onclick: () => this.recoverAutosave() }, '♻ Recuperar autoguardado'),
        h('button', { class: 'btn', onclick: () => this.openManual() }, '📖 Manual')),
      h('div', { style: { color: 'var(--dim)', marginBottom: '6px', textAlign: 'left' } }, 'Plantillas'),
      h('div', { class: 'templates' }, ...TEMPLATES.map(tp => h('div', { class: 'tpl', onclick: () => this.fromTemplate(tp) }, h('b', {}, tp.name), h('small', {}, tp.desc)))));
    w.append(card);
    idbGet('autosave').then(v => { if (v) { const b = $('#recoverBtn'); if (b) { b.style.display = ''; b.textContent = '♻ Recuperar autoguardado (' + new Date(v.time).toLocaleString() + ')'; } } }).catch(() => { });
  }
  hideWelcome() { $('#welcome').style.display = 'none'; this.edit.resize(); this.edit.buildHeaders(); }
  async newSessionDialog() {
    if (this.store.dirty && !(await confirmBox('Nueva sesión', 'Hay cambios sin guardar. ¿Descartarlos?', 'Descartar'))) return;
    const r = await formBox('Nueva sesión', [
      { key: 'name', label: 'Nombre', value: 'Mi canción' },
      { key: 'sampleRate', label: 'Frecuencia de muestreo', type: 'select', options: [[44100, '44.1 kHz'], [48000, '48 kHz'], [88200, '88.2 kHz'], [96000, '96 kHz']], value: 48000 },
      { key: 'bitDepth', label: 'Profundidad de bits (export)', type: 'select', options: [[16, '16 bits'], [24, '24 bits'], [32, '32 bits flotante']], value: 24 },
      { key: 'tempo', label: 'Tempo (BPM)', type: 'number', value: 120, min: 20, max: 300 },
      { key: 'sig', label: 'Compás', value: '4/4' }
    ], 'Crear');
    if (!r) return;
    await this.createSession(r.name, +r.sampleRate, +r.bitDepth, r.tempo, r.sig);
  }
  async createSession(name, sr = 48000, bd = 24, tempo = 120, sig = '4/4') {
    const p = newProject(name); p.sampleRate = sr; p.bitDepth = bd; p.tempo = tempo || 120;
    const m = String(sig).match(/(\d+)\/(\d+)/); if (m) p.timeSig = [+m[1], +m[2]];
    if (this.engine.playing) this.engine.stop();
    if (this.engine.ctx && this.engine.ctx.sampleRate !== sr) { try { await this.engine.ctx.close(); } catch (e) { } this.engine.ctx = null; this.engine.graph = null; this.engine.inputStream = null; this.engine.inputNode = null; }
    this.store.load(p, new Map()); this.fileName = null;
    await this.engine.init();
    this.hideWelcome(); this.setView('edit');
    this.edit.setZoom(60); this.edit.scroll.scrollLeft = 0;
    return p;
  }
  async fromTemplate(tp) {
    await this.createSession(tp.name, 48000, 24, tp.tempo || 120);
    this.store.edit('Plantilla', p => tp.build(p));
    this.store.undoStack = []; this.store.dirty = false;
    this.engine.rebuild(); this.edit.buildHeaders();
  }
  async openSessionDialog() { this.pickFiles('.mmxs,.zip', (f) => f[0] && this.openSessionBlob(f[0], f[0].name)); }
  async openSessionBlob(blob, name) {
    const pr = progressBox('Abriendo sesión', name || '');
    try {
      await this.engine.init();
      const { project, assets } = await loadSession(this.engine.ctx, blob, computePeaks);
      if (this.engine.playing) this.engine.stop();
      this.store.load(project, assets); this.fileName = name;
      if (project.sampleRate !== this.engine.ctx.sampleRate) toast(`La sesión es de ${project.sampleRate} Hz; el audio se reproduce a ${this.engine.ctx.sampleRate} Hz.`);
      this.hideWelcome(); this.setView('edit'); this.edit.zoomFit();
    } catch (e) { console.error(e); toast('No se pudo abrir la sesión: ' + e.message, true); }
    pr.close();
  }
  async saveSessionFile(as = false) {
    if (!this.store.project.tracks.length && !this.store.assets.size) return toast('La sesión está vacía.');
    const pr = progressBox('Guardando sesión…');
    try {
      const blob = await saveSession(this.store);
      const name = (as || !this.fileName) ? (this.store.project.name || 'sesion').replace(/[^\wáéíóúñÁÉÍÓÚÑ \-]/g, '') + '.mmxs' : this.fileName;
      const path = await this.saveBlob(blob, name, as || !this.savedPath, [{ name: 'Sesión Músicos MX', extensions: ['mmxs'] }]);
      if (path !== null) { this.fileName = name; this.store.dirty = false; this.onChange({ label: 'Sesión guardada' }); toast('Sesión guardada' + (typeof path === 'string' ? ': ' + path : '')); }
      idbSet('autosave', { time: Date.now(), blob }).catch(() => { });
    } catch (e) { console.error(e); toast('Error al guardar: ' + e.message, true); }
    pr.close();
  }
  // Guarda un archivo usando el puente nativo (escritorio/Android) o descarga del navegador
  async saveBlob(blob, name, ask = true, filters) {
    if (window.mmxNative?.saveFile) {
      const ab = await blob.arrayBuffer();
      const path = await window.mmxNative.saveFile(name, ab, filters, ask ? null : this.savedPath);
      if (path && /\.mmxs$/i.test(path)) this.savedPath = path;
      return path || null;
    }
    if (window.MMXAndroid?.saveFile) {
      const b64 = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result.split(',')[1]); fr.readAsDataURL(blob); });
      return window.MMXAndroid.saveFile(name, b64) || name;
    }
    downloadBlob(blob, name); return name;
  }
  async autosave() {
    if (!this.settings.autosave || !this.store.dirty || this.engine.recording) return;
    try { const blob = await saveSession(this.store); await idbSet('autosave', { time: Date.now(), blob, name: this.store.project.name }); this.setStatus('Autoguardado ' + new Date().toLocaleTimeString()); } catch (e) { console.warn(e); }
  }
  async recoverAutosave() { const v = await idbGet('autosave'); if (v) this.openSessionBlob(v.blob, (v.name || 'recuperada') + '.mmxs'); }

  // ---------- Pistas ----------
  async newTrackDialog() {
    if ($('#welcome').style.display !== 'none') await this.createSession('Sesión rápida');
    const r = await formBox('Nuevas pistas', [
      { key: 'count', label: 'Cantidad', type: 'number', value: 1, min: 1, max: 64 },
      { key: 'type', label: 'Tipo', type: 'select', options: [['audio', 'Pista de audio'], ['instrument', 'Pista de instrumento'], ['midi', 'Pista MIDI'], ['aux', 'Entrada auxiliar (bus)'], ['video', 'Pista de video']], value: 'audio' },
      { key: 'fmt', label: 'Formato (audio)', type: 'select', options: [['mono', 'Mono'], ['stereo', 'Estéreo']], value: 'mono' },
      { key: 'name', label: 'Nombre (opcional)', value: '' },
      { key: 'inst', label: 'Instrumento', type: 'select', options: [...Object.keys(SYNTH_PRESETS).map(k => ['synth:' + k, '🎹 ' + k]), ...DRUM_KITS.map(k => ['drums:' + k, '🥁 Batería ' + k])], value: 'synth:Piano eléctrico' }
    ], 'Crear');
    if (!r) return;
    this.addTracks(r.type, r.count, r.name, r.inst, r.fmt);
  }
  addTracks(type, count = 1, name, inst, fmt) {
    if (type === 'video' && this.store.project.tracks.some(t => t.type === 'video')) { toast('Solo se admite una pista de video.'); return []; }
    const ids = [];
    this.store.edit('Nueva pista', p => {
      const idx = p.tracks.findIndex(t => t.id === this.store.selectedTrack);
      for (let i = 0; i < count; i++) {
        const t = newTrack(type, name ? (count > 1 ? `${name} ${i + 1}` : name) : undefined);
        if (fmt === 'stereo') { t.input = 0; t.stereo = true; }
        if (inst && t.instrument) { const [ty, pr] = inst.split(':'); t.instrument = { type: ty, preset: pr, params: {} }; if (!name) t.name = (ty === 'drums' ? 'Batería' : pr) + (count > 1 ? ' ' + (i + 1) : ''); }
        if (type === 'video') { t.name = 'Video'; t.height = 60; }
        if (idx >= 0) p.tracks.splice(idx + 1 + i, 0, t); else p.tracks.push(t);
        ids.push(t.id);
      }
    });
    this.store.selectedTrack = ids[ids.length - 1]; this.edit.buildHeaders();
    return ids;
  }
  async duplicateTrack() {
    const t = this.store.track(this.store.selectedTrack); if (!t) return toast('Selecciona una pista.');
    this.store.edit('Duplicar pista', p => { const c = JSON.parse(JSON.stringify(t)); c.id = uid('trk'); c.name = t.name + ' copia'; c.playlists.forEach(pl => { pl.id = uid('pl'); pl.clips.forEach(cl => cl.id = uid('clp')); }); c.inserts.forEach(i => i.id = uid('ins')); p.tracks.splice(p.tracks.indexOf(p.tracks.find(x => x.id === t.id)) + 1, 0, c); });
  }
  async deleteTrack(id = this.store.selectedTrack) {
    const t = this.store.track(id); if (!t) return toast('Selecciona una pista.');
    if (!(await confirmBox('Eliminar pista', `¿Eliminar la pista “${escapeHtml(t.name)}”? (se puede deshacer)`, 'Eliminar'))) return;
    this.store.edit('Eliminar pista', p => { p.tracks = p.tracks.filter(x => x.id !== id); p.tracks.forEach(x => { if (x.output === id) x.output = 'master'; x.sends = (x.sends || []).filter(s => s.bus !== id); }); });
  }
  async renameTrack(id = this.store.selectedTrack) { const t = this.store.track(id); if (!t) return; const n = await promptBox('Renombrar pista', 'Nombre:', t.name); if (n) this.store.edit('Renombrar pista', p => { p.tracks.find(x => x.id === id).name = n; }); }
  async colorTrack(id = this.store.selectedTrack) {
    const t = this.store.track(id); if (!t) return;
    const wrap = h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px' } });
    let chosen = null;
    const r = modal('Color de pista', wrap, [{ label: 'Cancelar', value: null }]);
    for (const c of TRACK_COLORS.concat(['#ff3d7f', '#ffb547', '#2ee6c5', '#9e9e9e'])) wrap.append(h('div', { style: { width: '36px', height: '36px', borderRadius: '8px', background: c, cursor: 'pointer' }, onclick: () => { chosen = c; $('#modalBack .modal')._close(c); } }));
    const v = await r; if (v) this.store.edit('Color', p => { p.tracks.find(x => x.id === id).color = v; });
  }
  playlistAction(trackId, v) {
    this.store.edit('Lista de reproducción', p => {
      const t = p.tracks.find(x => x.id === trackId); if (!t) return;
      if (v === 'new') { t.playlists.push({ id: uid('pl'), name: 'Toma ' + (t.playlists.length + 1), clips: [] }); t.activePlaylist = t.playlists.length - 1; }
      else if (v === 'dup') { const src = t.playlists[t.activePlaylist]; t.playlists.push({ id: uid('pl'), name: src.name + ' (copia)', clips: src.clips.map(c => ({ ...JSON.parse(JSON.stringify(c)), id: uid('clp') })) }); t.activePlaylist = t.playlists.length - 1; }
      else t.activePlaylist = +v;
    });
  }
  trackContextMenu(id, x, y) {
    this.store.selectedTrack = id; const t = this.store.track(id);
    contextMenu(x, y, [{ head: t.name },
      { label: 'Renombrar…', action: () => this.renameTrack(id) }, { label: 'Color…', action: () => this.colorTrack(id) }, { label: 'Duplicar', action: () => this.duplicateTrack() }, { label: 'Eliminar', action: () => this.deleteTrack(id) }, '-',
      { label: t.inactive ? 'Activar' : 'Desactivar', action: () => this.toggleTrack(id, 'inactive') }, { label: 'Ocultar', action: () => this.toggleTrack(id, 'hidden') }, { label: t.pinned ? 'Desfijar' : 'Fijar arriba', action: () => this.toggleTrack(id, 'pinned') }, { label: 'Congelar / Commit a audio', action: () => this.commitTrack(id) }, '-',
      { label: 'Nueva lista de reproducción vacía', action: () => this.playlistAction(id, 'new') }, { label: 'Duplicar lista de reproducción', action: () => this.playlistAction(id, 'dup') }, { label: '✨ Elegir mejores tomas (IA)', action: () => this.aiBestTakes(id) },
      ...(t.instrument ? [{ label: '🎹 Instrumento…', action: () => this.instrumentDialog(id) }, { label: '✨ Compositor IA en esta pista…', action: () => this.aiCompose(id) }] : []),
      { label: (t.spatial?.enabled ? 'Desactivar' : 'Activar') + ' panoramizador 3D', action: () => this.toggleSpatial(id) }, { label: 'Limpiar automatización', action: () => this.clearAutomation(id) }]);
  }
  async instrumentDialog(id) {
    const t = this.store.track(id); if (!t?.instrument) return toast('Selecciona una pista de instrumento.');
    const inst = t.instrument;
    const r = await formBox('Instrumento: ' + t.name, [
      { key: 'v', label: 'Instrumento', type: 'select', options: [...Object.keys(SYNTH_PRESETS).map(k => ['synth:' + k, '🎹 ' + k]), ...DRUM_KITS.map(k => ['drums:' + k, '🥁 Batería ' + k])], value: inst.type + ':' + inst.preset },
      { key: 'cutoff', label: 'Brillo (corte, Hz)', type: 'number', value: inst.params.cutoff ?? '', min: 100, max: 18000 },
      { key: 'a', label: 'Ataque (s)', type: 'number', value: inst.params.a ?? '', step: 0.001 },
      { key: 'r', label: 'Liberación (s)', type: 'number', value: inst.params.r ?? '', step: 0.01 },
      { key: 'detune', label: 'Desafinación (cents)', type: 'number', value: inst.params.detune ?? '' }
    ], 'Aplicar', 'Deja vacío un parámetro para usar el del preset. El sintetizador y la batería son motores integrados y libres.');
    if (!r) return;
    const [ty, pr] = r.v.split(':');
    const params = {}; for (const k of ['cutoff', 'a', 'r', 'detune']) if (!isNaN(r[k]) && r[k] !== '' && r[k] !== null) params[k] = r[k];
    this.store.edit('Instrumento', p => { p.tracks.find(x => x.id === id).instrument = { type: ty, preset: pr, params }; });
  }
  toggleSpatial(id = this.store.selectedTrack) {
    const t = this.store.track(id); if (!t) return toast('Selecciona una pista.');
    this.store.edit('Panoramizador 3D', p => { const tt = p.tracks.find(x => x.id === id); tt.spatial = tt.spatial || { x: 0, y: 0, z: -1 }; tt.spatial.enabled = !tt.spatial.enabled; });
    if (this.store.track(id).spatial.enabled) this.spatialPanner(id);
  }
  spatialPanner(id) {
    const t = this.store.track(id);
    const pad = h('canvas', { width: 260, height: 260, style: { background: '#0b0d12', borderRadius: '8px', cursor: 'crosshair', display: 'block' } });
    const ySl = h('input', { type: 'range', min: -5, max: 5, step: 0.1, value: t.spatial.y });
    const draw = () => { const s = this.store.track(id).spatial, c = pad.getContext('2d'); c.clearRect(0, 0, 260, 260); c.strokeStyle = '#2a3040'; for (let r = 30; r < 140; r += 30) { c.beginPath(); c.arc(130, 130, r, 0, 7); c.stroke(); } c.fillStyle = '#8b93a7'; c.fillText('Frente', 112, 12); c.fillText('🎧', 122, 135); c.fillStyle = t.color; c.beginPath(); c.arc(130 + s.x * 26, 130 + s.z * 26, 9, 0, 7); c.fill(); };
    const set = (e) => { const r = pad.getBoundingClientRect(); const x = clamp((e.clientX - r.left - 130) / 26, -5, 5), z = clamp((e.clientY - r.top - 130) / 26, -5, 5); this.store.live(p => { const s = p.tracks.find(q => q.id === id).spatial; s.x = x; s.z = z; }); this.engine.updateMix(); draw(); };
    pad.addEventListener('pointerdown', (e) => { set(e); const mv = (ev) => set(ev); const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); this.store.dirty = true; }; addEventListener('pointermove', mv); addEventListener('pointerup', up); });
    ySl.oninput = () => { this.store.live(p => { p.tracks.find(q => q.id === id).spatial.y = +ySl.value; }); this.engine.updateMix(); };
    floatWindow('spatial_' + id, '🎧 Panoramizador 3D binaural — ' + t.name, h('div', {}, pad, h('div', { class: 'param' }, h('span', {}, 'Altura'), ySl, h('span', {})), h('p', { style: { color: 'var(--dim)', fontSize: '12px', maxWidth: '260px' } }, 'Audio espacial con HRTF: escucha con audífonos. La posición es relativa al oyente (centro).')), { w: 290 });
    draw();
  }
  clearAutomation(id = this.store.selectedTrack) { if (!id) return; this.store.edit('Limpiar automatización', p => { const t = p.tracks.find(x => x.id === id); t.automation = { volume: [], pan: [] }; }); this.engine.rebuild(); }

  // ---------- Clips: edición ----------
  targets() {
    // clips seleccionados, o los que tocan la selección de tiempo
    const ids = new Set(this.store.selectedClips);
    const sel = this.edit.selectedRange();
    if (!ids.size && sel) for (const t of this.store.project.tracks) if (sel.tracks.includes(t.id)) for (const c of clipsOf(t)) if (c.start < sel.end && c.start + c.duration > sel.start) ids.add(c.id);
    if (!ids.size) { const t = this.store.track(this.store.selectedTrack); const pos = this.engine.getPosition(); if (t) for (const c of clipsOf(t)) if (pos >= c.start && pos < c.start + c.duration) ids.add(c.id); }
    return [...ids].map(id => this.store.findClip(id)).filter(Boolean);
  }
  copy() {
    const sel = this.edit.selectedRange();
    if (sel) {
      const tracks = this.store.project.tracks.filter(t => sel.tracks.includes(t.id));
      this.clipboard = { range: true, len: sel.end - sel.start, tracks: tracks.map(t => { const tmp = JSON.parse(JSON.stringify(clipsOf(t))); clearRange(tmp, 0, sel.start); clearRange(tmp, sel.end, 1e9); return { trackId: t.id, clips: tmp.map(c => ({ ...c, start: c.start - sel.start })) }; }) };
    } else {
      const tg = this.targets(); if (!tg.length) return toast('Nada seleccionado.');
      const minS = Math.min(...tg.map(x => x.clip.start));
      this.clipboard = { range: false, len: Math.max(...tg.map(x => x.clip.start + x.clip.duration)) - minS, tracks: Object.values(tg.reduce((acc, x) => { (acc[x.track.id] ||= { trackId: x.track.id, clips: [] }).clips.push({ ...JSON.parse(JSON.stringify(x.clip)), start: x.clip.start - minS }); return acc; }, {})) };
    }
    this.setStatus('Copiado al portapapeles');
  }
  cut() { this.copy(); this.deleteSel(); }
  paste() {
    const cb = this.clipboard; if (!cb) return toast('El portapapeles está vacío.');
    const at = this.engine.getPosition();
    const ts = this.edit.displayTracks(); const startIdx = Math.max(0, ts.findIndex(t => t.id === this.store.selectedTrack));
    const firstIdx = Math.min(...cb.tracks.map(x => ts.findIndex(t => t.id === x.trackId)).filter(i => i >= 0));
    this.store.edit('Pegar', p => {
      cb.tracks.forEach((ct) => {
        const srcIdx = ts.findIndex(t => t.id === ct.trackId);
        const target = ts[clamp(startIdx + (srcIdx >= 0 && isFinite(firstIdx) ? srcIdx - firstIdx : 0), 0, ts.length - 1)];
        const tt = target && p.tracks.find(x => x.id === target.id); if (!tt || !tt.playlists.length) return;
        const clips = clipsOf(tt);
        if (this.edit.mode === 'shuffle') { for (const c of clips) if (c.start >= at) c.start += cb.len; }
        else clearRange(clips, at, at + cb.len);
        for (const c of ct.clips) if ((c.kind === 'audio') === (tt.type === 'audio')) clips.push({ ...JSON.parse(JSON.stringify(c)), id: uid('clp'), start: c.start + at });
        clips.sort((a, b) => a.start - b.start);
      });
    });
    this.engine.setPosition(at + cb.len);
  }
  deleteSel() {
    const sel = this.edit.selectedRange();
    if (sel) { this.store.edit('Borrar', p => { for (const t of p.tracks) if (sel.tracks.includes(t.id) && t.playlists.length) clearRange(clipsOf(t), sel.start, sel.end, this.edit.mode === 'shuffle'); }); this.edit.sel.end = this.edit.sel.start; return; }
    const ids = new Set(this.store.selectedClips); if (!ids.size) return;
    this.store.edit('Borrar clip', p => { for (const t of p.tracks) for (const pl of t.playlists) { const removed = pl.clips.filter(c => ids.has(c.id)); pl.clips = pl.clips.filter(c => !ids.has(c.id)); if (this.edit.mode === 'shuffle') for (const r of removed) for (const c of pl.clips) if (c.start >= r.start) c.start -= r.duration; } });
    this.store.selectedClips.clear();
  }
  duplicate() {
    const sel = this.edit.selectedRange();
    if (sel) { this.copy(); const pos = this.engine.position; this.engine.position = sel.end; this.paste(); this.edit.sel = { start: sel.end, end: sel.end + (sel.end - sel.start), tracks: new Set(sel.tracks) }; this.engine.position = pos; return; }
    const tg = this.targets(); if (!tg.length) return toast('Selecciona clips o un rango.');
    const end = Math.max(...tg.map(x => x.clip.start + x.clip.duration)), st = Math.min(...tg.map(x => x.clip.start));
    this.store.edit('Duplicar', p => { for (const x of tg) { const f = this.store.findClip(x.clip.id); const c = JSON.parse(JSON.stringify(f.clip)); c.id = uid('clp'); c.start += end - st; f.playlist.clips.push(c); } });
  }
  selectAll() {
    const len = this.store.sessionLength();
    this.edit.sel = { start: 0, end: len, tracks: new Set(this.store.project.tracks.map(t => t.id)) };
    this.edit.dirty = true; this.updateSelInfo();
  }
  trimToSel() { const sel = this.edit.selectedRange(); if (!sel) return toast('Selecciona un rango.'); this.store.edit('Recortar a selección', p => { for (const t of p.tracks) if (sel.tracks.includes(t.id) && t.playlists.length) { const c = clipsOf(t); clearRange(c, 0, sel.start); clearRange(c, sel.end, 1e9); } }); }
  fadesFromSel() {
    const sel = this.edit.selectedRange(); if (!sel) return toast('Selecciona un rango que cubra el borde de los clips.');
    this.store.edit('Fundidos', p => {
      for (const t of p.tracks) if (sel.tracks.includes(t.id)) for (const c of clipsOf(t)) {
        const ce = c.start + c.duration;
        if (sel.start <= c.start + 0.001 && sel.end > c.start && sel.end < ce) c.fadeIn = sel.end - c.start;
        else if (sel.end >= ce - 0.001 && sel.start > c.start && sel.start < ce) c.fadeOut = ce - sel.start;
        else if (sel.start > c.start && sel.end < ce) { /* selección interna: ignorar */ }
      }
    });
  }
  clipGain(d) { const tg = this.targets(); if (!tg.length) return; this.store.edit('Ganancia de clip', () => tg.forEach(x => { const f = this.store.findClip(x.clip.id); f.clip.gain = clamp((f.clip.gain || 0) + d, -48, 24); })); }
  muteClips() { const tg = this.targets(); if (!tg.length) return; this.store.edit('Silenciar clip', () => tg.forEach(x => { const f = this.store.findClip(x.clip.id); f.clip.muted = !f.clip.muted; })); }
  quantizeClips() { const tg = this.targets(); this.store.edit('Cuantizar clips', () => tg.forEach(x => { const f = this.store.findClip(x.clip.id); f.clip.start = this.edit.snap(f.clip.start, true); })); }
  nudge(dir) {
    const g = 60 / this.store.project.tempo * 4 / this.edit.gridDiv;
    const tg = [...this.store.selectedClips].map(id => this.store.findClip(id)).filter(Boolean);
    if (!tg.length) { this.engine.setPosition(Math.max(0, this.engine.getPosition() + dir * g)); return; }
    this.store.edit('Desplazar (nudge)', () => tg.forEach(x => { x.clip.start = Math.max(0, x.clip.start + dir * g); }));
  }
  async clipRate() {
    const tg = this.targets().filter(x => x.clip.kind === 'audio'); if (!tg.length) return toast('Selecciona un clip de audio.');
    const r = await formBox('Varispeed (velocidad del clip)', [{ key: 'rate', label: 'Factor de velocidad', type: 'number', value: tg[0].clip.rate || 1, step: 0.001, min: 0.25, max: 4 }, { key: 'from', label: 'o de BPM original', type: 'number', value: '' }], 'Aplicar', 'Varispeed cambia velocidad y tono a la vez (como cinta). Para cambiar solo la duración usa AudioSuite › Compresión/Expansión de tiempo.');
    if (!r) return;
    const rate = r.from > 0 ? this.store.project.tempo / r.from : r.rate;
    this.store.edit('Varispeed', () => tg.forEach(x => { const f = this.store.findClip(x.clip.id); const old = f.clip.rate || 1; f.clip.duration = f.clip.duration * old / rate; f.clip.rate = rate; }));
  }
  async renameClip() { const tg = this.targets(); if (!tg.length) return; const n = await promptBox('Renombrar clip', 'Nombre:', tg[0].clip.name); if (n) this.store.edit('Renombrar clip', () => tg.forEach(x => { this.store.findClip(x.clip.id).clip.name = n; })); }
  async colorClip() { const tg = this.targets(); if (!tg.length) return; const r = await formBox('Color de clip', [{ key: 'c', label: 'Color', type: 'select', options: [['', 'Color de la pista'], ...TRACK_COLORS.map(c => [c, c])] }]); if (r) this.store.edit('Color de clip', () => tg.forEach(x => { this.store.findClip(x.clip.id).clip.color = r.c || null; })); }
  async spotClip(id) {
    const f = this.store.findClip(id); if (!f) return;
    const p = this.store.project;
    const r = await formBox('Ubicar clip (Spot)', [{ key: 'min', label: 'Inicio (min:seg.ms)', value: fmtMinSec(f.clip.start) }, { key: 'bars', label: 'o en compás|tiempo', value: fmtBars(f.clip.start, p.tempo, p.timeSig) }], 'Ubicar');
    if (!r) return;
    let t;
    const bm = r.bars.match(/(\d+)\|(\d+)(?:\|(\d+))?/), mm = r.min.match(/(-?\d+):(\d+(?:\.\d+)?)/);
    const beat = 60 / p.tempo;
    if (bm && r.bars !== fmtBars(f.clip.start, p.tempo, p.timeSig)) t = ((+bm[1] - 1) * p.timeSig[0] + (+bm[2] - 1) + (+(bm[3] || 0)) / 960) * beat;
    else if (mm) t = +mm[1] * 60 + +mm[2];
    if (t >= 0) this.store.edit('Spot', () => { this.store.findClip(id).clip.start = t; });
  }
  clipContextMenu(id, x, y, t) {
    const f = this.store.findClip(id); if (!f) return;
    const isA = f.clip.kind === 'audio';
    contextMenu(x, y, [{ head: f.clip.name },
      { label: 'Dividir aquí', key: 'Ctrl+E', action: () => { this.store.edit('Dividir clip', () => { const ff = this.store.findClip(id); splitClip(ff.playlist.clips, ff.clip, t); }); } },
      { label: 'Duplicar', key: 'Ctrl+D', action: () => this.duplicate() }, { label: 'Borrar', key: 'Supr', action: () => this.deleteSel() },
      { label: f.clip.muted ? 'Activar clip' : 'Silenciar clip', key: 'Ctrl+M', action: () => this.muteClips() }, { label: 'Renombrar…', action: () => this.renameClip() }, { label: 'Ubicar (Spot)…', action: () => this.spotClip(id) },
      { label: 'Ganancia de clip…', action: async () => { const v = await promptBox('Ganancia de clip', 'Ganancia en dB:', String(f.clip.gain || 0)); if (v !== null) this.store.edit('Ganancia de clip', () => { this.store.findClip(id).clip.gain = clamp(+v || 0, -48, 24); }); } },
      ...(isA ? [{ label: 'Varispeed…', action: () => this.clipRate() }, { label: 'Normalizar', action: () => this.audioSuite('normalize') }, { label: 'Invertir', action: () => this.audioSuite('reverse') }, { label: 'Estirar tiempo…', action: () => this.audioSuite('stretch') }, { label: 'Cambiar tono…', action: () => this.audioSuite('pitch') }, '-',
        { head: '✨ IA' }, { label: 'Separar stems', action: () => this.aiStems() }, { label: 'Transcribir voz a texto', action: () => this.aiTranscribe() }, { label: 'Audio a MIDI', action: () => this.aiAudioToMidi() }, { label: 'Afinación automática…', action: () => this.audioSuite('autotune') }, { label: 'Limpiar ruido…', action: () => this.audioSuite('denoise') }, { label: 'Detectar tempo y tonalidad', action: () => this.aiDetect() }, { label: 'Cuantizar por ataques', action: () => this.aiBeatQuantize() }, { label: 'Quitar silencios…', action: () => this.stripSilence() }]
        : [{ label: 'Abrir en Editor MIDI', action: () => this.openPianoRoll(id) }, { label: 'Exportar como .mid', action: () => this.exportMidiClip(id) }])]);
  }
  openPianoRoll(id) { this.roll.open(id); this.setView('midi'); }
  updateSelInfo() {
    const s = this.edit.selectedRange();
    $('#selInfo').textContent = s ? `Selección ${fmtMinSec(s.start)} → ${fmtMinSec(s.end)} (${(s.end - s.start).toFixed(3)} s)` : '';
  }
  addMarker(t) {
    const p = this.store.project;
    this.store.edit('Marcador', pp => { pp.markers.push({ id: uid('mk'), t, name: 'Marcador ' + (pp.markers.length + 1), color: TRACK_COLORS[pp.markers.length % TRACK_COLORS.length] }); pp.markers.sort((a, b) => a.t - b.t); });
    this.setStatus('Marcador creado en ' + fmtBars(t, p.tempo, p.timeSig));
  }
  markersWindow() {
    const body = h('div', { class: 'markers-list', style: { minWidth: '300px' } });
    const render = () => {
      body.innerHTML = '';
      const p = this.store.project;
      if (!p.markers.length) body.append(h('p', { style: { color: 'var(--dim)' } }, 'Sin marcadores. Doble clic en la regla o Enter del teclado numérico para crear uno.'));
      p.markers.forEach((m, i) => {
        const name = h('input', { type: 'text', value: m.name, style: { flex: 1 } });
        name.onchange = () => this.store.edit('Renombrar marcador', pp => { pp.markers[i].name = name.value; });
        name.onkeydown = (e) => e.stopPropagation();
        body.append(h('div', { class: 'mk' }, h('i', { style: { background: m.color } }), h('span', { style: { fontFamily: 'var(--mono)', width: '80px', cursor: 'pointer' }, onclick: () => this.engine.setPosition(m.t) }, fmtBars(m.t, p.tempo, p.timeSig)), name, h('button', { class: 'btn small', onclick: () => this.engine.setPosition(m.t) }, '▶'), h('button', { class: 'btn small', onclick: () => { this.store.edit('Borrar marcador', pp => pp.markers.splice(i, 1)); render(); } }, '✕')));
      });
      body.append(h('button', { class: 'btn small', style: { marginTop: '8px' }, onclick: () => { this.addMarker(this.engine.getPosition()); render(); } }, '+ Marcador en el cabezal'));
    };
    render(); floatWindow('markersWin', '📍 Marcadores', body, { w: 380, x: innerWidth - 420, y: 140 });
  }
  async tempoDialog() {
    const p = this.store.project;
    const r = await formBox('Tempo, compás y tonalidad', [{ key: 'tempo', label: 'Tempo (BPM)', type: 'number', value: p.tempo, step: 0.01 }, { key: 'sig', label: 'Compás', value: p.timeSig.join('/') }, { key: 'key', label: 'Tónica', type: 'select', options: KEYS, value: p.key }, { key: 'scale', label: 'Escala', type: 'select', options: Object.keys(SCALES), value: p.scale }, { key: 'tap', label: 'Tap tempo', type: 'text', value: '' }], 'Aplicar', 'Consejo: “IA › Detectar tempo y tonalidad” analiza un clip y propone estos valores.');
    if (!r) return;
    const m = r.sig.match(/(\d+)\/(\d+)/);
    this.store.edit('Tempo y compás', pp => { pp.tempo = clamp(r.tempo, 20, 300); if (m) pp.timeSig = [+m[1], +m[2]]; pp.key = r.key; pp.scale = r.scale; });
  }

  // ---------- Inserciones y envíos ----------
  insertMenu(trackId, x, y, slot) {
    const cats = {}; for (const [k, v] of Object.entries(PLUGINS)) (cats[v.cat] ||= []).push([k, v]);
    const items = [];
    for (const [cat, list] of Object.entries(cats)) { items.push({ head: cat }); for (const [k, v] of list) items.push({ label: v.name, action: () => this.addInsert(trackId, k, slot) }); }
    contextMenu(x, y, items);
  }
  addInsert(trackId, type, slot, params) {
    const ins = { id: uid('ins'), type, params: { ...defaultParams(type), ...(params || {}) }, bypass: false };
    this.store.edit('Insertar ' + PLUGINS[type].name, p => {
      const list = trackId === 'master' ? p.master.inserts : p.tracks.find(t => t.id === trackId)?.inserts; if (!list) return;
      if (slot !== undefined && slot < list.length) list.splice(slot, 0, ins); else list.push(ins);
    });
    this.mix.build();
    return ins;
  }
  insertContext(trackId, insId, x, y) {
    const list = () => trackId === 'master' ? this.store.project.master.inserts : this.store.track(trackId).inserts;
    const ins = list().find(i => i.id === insId);
    contextMenu(x, y, [{ head: PLUGINS[ins.type].name }, { label: 'Abrir', action: () => this.openPlugin(trackId, insId) }, { label: ins.bypass ? 'Activar' : 'Omitir (bypass)', action: () => { this.store.edit('Bypass', p => { const l = trackId === 'master' ? p.master.inserts : p.tracks.find(t => t.id === trackId).inserts; const i = l.find(q => q.id === insId); i.bypass = !i.bypass; }); this.mix.build(); } },
      { label: 'Subir', action: () => this.moveInsert(trackId, insId, -1) }, { label: 'Bajar', action: () => this.moveInsert(trackId, insId, 1) },
      { label: 'Quitar', action: () => { this.store.edit('Quitar inserción', p => { const tt = trackId === 'master' ? p.master : p.tracks.find(t => t.id === trackId); tt.inserts = tt.inserts.filter(i => i.id !== insId); }); document.getElementById('plug_' + insId)?.remove(); this.mix.build(); } }]);
  }
  moveInsert(trackId, insId, d) { this.store.edit('Mover inserción', p => { const l = trackId === 'master' ? p.master.inserts : p.tracks.find(t => t.id === trackId).inserts; const i = l.findIndex(q => q.id === insId); const j = clamp(i + d, 0, l.length - 1); [l[i], l[j]] = [l[j], l[i]]; }); this.mix.build(); }
  sendMenu(trackId, idx, x, y) {
    const auxes = this.store.project.tracks.filter(t => t.type === 'aux' && t.id !== trackId);
    const t = this.store.track(trackId); const s = t.sends[idx];
    const items = [{ head: 'Enviar a…' }, ...auxes.map(a => ({ label: a.name, action: () => this.setSend(trackId, idx, a.id) })), { label: '+ Nuevo bus auxiliar (Reverb)', action: () => { const [id] = this.addTracks('aux', 1, 'Reverb Aux'); this.addInsert(id, 'reverb', undefined, { mix: 100 }); this.setSend(trackId, idx, id); } }, { label: '+ Nuevo bus auxiliar (Delay)', action: () => { const [id] = this.addTracks('aux', 1, 'Delay Aux'); this.addInsert(id, 'delay', undefined, { mix: 100, sync: 8 }); this.setSend(trackId, idx, id); } }];
    if (s) items.push('-', { label: s.pre ? 'Post-fader' : 'Pre-fader', action: () => this.store.edit('Envío', p => { const ss = p.tracks.find(q => q.id === trackId).sends[idx]; ss.pre = !ss.pre; }) }, { label: 'Nivel…', action: async () => { const v = await promptBox('Nivel de envío', 'dB:', String(s.level)); if (v !== null) this.store.edit('Nivel de envío', p => { p.tracks.find(q => q.id === trackId).sends[idx].level = clamp(+v, -90, 12); }); } }, { label: 'Quitar envío', action: () => this.store.edit('Quitar envío', p => { p.tracks.find(q => q.id === trackId).sends.splice(idx, 1); }) });
    contextMenu(x, y, items);
  }
  setSend(trackId, idx, bus) { this.store.edit('Envío', p => { const t = p.tracks.find(q => q.id === trackId); const s = { bus, level: -10, pre: false, mute: false }; if (idx < t.sends.length) t.sends[idx] = s; else t.sends.push(s); }); this.mix.build(); }
  openPlugin(trackId, insId) {
    const getIns = () => (trackId === 'master' ? this.store.project.master.inserts : this.store.track(trackId)?.inserts)?.find(i => i.id === insId);
    const ins = getIns(); if (!ins) return;
    const def = PLUGINS[ins.type];
    const body = h('div', { style: { width: '430px' } });
    let curve;
    if (ins.type === 'eq7') { curve = h('canvas', { width: 860, height: 260, style: { width: '100%', height: '130px', background: '#07090c', borderRadius: '6px', marginBottom: '8px' } }); body.append(curve); }
    let grEl; if (ins.type === 'comp' || ins.type === 'limiter') { grEl = h('div', { class: 'progress' }, h('i', { style: { background: 'var(--gold)' } })); body.append(h('div', { style: { fontSize: '11px', color: 'var(--dim)' } }, 'Reducción de ganancia'), grEl); }
    const presets = PRESETS[ins.type];
    if (presets) { const ps = h('select', {}); ps.append(h('option', { value: '' }, 'Presets…')); for (const k in presets) ps.append(h('option', { value: k }, k)); ps.onchange = () => { if (!ps.value) return; this.store.edit('Preset', () => { Object.assign(getIns().params, presets[ps.value]); }); this.engine.updateMix(); this.openPlugin(trackId, insId); }; body.append(h('div', { style: { marginBottom: '8px' } }, ps)); }
    const drawCurve = () => {
      if (!curve) return; const n = this.engine.getInsertNode(trackId, insId); const c = curve.getContext('2d'); c.clearRect(0, 0, 860, 260);
      c.strokeStyle = '#1b2030'; for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) { const x = Math.log10(f / 20) / 3 * 860; c.beginPath(); c.moveTo(x, 0); c.lineTo(x, 260); c.stroke(); c.fillStyle = '#5e667a'; c.font = '16px system-ui'; c.fillText(f >= 1000 ? f / 1000 + 'k' : f, x + 3, 254); }
      c.beginPath(); c.moveTo(0, 130); c.lineTo(860, 130); c.stroke();
      if (!n?.filters) { c.fillStyle = '#8b93a7'; c.fillText('Reproduce o inicia el audio para ver la curva', 20, 30); return; }
      const N = 430, fr = new Float32Array(N), mag = new Float32Array(N), ph = new Float32Array(N), tot = new Float32Array(N).fill(1);
      for (let i = 0; i < N; i++) fr[i] = 20 * Math.pow(1000, i / (N - 1));
      for (const f of n.filters) { f.getFrequencyResponse(fr, mag, ph); for (let i = 0; i < N; i++) tot[i] *= mag[i]; }
      c.strokeStyle = '#ff3d7f'; c.lineWidth = 3; c.beginPath();
      for (let i = 0; i < N; i++) { const db = 20 * Math.log10(tot[i] || 1e-6); const y = 130 - db * 6; i ? c.lineTo(i * 2, y) : c.moveTo(0, y); } c.stroke(); c.lineWidth = 1;
    };
    for (const pd of def.params) {
      const v = ins.params[pd.key] ?? pd.def;
      const toS = (x) => pd.log ? Math.log(x / pd.min) / Math.log(pd.max / pd.min) * 1000 : (x - pd.min) / (pd.max - pd.min) * 1000;
      const fromS = (s) => { let x = pd.log ? pd.min * Math.pow(pd.max / pd.min, s / 1000) : pd.min + (pd.max - pd.min) * s / 1000; if (pd.step) x = Math.round(x / pd.step) * pd.step; return Math.round(x * 1000) / 1000; };
      const sl = h('input', { type: 'range', min: 0, max: 1000, step: 1, value: toS(v) });
      const ve = h('span', { class: 'v' }, fmtP(v, pd));
      sl.addEventListener('pointerdown', () => this.store.begin());
      sl.addEventListener('input', () => { const x = fromS(+sl.value); ve.textContent = fmtP(x, pd); this.store.live(() => { getIns().params[pd.key] = x; }); this.engine.setInsertParam(trackId, insId, pd.key, x); drawCurve(); });
      sl.addEventListener('change', () => this.store.commit('Parámetro ' + pd.name));
      sl.addEventListener('dblclick', () => { sl.value = toS(pd.def); sl.dispatchEvent(new Event('input')); });
      body.append(h('div', { class: 'param' }, h('span', {}, pd.name), sl, ve));
    }
    const byp = h('button', { class: 'btn small' + (ins.bypass ? '' : ' primary') }, ins.bypass ? 'Omitido' : 'Activo');
    byp.onclick = () => { this.store.edit('Bypass', () => { const i = getIns(); i.bypass = !i.bypass; }); this.openPlugin(trackId, insId); this.mix.build(); };
    const tname = trackId === 'master' ? 'Master' : this.store.track(trackId).name;
    floatWindow('plug_' + insId, `${def.name} — ${tname}`, body, { w: 460, headExtra: [byp] });
    drawCurve();
    if (grEl) { const tick = () => { if (!document.getElementById('plug_' + insId)) return; const n = this.engine.getInsertNode(trackId, insId); const r = n?.comp ? -n.comp.reduction : 0; grEl.firstChild.style.width = clamp(r / 20 * 100, 0, 100) + '%'; requestAnimationFrame(tick); }; tick(); }
  }

  // ---------- Importación ----------
  async importFiles(files, trackId, at, toBin = false) {
    await this.engine.init();
    if ($('#welcome').style.display !== 'none') await this.createSession(files[0]?.name.replace(/\.[^.]+$/, '') || 'Sesión');
    let t0 = at ?? this.engine.getPosition();
    const pr = progressBox('Importando', ''); let i = 0;
    for (const f of files) {
      pr.set(i / files.length, f.name); i++;
      try {
        if (/\.(mid|midi)$/i.test(f.name)) { await this.importMidi(f, trackId, t0); continue; }
        if (/^video\//.test(f.type) || /\.(mp4|mov|mkv|webm|avi)$/i.test(f.name) && !/^audio/.test(f.type)) { await this.importVideo(f); continue; }
        const buf = await decodeFile(this.engine.ctx, f);
        const asset = this.store.addAsset(f.name.replace(/\.[^.]+$/, ''), buf);
        if (toBin) continue;
        this.placeAsset(asset.id, files.length > 1 ? null : trackId, t0, files.length > 1);
      } catch (e) { console.error(e); toast('No se pudo importar ' + f.name + ': formato no compatible.', true); }
    }
    pr.close(); this.renderAssets();
  }
  placeAsset(assetId, trackId, t, forceNew = false) {
    const a = this.store.assets.get(assetId); if (!a) return;
    let tr = !forceNew && trackId ? this.store.track(trackId) : null;
    if (!tr || tr.type !== 'audio') { const [id] = this.addTracks('audio', 1, a.name.slice(0, 24), null, a.buffer.numberOfChannels > 1 ? 'stereo' : 'mono'); tr = this.store.track(id); }
    this.store.edit('Importar audio', p => { const tt = p.tracks.find(x => x.id === tr.id); tt.playlists[tt.activePlaylist].clips.push(newAudioClip(a, Math.max(0, t || 0))); tt.playlists[tt.activePlaylist].clips.sort((x, y) => x.start - y.start); });
    this.edit.updateSpacer();
  }
  async importMidi(file, trackId, at = 0) {
    const m = parseMidi(await file.arrayBuffer());
    const ok = await confirmBox('Importar MIDI', `Archivo con ${m.tracks.length} pista(s) y tempo ${m.bpm} BPM. ¿Usar ese tempo en la sesión?`, 'Sí, usar tempo', 'No');
    if (ok) this.store.edit('Tempo desde MIDI', p => { p.tempo = m.bpm; });
    const scale = ok ? 1 : m.bpm / this.store.project.tempo;
    for (const tr of m.tracks) {
      const [id] = this.addTracks('instrument', 1, tr.name, tr.drums ? 'drums:Acústica' : 'synth:Piano eléctrico');
      const notes = tr.notes.map(n => ({ ...n, t: n.t * scale, d: n.d * scale }));
      const end = Math.max(...notes.map(n => n.t + n.d)); const bar = 60 / this.store.project.tempo * this.store.project.timeSig[0];
      this.store.edit('Importar MIDI', p => { const t = p.tracks.find(x => x.id === id); t.playlists[0].clips.push(newMidiClip(at, Math.ceil(end / bar) * bar, notes, tr.name)); });
    }
  }
  exportMidiClip(id) { const f = this.store.findClip(id); if (!f) return; this.saveBlob(writeMidi([{ ...f.clip, start: 0, channel: f.track.instrument?.type === 'drums' ? 9 : 0 }], this.store.project.tempo), (f.clip.name || 'clip') + '.mid', true, [{ name: 'MIDI', extensions: ['mid'] }]); }
  exportAllMidi() {
    const clips = []; for (const t of this.store.project.tracks) for (const c of clipsOf(t)) if (c.kind === 'midi') clips.push({ ...c, name: t.name, channel: t.instrument?.type === 'drums' ? 9 : 0 });
    if (!clips.length) return toast('No hay clips MIDI en la sesión.');
    this.saveBlob(writeMidi(clips, this.store.project.tempo), this.store.project.name + '.mid', true, [{ name: 'MIDI', extensions: ['mid'] }]);
  }

  // ---------- Video ----------
  async importVideo(file) {
    if (!file) return;
    await this.engine.init();
    if ($('#welcome').style.display !== 'none') await this.createSession(file.name.replace(/\.[^.]+$/, ''));
    const url = URL.createObjectURL(file);
    const id = uid('vid');
    const v = document.createElement('video'); v.src = url; await new Promise(r => { v.onloadedmetadata = r; v.onerror = r; });
    this.store.assets.set(id, { id, name: file.name, video: true, videoBlob: file, url, duration: v.duration || 0 });
    if (!this.store.project.tracks.some(t => t.type === 'video')) this.addTracks('video', 1);
    this.store.edit('Importar video', p => { p.videoAssetId = id; const vt = p.tracks.find(t => t.type === 'video'); p.tracks.splice(p.tracks.indexOf(vt), 1); p.tracks.unshift(vt); });
    try { const buf = await decodeFile(this.engine.ctx, file); const a = this.store.addAsset('Audio de ' + file.name, buf); this.placeAsset(a.id, null, 0, true); } catch (e) { toast('El video no tiene audio decodificable; se importó solo la imagen.'); }
    this.videoWindow();
  }
  videoWindow() {
    const a = this.store.assets.get(this.store.project.videoAssetId);
    if (!a) return toast('Importa un video con Archivo › Importar video…');
    const v = h('video', { src: a.url, style: { width: '100%', borderRadius: '6px', background: '#000' }, muted: 'muted', playsinline: 'true' });
    v.muted = true; this.video = v;
    floatWindow('videoWin', '🎬 ' + a.name, v, { w: 480, x: innerWidth - 520, y: 110, onClose: () => { this.video = null; } });
    this.syncVideo(this.engine.playing);
  }
  syncVideo(play) {
    const v = this.video; if (!v) return;
    v.currentTime = Math.max(0, this.engine.getPosition());
    if (play && this.engine.playing) v.play().catch(() => { }); else v.pause();
  }

  // ---------- MIDI externo ----------
  async initMIDI() {
    if (!navigator.requestMIDIAccess) return;
    try {
      const acc = await navigator.requestMIDIAccess();
      const bind = () => { for (const inp of acc.inputs.values()) inp.onmidimessage = (m) => this.onMidiMsg(m.data); };
      bind(); acc.onstatechange = bind;
    } catch (e) { /* sin MIDI */ }
  }
  onMidiMsg(d) {
    const [st, n, v] = d, type = st & 0xf0;
    const t = this.store.project.tracks.find(x => x.instrument && x.recArm) || this.store.track(this.store.selectedTrack);
    if (!t?.instrument) return;
    this.engine.init().then(() => { if (type === 0x90 && v > 0) this.engine.noteOn(t.id, n, v); else if (type === 0x80 || (type === 0x90 && v === 0)) this.engine.noteOff(t.id, n); });
  }

  // ---------- Ventanas auxiliares ----------
  bigCounter() { const el = h('div', { style: { fontFamily: 'var(--mono)', fontSize: '56px', color: '#7cf2d4', padding: '10px 20px', textAlign: 'center' } }, ''); this._big = el; floatWindow('bigCtr', 'Contador', el, { w: 460, onClose: () => { this._big = null; } }); }
  spectrumWindow() {
    const cv = h('canvas', { width: 900, height: 360, style: { width: '100%', height: '180px', background: '#07090c', borderRadius: '6px' } });
    floatWindow('specWin', '📈 Analizador de espectro (master)', cv, { w: 520 });
    const draw = () => {
      if (!document.getElementById('specWin')) return;
      const an = this.engine.graph?.spectrum; const c = cv.getContext('2d'); c.fillStyle = '#07090c'; c.fillRect(0, 0, 900, 360);
      if (an) {
        const d = new Float32Array(an.frequencyBinCount); an.getFloatFrequencyData(d); const sr = this.engine.ctx.sampleRate;
        c.beginPath(); c.moveTo(0, 360);
        for (let x = 0; x < 900; x++) { const f = 20 * Math.pow(1000, x / 900); const i = Math.round(f / (sr / 2) * d.length); const db = d[Math.min(d.length - 1, i)]; c.lineTo(x, 360 - (db + 100) / 100 * 360); }
        c.lineTo(900, 360); c.fillStyle = 'rgba(255,61,127,.35)'; c.fill(); c.strokeStyle = '#ff3d7f'; c.stroke();
        c.fillStyle = '#5e667a'; c.font = '18px system-ui'; for (const f of [50, 100, 500, 1000, 5000, 10000]) c.fillText(f >= 1000 ? f / 1000 + 'k' : f, Math.log10(f / 20) / 3 * 900, 350);
      }
      requestAnimationFrame(draw);
    };
    draw();
  }
  historyWindow() {
    const body = h('div', { style: { maxHeight: '50vh', overflow: 'auto', minWidth: '260px' } });
    const st = this.store.undoStack.slice().reverse();
    if (!st.length) body.append(h('p', { style: { color: 'var(--dim)' } }, 'Sin acciones todavía.'));
    st.forEach((s, i) => body.append(h('div', { class: 'mitem', onclick: () => { for (let k = 0; k <= i; k++) this.store.undo(); this.historyWindow(); } }, h('span', {}, s.label), h('span', { class: 'k' }, i === 0 ? 'última' : ''))));
    floatWindow('histWin', '↶ Historial (clic para volver a ese punto)', body, { w: 320 });
  }
  async settingsDialog() {
    let devices = [];
    try { devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput'); } catch (e) { }
    const s = this.settings;
    const r = await formBox('Preferencias', [
      { key: 'input', label: 'Dispositivo de entrada', type: 'select', options: [['', 'Predeterminado del sistema'], ...devices.map(d => [d.deviceId, d.label || 'Entrada ' + d.deviceId.slice(0, 6)])], value: this.engine.inputDeviceId || '' },
      { key: 'latencyComp', label: 'Compensación de latencia extra (muestras)', type: 'number', value: s.latencyComp },
      { key: 'autoMonitor', label: 'Monitorizar al armar pista', type: 'check', value: s.autoMonitor },
      { key: 'returnToStart', label: 'Al detener, volver al punto de inicio', type: 'check', value: s.returnToStart },
      { key: 'followPlayhead', label: 'La vista sigue al cabezal', type: 'check', value: s.followPlayhead },
      { key: 'autosave', label: 'Autoguardado cada 90 s', type: 'check', value: s.autosave },
      { key: 'theme', label: 'Tema', type: 'select', options: [['dark', 'Oscuro'], ['light', 'Claro']], value: s.theme },
      { key: 'metroVol', label: 'Volumen del metrónomo (0–1)', type: 'number', value: this.engine.metroVol, step: 0.05, min: 0, max: 1 }
    ], 'Guardar');
    if (!r) return;
    if (r.input !== (this.engine.inputDeviceId || '')) { this.engine.inputDeviceId = r.input || null; if (this.engine.inputStream) { this.engine.inputStream.getTracks().forEach(t => t.stop()); this.engine.inputStream = null; this.engine.inputNode = null; } }
    Object.assign(s, { latencyComp: r.latencyComp | 0, autoMonitor: r.autoMonitor, returnToStart: r.returnToStart, followPlayhead: r.followPlayhead, autosave: r.autosave, theme: r.theme });
    this.engine.latencyComp = s.latencyComp; this.engine.autoMonitor = s.autoMonitor; this.engine.returnToStart = s.returnToStart; this.edit.follow = s.followPlayhead; this.engine.metroVol = clamp(r.metroVol, 0, 1);
    document.body.classList.toggle('light', s.theme === 'light'); this.edit.dirty = true;
    this.saveSettings(); toast('Preferencias guardadas.');
  }
  openManual() {
    if (window.mmxNative?.openManual) return window.mmxNative.openManual();
    if (window.MMXAndroid) { floatWindow('manualWin', '📖 Manual del usuario', h('iframe', { src: 'manual/index.html', style: { width: Math.min(innerWidth - 30, 1000) + 'px', height: (innerHeight - 120) + 'px', border: 0, borderRadius: '6px', background: '#0f1117' } }), { x: 10, y: 40 }); return; }
    window.open('manual/index.html', '_blank');
  }
  shortcutsHelp() {
    const rows = [['Espacio', 'Reproducir / detener'], ['Ctrl+Espacio · F12 · 3 (num)', 'Grabar'], ['Enter · Inicio', 'Volver al inicio'], ['Fin', 'Ir al final'], ['L · Ctrl+Shift+L', 'Bucle'], ['C · 7 (num)', 'Metrónomo'], ['F1–F4', 'Modos Shuffle / Slip / Spot / Grid'], ['F5–F10', 'Herramientas Zoom / Recorte / Selector / Mano / Scrub / Lápiz'], ['T / R', 'Acercar / alejar'], ['Ctrl+rueda · Alt+rueda', 'Zoom horizontal · zoom de forma de onda'], ['B · Ctrl+E', 'Dividir clip'], ['Ctrl+D', 'Duplicar'], ['Ctrl+X/C/V', 'Cortar / copiar / pegar'], ['Supr', 'Borrar'], ['Ctrl+T', 'Recortar a selección'], ['Ctrl+F', 'Fundidos desde selección'], ['Ctrl+M', 'Silenciar clip'], ['Ctrl+Shift+↑/↓', 'Ganancia de clip ±1 dB'], ['+ / −', 'Desplazar (nudge) por la rejilla'], ['← / →', 'Mover cabezal un tiempo'], ['↑ / ↓', 'Pista anterior / siguiente'], ['Ctrl+Z / Ctrl+Shift+Z', 'Deshacer / rehacer'], ['Ctrl+S', 'Guardar sesión'], ['Ctrl+=', 'Alternar Edición/Mezcla'], ['Ctrl+K', 'Asistente IA'], ['Ctrl+Alt+B', 'Bounce / exportar'], ['Enter (num)', 'Nuevo marcador'], ['Editor MIDI: A W S E D F T G Y H U J K', 'Tocar notas · Z/X cambia octava']];
    modal('Atajos de teclado', `<table class="list">${rows.map(r => `<tr><td><span class="kbd">${r[0]}</span></td><td>${r[1]}</td></tr>`).join('')}</table><p style="color:var(--dim)">En macOS usa ⌘ en lugar de Ctrl.</p>`, undefined, { width: '640px' });
  }
  about() {
    modal('Acerca de Músicos MX', `<div style="text-align:center"><img src="img/logo.png" style="width:110px"><h2 style="border:0;margin:6px 0">Músicos MX ${VERSION}</h2>
    <p>Estación de trabajo de audio digital (DAW) libre y multiplataforma con funciones de inteligencia artificial local.</p>
    <p><b>Desarrollador:</b> Santiago Miguel<br>Tel. 744 354 8848 · <a href="mailto:chago2850@gmail.com" style="color:var(--teal)">chago2850@gmail.com</a></p>
    <p style="color:var(--dim);font-size:12px">Copyright © 2026 Santiago Miguel. Este programa es software libre: puede redistribuirlo y/o modificarlo bajo los términos de la <b>Licencia Pública General GNU versión 3</b> o (a su elección) cualquier versión posterior. Se distribuye SIN GARANTÍA ALGUNA.<br>Inspirado en el flujo de trabajo de las estaciones profesionales; no está afiliado ni respaldado por Avid Technology. “Pro Tools” es marca de su respectivo titular.<br>Componentes de terceros: JSZip (MIT/GPLv3), lamejs (LGPL), Electron (MIT), Transformers.js y modelos Whisper (Apache-2.0/MIT, opcionales).</p></div>`);
  }
}

function fmtP(v, pd) { const n = Math.abs(v) >= 1000 ? (v / 1000).toFixed(2) + 'k' : Math.abs(v) < 1 && pd.unit === 's' ? (v * 1000).toFixed(1) + ' ms' : (+v).toFixed(pd.step === 1 ? 0 : 2); return pd.unit === 's' && Math.abs(v) < 1 ? n : n + (pd.unit ? ' ' + pd.unit : ''); }

export const PRESETS = {
  eq7: { 'Voz brillante': { hpf: 90, p1G: -2, p1F: 300, p3F: 3500, p3G: 2, hsG: 3 }, 'Bombo potente': { hpf: 30, lsF: 60, lsG: 4, p1F: 350, p1G: -5, p3F: 3000, p3G: 3 }, 'Guitarra limpia': { hpf: 100, p1F: 250, p1G: -3, p2F: 2500, p2G: 2 }, 'Radio/teléfono': { hpf: 400, lpf: 3500, p2F: 1500, p2G: 6 }, 'Plano': { hpf: 20, lsG: 0, p1G: 0, p2G: 0, p3G: 0, hsG: 0, lpf: 22000 } },
  comp: { 'Voz': { threshold: -20, ratio: 3.5, attack: 0.006, release: 0.12, knee: 6, makeup: 4 }, 'Batería pegada': { threshold: -18, ratio: 6, attack: 0.02, release: 0.08, makeup: 4, mix: 60 }, 'Bajo': { threshold: -22, ratio: 4, attack: 0.01, release: 0.2, makeup: 3 }, 'Bus de mezcla (glue)': { threshold: -14, ratio: 2, attack: 0.03, release: 0.3, knee: 10, makeup: 1 } },
  reverb: { 'Sala pequeña': { size: 0.8, decay: 3, predelay: 0.005, damp: 0.5, mix: 18 }, 'Salón': { size: 3, decay: 2.2, predelay: 0.03, damp: 0.35, mix: 25 }, 'Placa': { size: 2, decay: 3.5, predelay: 0.01, damp: 0.2, mix: 22 }, 'Catedral': { size: 7, decay: 1.6, predelay: 0.06, damp: 0.3, mix: 30 } },
  delay: { 'Slapback': { time: 0.11, sync: 0, feedback: 5, mix: 20 }, 'Corchea': { sync: 8, feedback: 35, mix: 22 }, 'Negra con puntillo ping-pong': { sync: 5.333, feedback: 40, mix: 25, pingpong: 1 } },
  limiter: { 'Streaming −14 LUFS (aprox.)': { gain: 4, ceiling: -1 }, 'Fuerte': { gain: 9, ceiling: -0.3 } }
};

const TEMPLATES = [
  { name: 'Sesión vacía', desc: 'Empieza desde cero.', build: () => { } },
  { name: 'Grabación de banda', desc: '8 pistas de audio, bus de reverb.', tempo: 120, build: (p) => { const aux = newTrack('aux', 'Reverb'); aux.inserts.push({ id: uid('ins'), type: 'reverb', params: { ...defaultParams('reverb'), mix: 100 }, bypass: false }); for (const n of ['Bombo', 'Tarola', 'Overheads', 'Bajo', 'Guitarra 1', 'Guitarra 2', 'Voz', 'Coros']) { const t = newTrack('audio', n); if (/Voz|Coros/.test(n)) t.sends.push({ bus: aux.id, level: -12, pre: false }); p.tracks.push(t); } p.tracks.push(aux); } },
  { name: 'Producción de beat', desc: 'Batería, bajo, pad y lead virtuales.', tempo: 92, build: (p) => { const d = newTrack('instrument', 'Batería'); d.instrument = { type: 'drums', preset: 'Electrónica 808', params: {} }; const b = newTrack('instrument', 'Bajo'); b.instrument = { type: 'synth', preset: 'Bajo sintético', params: {} }; const pad = newTrack('instrument', 'Pad'); pad.instrument = { type: 'synth', preset: 'Pad cálido', params: {} }; const l = newTrack('instrument', 'Lead'); l.instrument = { type: 'synth', preset: 'Lead brillante', params: {} }; p.tracks.push(d, b, pad, l, newTrack('audio', 'Voz')); } },
  { name: 'Podcast', desc: '2 voces, música, cadena master a −16 LUFS.', tempo: 120, build: (p) => { for (const n of ['Locutor 1', 'Locutor 2']) { const t = newTrack('audio', n); t.inserts.push({ id: uid('ins'), type: 'gate', params: defaultParams('gate'), bypass: false }, { id: uid('ins'), type: 'eq7', params: { ...defaultParams('eq7'), hpf: 80 }, bypass: false }, { id: uid('ins'), type: 'comp', params: { ...defaultParams('comp'), threshold: -22, ratio: 3, makeup: 4 }, bypass: false }, { id: uid('ins'), type: 'deesser', params: defaultParams('deesser'), bypass: false }); p.tracks.push(t); } p.tracks.push(newTrack('audio', 'Música'), newTrack('audio', 'Efectos')); p.master.inserts.push({ id: uid('ins'), type: 'limiter', params: { gain: 3, ceiling: -1, release: 0.08 }, bypass: false }); } },
  { name: 'Post-producción de video', desc: 'Pista de video, diálogo, música, efectos, ambientes.', tempo: 120, build: (p) => { const v = newTrack('video', 'Video'); v.height = 60; p.tracks.push(v); for (const n of ['Diálogo', 'Diálogo ADR', 'Foley', 'Efectos', 'Ambientes', 'Música']) p.tracks.push(newTrack('audio', n)); } },
  { name: 'Masterización', desc: 'Una pista estéreo y cadena de master.', tempo: 120, build: (p) => { const t = newTrack('audio', 'Mezcla estéreo'); t.input = 0; p.tracks.push(t); for (const ty of ['eq7', 'comp', 'stereo', 'limiter']) p.master.inserts.push({ id: uid('ins'), type: ty, params: defaultParams(ty), bypass: false }); } }
];

// ---------- IndexedDB (autoguardado) ----------
function idb() { return new Promise((res, rej) => { const r = indexedDB.open('musicos-mx', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
async function idbSet(k, v) { const db = await idb(); return new Promise((res, rej) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, k); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); }
async function idbGet(k) { const db = await idb(); return new Promise((res, rej) => { const tx = db.transaction('kv', 'readonly'); const r = tx.objectStore('kv').get(k); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }

import { parseCommand } from './ai/assistant.js';
import { renderOffline } from './engine/engine.js';
const app = new App();
window.mmx = app;
window.mmxDebug = { parseCommand, renderOffline };
app.start();
