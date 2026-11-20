// Músicos MX — Ventana de Edición: línea de tiempo, pistas, clips, automatización
// Copyright (C) 2026 Santiago Miguel — GNU GPL v3 o posterior.
import { $, h } from './dialogs.js';
import { clipsOf, snapTime, gridSeconds, newMidiClip, splitClip } from '../project.js';
import { fmtBars, fmtMinSec, clamp, dbToGain, uid } from '../util.js';

const RULER_H = 54, EDGE = 7;

export class EditView {
  constructor(app) {
    this.app = app; this.store = app.store; this.engine = app.engine;
    this.pps = 60; // píxeles por segundo
    this.tool = 'smart'; this.mode = 'grid'; this.gridDiv = 16;
    this.sel = { start: 0, end: 0, tracks: new Set() };
    this.follow = true;
    this.scroll = $('#tlScroll'); this.canvas = $('#timeline'); this.ctx = this.canvas.getContext('2d');
    this.ruler = $('#ruler'); this.rctx = this.ruler.getContext('2d');
    this.spacer = $('#tlSpacer'); this.headers = $('#headersInner');
    this.dirty = true;
    this.scroll.addEventListener('scroll', () => { this.dirty = true; this.headers.style.transform = `translateY(${-this.scroll.scrollTop}px)`; });
    new ResizeObserver(() => this.resize()).observe(this.scroll);
    this.canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    this.canvas.addEventListener('pointermove', (e) => { if (!this.drag) this.updateCursor(e); });
    this.canvas.addEventListener('dblclick', (e) => this.onDbl(e));
    this.canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); this.onContext(e); });
    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.ruler.addEventListener('pointerdown', (e) => this.onRulerDown(e));
    this.ruler.addEventListener('dblclick', (e) => { const t = this.xToT(e.offsetX); this.app.addMarker(t); });
    $('#headers').addEventListener('wheel', (e) => { this.scroll.scrollTop += e.deltaY; }, { passive: true });
    this.scroll.addEventListener('dragover', (e) => { e.preventDefault(); });
    this.scroll.addEventListener('drop', (e) => this.onDrop(e));
    this.store.on('change', () => { this.dirty = true; this.buildHeaders(); });
    this.store.on('live', () => { this.dirty = true; });
    this.store.on('assets', () => { this.dirty = true; });
    this.loop();
  }
  // ---------- geometría ----------
  displayTracks() { const ts = this.store.project.tracks.filter(t => !t.hidden); return [...ts.filter(t => t.pinned), ...ts.filter(t => !t.pinned)]; }
  rows() {
    let y = 0; const r = [];
    for (const t of this.displayTracks()) { r.push({ t, y, h: t.height }); y += t.height; }
    return { rows: r, total: y };
  }
  tToX(t) { return t * this.pps - this.scroll.scrollLeft; }
  xToT(x) { return (x + this.scroll.scrollLeft) / this.pps; }
  rowAt(y) { const yy = y + this.scroll.scrollTop; return this.rows().rows.find(r => yy >= r.y && yy < r.y + r.h); }
  snap(t, force) { return (this.mode === 'grid' || force) ? snapTime(this.store.project, t, 'grid', this.gridDiv) : t; }
  resize() {
    const dpr = devicePixelRatio || 1, w = this.scroll.clientWidth, hh = this.scroll.clientHeight;
    this.canvas.width = w * dpr; this.canvas.height = hh * dpr; this.canvas.style.width = w + 'px'; this.canvas.style.height = hh + 'px';
    const rw = this.ruler.parentElement.clientWidth;
    this.ruler.width = rw * dpr; this.ruler.height = RULER_H * dpr;
    this.dirty = true; this.updateSpacer();
  }
  updateSpacer() {
    const len = Math.max(this.store.sessionLength() + 60, 180, this.store.project.loop.end + 30);
    this.spacer.style.width = Math.max(len * this.pps, this.scroll.clientWidth + 10) + 'px';
    this.spacer.style.height = (this.rows().total + 240) + 'px';
  }
  setZoom(pps, anchorT) {
    const x = anchorT !== undefined ? this.tToX(anchorT) : this.scroll.clientWidth / 2;
    const t = anchorT !== undefined ? anchorT : this.xToT(x);
    this.pps = clamp(pps, 0.5, 6000);
    this.updateSpacer();
    this.scroll.scrollLeft = Math.max(0, t * this.pps - x);
    this.dirty = true; this.app.mixDirty = true;
  }
  zoomIn(a) { this.setZoom(this.pps * 1.5, a ?? this.engine.getPosition()); }
  zoomOut(a) { this.setZoom(this.pps / 1.5, a ?? this.engine.getPosition()); }
  zoomFit() { const len = Math.max(10, this.store.sessionLength() + 2); this.setZoom((this.scroll.clientWidth - 20) / len); this.scroll.scrollLeft = 0; }
  scrollToTime(t) { const x = this.tToX(t); if (x < 0 || x > this.scroll.clientWidth - 40) this.scroll.scrollLeft = Math.max(0, t * this.pps - this.scroll.clientWidth * 0.25); }

  // ---------- encabezados de pista ----------
  buildHeaders() {
    const p = this.store.project, cont = this.headers;
    cont.innerHTML = '';
    const { rows } = this.rows();
    for (const r of rows) {
      const t = r.t;
      const el = h('div', { class: 'thead' + (this.store.selectedTrack === t.id ? ' sel' : ''), style: { top: r.y + 'px', height: r.h + 'px', opacity: t.inactive ? 0.5 : 1 } });
      el.append(h('div', { class: 'bar', style: { background: t.color } }));
      const name = h('input', { class: 'tname', value: t.name, spellcheck: 'false' });
      name.addEventListener('change', () => this.store.edit('Renombrar pista', (pp) => { pp.tracks.find(x => x.id === t.id).name = name.value; }));
      name.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') name.blur(); });
      const tb = (cls, label, on, title, fn) => h('button', { class: 'tb ' + cls + (on ? ' on' : ''), title, onclick: (e) => { e.stopPropagation(); fn(e); } }, label);
      const row1 = h('div', { class: 'row' }, name);
      if (t.type === 'audio' || t.type === 'instrument' || t.type === 'midi') row1.append(tb('rec', '●', t.recArm, 'Armar para grabar', () => this.app.toggleTrack(t.id, 'recArm')));
      if (t.type === 'audio') row1.append(tb('mon', 'I', t.monitor, 'Monitorización de entrada', () => this.app.toggleTrack(t.id, 'monitor')));
      if (t.type !== 'video') row1.append(tb('solo', 'S', t.solo, 'Solo (Shift+clic: solo exclusivo)', (e) => this.app.toggleTrack(t.id, 'solo', e.shiftKey)), tb('mute', 'M', t.mute, 'Silenciar', () => this.app.toggleTrack(t.id, 'mute')));
      row1.append(tb('pin', '📌', t.pinned, 'Fijar pista arriba', () => this.app.toggleTrack(t.id, 'pinned')));
      el.append(row1);
      if (r.h >= 54) {
        const row2 = h('div', { class: 'row' }, h('span', { class: 'ttype' }, { audio: 'Audio', instrument: 'Instr.', midi: 'MIDI', aux: 'Aux', video: 'Video' }[t.type]));
        if (t.playlists.length) {
          const pl = h('select', { title: 'Lista de reproducción (tomas)' });
          t.playlists.forEach((x, i) => pl.append(h('option', { value: i, selected: i === t.activePlaylist ? 'selected' : null }, x.name)));
          pl.append(h('option', { value: 'new' }, '+ Nueva vacía'), h('option', { value: 'dup' }, '+ Duplicar'));
          pl.addEventListener('change', () => this.app.playlistAction(t.id, pl.value));
          row2.append(pl);
        }
        if (t.type !== 'video') {
          const view = h('select', { title: 'Vista de pista' });
          [['none', 'Clips'], ['volume', 'Volumen'], ['pan', 'Paneo']].forEach(([v, l]) => view.append(h('option', { value: v, selected: t.showAutomation === v ? 'selected' : null }, l)));
          view.addEventListener('change', () => this.store.edit('Vista de pista', (pp) => { pp.tracks.find(x => x.id === t.id).showAutomation = view.value; }));
          row2.append(view);
        }
        el.append(row2);
      }
      if (r.h >= 80 && t.type !== 'video') {
        const row3 = h('div', { class: 'row' });
        const am = h('select', { title: 'Modo de automatización' });
        [['off', 'Auto: off'], ['read', 'Leer'], ['touch', 'Touch'], ['latch', 'Latch'], ['write', 'Escribir']].forEach(([v, l]) => am.append(h('option', { value: v, selected: t.automationMode === v ? 'selected' : null }, l)));
        am.addEventListener('change', () => this.store.edit('Modo de automatización', (pp) => { pp.tracks.find(x => x.id === t.id).automationMode = am.value; }));
        row3.append(am);
        if (t.type === 'audio') {
          const inp = h('select', { title: 'Entrada' });
          [[1, 'Entrada 1'], [2, 'Entrada 2'], [0, 'Est. 1-2']].forEach(([v, l]) => inp.append(h('option', { value: v, selected: t.input === v ? 'selected' : null }, l)));
          inp.addEventListener('change', () => this.store.edit('Entrada', (pp) => { pp.tracks.find(x => x.id === t.id).input = +inp.value; }));
          row3.append(inp);
        } else if (t.instrument) {
          row3.append(h('button', { class: 'btn small', onclick: () => this.app.instrumentDialog(t.id) }, '🎹 ' + (t.instrument.preset || '').slice(0, 10)));
        }
        el.append(row3);
      }
      const meter = h('div', { class: 'vmeter' }, h('i'));
      el.append(meter); el._meter = meter.firstChild; el._tid = t.id;
      const rz = h('div', { class: 'resize' });
      rz.addEventListener('pointerdown', (e) => {
        e.stopPropagation(); const sy = e.clientY, sh = t.height; this.store.begin();
        const mv = (ev) => { this.store.live(pp => { pp.tracks.find(x => x.id === t.id).height = clamp(sh + ev.clientY - sy, 34, 400); }); this.buildHeaders(); this.updateSpacer(); };
        const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); this.store.commit('Altura de pista'); };
        addEventListener('pointermove', mv); addEventListener('pointerup', up);
      });
      el.append(rz);
      el.addEventListener('pointerdown', () => { this.store.selectedTrack = t.id; $$sel(cont, el); this.app.onTrackSelected?.(t.id); });
      el.addEventListener('contextmenu', (e) => { e.preventDefault(); this.app.trackContextMenu(t.id, e.clientX, e.clientY); });
      cont.append(el);
    }
    this.updateSpacer();
    this.dirty = true;
  }
  updateMeters() {
    const g = this.engine.graph; if (!g) return;
    for (const el of this.headers.children) {
      const tr = g.tracks.get(el._tid); if (!tr || !el._meter) continue;
      const pk = this.engine.peak(tr.analyser);
      const db = pk > 0 ? 20 * Math.log10(pk) : -90;
      el._meter.style.height = clamp((db + 60) / 60 * 100, 0, 100) + '%';
    }
  }

  // ---------- dibujo ----------
  loop() {
    const tick = () => {
      if (this.app.view === 'edit') {
        const playing = this.engine.playing;
        if (playing) {
          const pos = this.engine.getPosition();
          if (this.follow) { const x = this.tToX(pos); if (x > this.scroll.clientWidth * 0.85 || x < 0) this.scroll.scrollLeft = Math.max(0, pos * this.pps - this.scroll.clientWidth * 0.1); }
          this.dirty = true;
        }
        if (this.dirty) { this.draw(); this.drawRuler(); this.dirty = false; }
        if (playing || this.engine.inputNode) this.updateMeters();
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
  draw() {
    const c = this.ctx, dpr = devicePixelRatio || 1, W = this.scroll.clientWidth, H = this.scroll.clientHeight;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(document.body);
    const col = (v) => css.getPropertyValue(v).trim();
    c.fillStyle = col('--bg'); c.fillRect(0, 0, W, H);
    const p = this.store.project, sy = this.scroll.scrollTop;
    const { rows } = this.rows();
    const t0 = this.xToT(0), t1 = this.xToT(W);
    // fondo de pistas
    for (const r of rows) {
      const y = r.y - sy; if (y > H || y + r.h < 0) continue;
      c.fillStyle = this.store.selectedTrack === r.t.id ? '#161b27' : (rows.indexOf(r) % 2 ? '#10131a' : '#0e1117');
      if (document.body.classList.contains('light')) c.fillStyle = rows.indexOf(r) % 2 ? '#e3e7ee' : '#eef1f6';
      c.fillRect(0, y, W, r.h);
      c.fillStyle = col('--line'); c.fillRect(0, y + r.h - 1, W, 1);
    }
    // bucle
    if (p.loop.enabled) { const a = this.tToX(p.loop.start), b = this.tToX(p.loop.end); c.fillStyle = 'rgba(255,181,71,.06)'; c.fillRect(a, 0, b - a, H); }
    // rejilla
    const beat = 60 / p.tempo, bar = beat * p.timeSig[0];
    const g = gridSeconds(p, this.gridDiv);
    const step = g * this.pps < 6 ? (beat * this.pps < 6 ? bar : beat) : g;
    for (let k = Math.floor(t0 / step); k * step <= t1; k++) {
      const t = k * step, x = Math.round(this.tToX(t)) + 0.5;
      const isBar = Math.abs(t / bar - Math.round(t / bar)) < 1e-6, isBeat = Math.abs(t / beat - Math.round(t / beat)) < 1e-6;
      c.strokeStyle = isBar ? 'rgba(140,150,175,.28)' : isBeat ? 'rgba(140,150,175,.13)' : 'rgba(140,150,175,.06)';
      c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke();
    }
    // clips
    for (const r of rows) {
      const y = r.y - sy; if (y > H || y + r.h < 0) continue;
      const t = r.t;
      if (t.type === 'video') { this.drawVideoTrack(c, t, y, r.h, W); continue; }
      const dimmed = t.showAutomation !== 'none';
      for (const cl of clipsOf(t)) {
        const x0 = this.tToX(cl.start), x1 = this.tToX(cl.start + cl.duration);
        if (x1 < 0 || x0 > W) continue;
        this.drawClip(c, t, cl, x0, x1, y + 1, r.h - 3, dimmed);
      }
      if (t.showAutomation !== 'none') this.drawAutomation(c, t, y, r.h, W);
    }
    // selección
    if (this.sel.end > this.sel.start) {
      const a = this.tToX(this.sel.start), b = this.tToX(this.sel.end);
      c.fillStyle = col('--sel');
      for (const r of rows) if (this.sel.tracks.has(r.t.id)) c.fillRect(a, r.y - sy, b - a, r.h - 1);
    }
    // marcadores
    for (const m of p.markers) { const x = this.tToX(m.t); if (x < 0 || x > W) continue; c.strokeStyle = m.color || '#ffd23f'; c.setLineDash([3, 4]); c.beginPath(); c.moveTo(x + .5, 0); c.lineTo(x + .5, H); c.stroke(); c.setLineDash([]); }
    // cursor de inserción / reproducción
    const pos = this.engine.getPosition(), px = Math.round(this.tToX(pos)) + .5;
    c.strokeStyle = this.engine.recording ? '#ff2d55' : this.engine.playing ? '#2ee6c5' : '#e6e9f0';
    c.lineWidth = 1.2; c.beginPath(); c.moveTo(px, 0); c.lineTo(px, H); c.stroke(); c.lineWidth = 1;
    if (this.ghost) { c.strokeStyle = '#ff3d7f'; c.setLineDash([4, 3]); c.strokeRect(this.ghost.x, this.ghost.y, this.ghost.w, this.ghost.h); c.setLineDash([]); }
    if (!rows.length) {
      c.fillStyle = col('--dim'); c.font = '15px system-ui'; c.textAlign = 'center';
      c.fillText('Crea una pista con “+ Pista” (Ctrl+Shift+N) o arrastra archivos de audio/MIDI aquí', W / 2, 120);
      c.textAlign = 'left';
    }
  }
  drawVideoTrack(c, t, y, hh, W) {
    const a = this.store.assets.get(this.store.project.videoAssetId);
    if (!a) { c.fillStyle = '#8b93a7'; c.font = '12px system-ui'; c.fillText('Sin video: Archivo › Importar video…', 10, y + 20); return; }
    const x0 = this.tToX(0), x1 = this.tToX(a.duration || 0);
    c.fillStyle = '#2a2f3d'; c.fillRect(x0, y + 2, x1 - x0, hh - 4);
    for (let x = Math.max(0, x0); x < Math.min(W, x1); x += 60) { c.fillStyle = '#394055'; c.fillRect(x + 2, y + 8, 54, hh - 16); }
    c.fillStyle = '#fff'; c.font = '12px system-ui'; c.fillText('🎬 ' + a.name, Math.max(4, x0 + 6), y + 16);
  }
  drawClip(c, t, cl, x0, x1, y, hh, dimmed) {
    const sel = this.store.selectedClips.has(cl.id);
    const color = cl.color || t.color;
    const w = Math.max(2, x1 - x0);
    c.save();
    c.globalAlpha = dimmed ? 0.45 : (cl.muted ? 0.35 : 1);
    roundRect(c, x0, y, w, hh, 4);
    c.fillStyle = shade(color, -0.55); c.fill();
    c.strokeStyle = sel ? '#ffffff' : shade(color, 0.1); c.lineWidth = sel ? 1.6 : 1; c.stroke();
    c.clip();
    // barra de nombre
    c.fillStyle = shade(color, sel ? 0.15 : -0.1); c.fillRect(x0, y, w, 14);
    c.fillStyle = '#0b0d12'; c.font = '600 10.5px system-ui';
    const label = cl.name + (cl.gain ? `  ${cl.gain > 0 ? '+' : ''}${cl.gain.toFixed(1)} dB` : '') + (cl.rate && cl.rate !== 1 ? `  ×${cl.rate.toFixed(3)}` : '');
    c.fillText(label, Math.max(x0, 0) + 4, y + 10.5);
    const wy = y + 15, wh = hh - 16, mid = wy + wh / 2;
    if (cl.kind === 'audio') {
      const a = this.store.assets.get(cl.assetId);
      if (a && a.peaks) {
        const pk = a.peaks, g = dbToGain(cl.gain || 0), rate = cl.rate || 1;
        c.fillStyle = shade(color, 0.25);
        const xs = Math.max(0, Math.floor(x0)), xe = Math.min(this.scroll.clientWidth, Math.ceil(x1));
        for (let x = xs; x < xe; x++) {
          const tc = (x - x0) / this.pps, ta = cl.offset + tc * rate, tb = cl.offset + (tc + 1 / this.pps) * rate;
          let i0 = Math.floor(ta * pk.sr / pk.spp), i1 = Math.max(i0 + 1, Math.ceil(tb * pk.sr / pk.spp));
          if (i0 >= pk.mins.length) break;
          let mn = 0, mx = 0; for (let i = i0; i < Math.min(i1, pk.mins.length); i++) { if (pk.mins[i] < mn) mn = pk.mins[i]; if (pk.maxs[i] > mx) mx = pk.maxs[i]; }
          let f = 1; if (cl.fadeIn > 0 && tc < cl.fadeIn) f = tc / cl.fadeIn; const te = cl.duration - tc; if (cl.fadeOut > 0 && te < cl.fadeOut) f = Math.min(f, te / cl.fadeOut);
          const s = (wh / 2) * g * f * (this.waveZoom || 1);
          const top = mid - Math.min(wh / 2, mx * s), bot = mid - Math.max(-wh / 2, mn * s);
          c.fillRect(x, top, 1, Math.max(1, bot - top));
        }
      } else { c.fillStyle = '#888'; c.fillText('(audio no disponible)', x0 + 6, mid); }
    } else if (cl.kind === 'midi') {
      const ns = cl.notes; if (ns.length) {
        let lo = 127, hi = 0; for (const n of ns) { lo = Math.min(lo, n.p); hi = Math.max(hi, n.p); }
        const range = Math.max(12, hi - lo + 1), nh = Math.max(1.5, wh / range);
        c.fillStyle = shade(color, 0.3);
        for (const n of ns) { if (n.t >= cl.duration) continue; const nx = x0 + n.t * this.pps, nw = Math.max(1.5, Math.min(n.d, cl.duration - n.t) * this.pps); c.fillRect(nx, wy + (hi - n.p) / range * (wh - nh), nw, nh); }
      }
    }
    // fundidos
    c.strokeStyle = 'rgba(255,255,255,.6)';
    if (cl.fadeIn > 0.01) { const fx = x0 + cl.fadeIn * this.pps; c.beginPath(); c.moveTo(x0, y + hh); c.quadraticCurveTo(x0 + (fx - x0) * 0.3, y + 14, fx, y + 14); c.stroke(); }
    if (cl.fadeOut > 0.01) { const fx = x1 - cl.fadeOut * this.pps; c.beginPath(); c.moveTo(fx, y + 14); c.quadraticCurveTo(x1 - (x1 - fx) * 0.3, y + 14, x1, y + hh); c.stroke(); }
    c.restore();
  }
  drawAutomation(c, t, y, hh, W) {
    const pts = t.automation[t.showAutomation] || [];
    const isVol = t.showAutomation === 'volume';
    const vToY = (v) => isVol ? y + 6 + (1 - volToNorm(v)) * (hh - 12) : y + hh / 2 - v * (hh / 2 - 6);
    c.strokeStyle = isVol ? '#ffd23f' : '#4fa3ff'; c.lineWidth = 1.5; c.beginPath();
    const def = isVol ? t.volume : t.pan;
    if (!pts.length) { const yy = vToY(def); c.moveTo(0, yy); c.lineTo(W, yy); }
    else {
      c.moveTo(0, vToY(pts[0].v));
      for (const pt of pts) c.lineTo(this.tToX(pt.t), vToY(pt.v));
      c.lineTo(W, vToY(pts[pts.length - 1].v));
    }
    c.stroke(); c.lineWidth = 1;
    c.fillStyle = '#fff';
    for (const pt of pts) { const x = this.tToX(pt.t); if (x < -5 || x > W + 5) continue; c.fillRect(x - 3, vToY(pt.v) - 3, 6, 6); }
    c.fillStyle = isVol ? '#ffd23f' : '#4fa3ff'; c.font = '10px system-ui'; c.fillText(isVol ? 'Volumen' : 'Paneo', 6, y + hh - 6);
  }
  drawRuler() {
    const c = this.rctx, dpr = devicePixelRatio || 1, W = this.ruler.width / dpr;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = getComputedStyle(document.body).getPropertyValue('--panel'); c.fillRect(0, 0, W, RULER_H);
    const p = this.store.project, beat = 60 / p.tempo, bar = beat * p.timeSig[0];
    const t0 = this.xToT(0), t1 = this.xToT(W);
    // filas
    c.fillStyle = 'rgba(0,0,0,.18)'; c.fillRect(0, 0, W, 16);
    c.fillStyle = '#5e667a'; c.fillRect(0, 16, W, 1); c.fillRect(0, 36, W, 1);
    // bucle y selección
    if (p.loop.enabled || p.loop.end > p.loop.start) { const a = this.tToX(p.loop.start), b = this.tToX(p.loop.end); c.fillStyle = p.loop.enabled ? '#ffb547' : 'rgba(255,181,71,.3)'; c.fillRect(a, 17, b - a, 5); }
    if (p.punch.enabled) { const a = this.tToX(p.punch.start), b = this.tToX(p.punch.end); c.fillStyle = '#ff2d55'; c.fillRect(a, 31, b - a, 4); }
    if (this.sel.end > this.sel.start) { const a = this.tToX(this.sel.start), b = this.tToX(this.sel.end); c.fillStyle = 'rgba(79,163,255,.35)'; c.fillRect(a, 17, b - a, 19); }
    // compases
    let barStep = 1; while (bar * barStep * this.pps < 60) barStep *= 2;
    c.font = '10.5px ui-monospace, monospace'; c.fillStyle = '#c9cfdb'; c.strokeStyle = '#8b93a7';
    for (let k = Math.max(0, Math.floor(t0 / bar)); k * bar <= t1; k++) {
      const x = Math.round(this.tToX(k * bar)) + .5;
      if (k % barStep === 0) { c.beginPath(); c.moveTo(x, 22); c.lineTo(x, 36); c.stroke(); c.fillText(String(k + 1), x + 3, 32); }
      if (bar * this.pps > 80) for (let b2 = 1; b2 < p.timeSig[0]; b2++) { const xb = Math.round(this.tToX(k * bar + b2 * beat)) + .5; c.beginPath(); c.moveTo(xb, 30); c.lineTo(xb, 36); c.stroke(); }
    }
    // minutos:segundos
    let sStep = 1; for (const s of [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300]) { sStep = s; if (s * this.pps >= 70) break; }
    c.fillStyle = '#8b93a7';
    for (let k = Math.max(0, Math.floor(t0 / sStep)); k * sStep <= t1; k++) { const x = Math.round(this.tToX(k * sStep)) + .5; c.fillRect(x, 46, 1, 8); c.fillText(fmtMinSec(k * sStep).replace(/\.000$/, ''), x + 3, 50); }
    // marcadores
    for (const m of p.markers) { const x = this.tToX(m.t); if (x < -100 || x > W) continue; c.fillStyle = m.color || '#ffd23f'; c.beginPath(); c.moveTo(x, 2); c.lineTo(x + 7, 2); c.lineTo(x + 7, 10); c.lineTo(x, 14); c.fill(); c.fillStyle = '#e6e9f0'; c.fillText(m.name, x + 10, 12); }
    // cabezal
    const x = this.tToX(this.engine.getPosition());
    c.fillStyle = this.engine.recording ? '#ff2d55' : '#2ee6c5'; c.beginPath(); c.moveTo(x - 6, 37); c.lineTo(x + 6, 37); c.lineTo(x, 46); c.fill();
  }

  // ---------- pruebas de impacto ----------
  hitClip(x, y) {
    const r = this.rowAt(y); if (!r) return null;
    const t = this.xToT(x);
    const list = clipsOf(r.t);
    for (let i = list.length - 1; i >= 0; i--) { const c = list[i]; if (t >= c.start && t <= c.start + c.duration) return { track: r.t, clip: c, row: r }; }
    return { track: r.t, row: r, clip: null };
  }
  zoneFor(hit, x, y) {
    if (!hit?.clip) return 'empty';
    const c = hit.clip, x0 = this.tToX(c.start), x1 = this.tToX(c.start + c.duration);
    const yy = y + this.scroll.scrollTop - hit.row.y;
    const tool = this.tool;
    if (tool === 'trim') return x - x0 < (x1 - x0) / 2 ? 'trimL' : 'trimR';
    if (tool === 'grab') return 'move';
    if (tool === 'select') return 'select';
    if (tool === 'smart') {
      if (yy < 16 && x - x0 < 14) return 'fadeIn';
      if (yy < 16 && x1 - x < 14) return 'fadeOut';
      if (x - x0 < EDGE) return 'trimL';
      if (x1 - x < EDGE) return 'trimR';
      return yy < hit.row.h / 2 ? 'select' : 'move';
    }
    return tool;
  }
  updateCursor(e) {
    const hit = this.hitClip(e.offsetX, e.offsetY);
    const z = this.zoneFor(hit, e.offsetX, e.offsetY);
    const cur = { trimL: 'w-resize', trimR: 'e-resize', fadeIn: 'nw-resize', fadeOut: 'ne-resize', move: 'grab', select: 'text', zoom: 'zoom-in', pencil: 'crosshair', scrub: 'ew-resize', empty: this.tool === 'pencil' ? 'crosshair' : this.tool === 'zoom' ? 'zoom-in' : 'text' }[z] || 'default';
    this.canvas.style.cursor = hit?.track?.showAutomation !== 'none' && hit?.track ? 'crosshair' : cur;
  }

  // ---------- interacción ----------
  onWheel(e) {
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); const t = this.xToT(e.offsetX); this.setZoom(this.pps * (e.deltaY < 0 ? 1.15 : 1 / 1.15), t); }
    else if (e.altKey) { e.preventDefault(); this.waveZoom = clamp((this.waveZoom || 1) * (e.deltaY < 0 ? 1.2 : 1 / 1.2), 0.25, 16); this.dirty = true; }
  }
  onRulerDown(e) {
    const t = this.xToT(e.offsetX);
    if (e.offsetY < 16) { // marcadores
      const m = this.store.project.markers.find(m => Math.abs(this.tToX(m.t) - e.offsetX) < 8);
      if (m) { this.engine.setPosition(m.t); this.dirty = true; return; }
    }
    if (e.offsetY >= 16 && e.offsetY < 24) {
      // arrastrar región de bucle
      const s = this.snap(t); this.store.begin();
      const mv = (ev) => { const t2 = this.snap(this.xToT(ev.clientX - this.ruler.getBoundingClientRect().left)); this.store.live(p => { p.loop.start = Math.min(s, t2); p.loop.end = Math.max(s, t2); }); this.dirty = true; };
      const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); this.store.commit('Región de bucle'); this.app.refreshTransport(); };
      addEventListener('pointermove', mv); addEventListener('pointerup', up); return;
    }
    this.engine.setPosition(this.snap(t)); this.dirty = true;
    const mv = (ev) => { const t2 = this.xToT(ev.clientX - this.ruler.getBoundingClientRect().left); if (!this.engine.playing) { this.engine.setPosition(Math.max(0, this.snap(t2))); this.dirty = true; } };
    const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); };
    addEventListener('pointermove', mv); addEventListener('pointerup', up);
  }
  onDown(e) {
    if (e.button === 2) return;
    this.canvas.setPointerCapture(e.pointerId);
    const x = e.offsetX, y = e.offsetY, t = this.xToT(x);
    const hit = this.hitClip(x, y);
    if (hit?.track) { this.store.selectedTrack = hit.track.id; }
    const tool = this.tool;
    if (tool === 'zoom') { e.altKey ? this.zoomOut(t) : this.zoomIn(t); return; }
    if (hit?.track && hit.track.showAutomation !== 'none') return this.automationDown(e, hit);
    if (tool === 'scrub') return this.scrubDown(e);
    if (tool === 'pencil') return this.pencilDown(e, hit, t);
    const zone = this.zoneFor(hit, x, y);
    if (zone === 'select' || zone === 'empty') return this.selectDown(e, hit, t);
    if (zone === 'move') {
      if (this.mode === 'spot') { this.app.spotClip(hit.clip.id); return; }
      return this.moveDown(e, hit, t);
    }
    if (zone === 'trimL' || zone === 'trimR') return this.trimDown(e, hit, zone);
    if (zone === 'fadeIn' || zone === 'fadeOut') return this.fadeDown(e, hit, zone);
  }
  selectDown(e, hit, t) {
    const startRow = hit?.row; const st = e.shiftKey && this.sel.end > this.sel.start ? (Math.abs(t - this.sel.start) < Math.abs(t - this.sel.end) ? this.sel.end : this.sel.start) : this.snap(t);
    if (!e.shiftKey) this.store.selectedClips.clear();
    if (hit?.clip && !e.shiftKey) this.store.selectedClips.add(hit.clip.id);
    let moved = false;
    const rows = this.rows().rows;
    const mv = (ev) => {
      const r = this.canvas.getBoundingClientRect();
      const t2 = this.snap(this.xToT(ev.clientX - r.left));
      if (Math.abs(ev.clientX - e.clientX) > 3) moved = true;
      const yy = ev.clientY - r.top + this.scroll.scrollTop;
      const r2 = rows.find(rr => yy >= rr.y && yy < rr.y + rr.h) || (yy < 0 ? rows[0] : rows[rows.length - 1]);
      const i0 = rows.indexOf(startRow), i1 = rows.indexOf(r2);
      this.sel.tracks = new Set(rows.slice(Math.min(i0, i1), Math.max(i0, i1) + 1).map(x => x.t.id));
      this.sel.start = Math.max(0, Math.min(st, t2)); this.sel.end = Math.max(st, t2);
      if (!this.engine.playing) this.engine.position = this.sel.start;
      this.dirty = true; this.app.updateSelInfo();
    };
    const up = () => {
      removeEventListener('pointermove', mv); removeEventListener('pointerup', up);
      if (!moved && !e.shiftKey) {
        this.sel = { start: st, end: st, tracks: new Set(startRow ? [startRow.t.id] : []) };
        this.engine.setPosition(st);
      }
      this.dirty = true; this.app.updateSelInfo(); this.app.buildMixer?.();
    };
    addEventListener('pointermove', mv); addEventListener('pointerup', up);
  }
  moveDown(e, hit, t) {
    const sc = this.store.selectedClips;
    if (!sc.has(hit.clip.id)) { if (!e.shiftKey) sc.clear(); sc.add(hit.clip.id); }
    else if (e.shiftKey) { sc.delete(hit.clip.id); this.dirty = true; return; }
    this.dirty = true;
    const dup = e.altKey;
    this.store.begin();
    let moving = [...sc].map(id => this.store.findClip(id)).filter(Boolean);
    if (dup) {
      // Alt+arrastrar duplica
      this.store.live(() => { moving = moving.map(m => { const c = JSON.parse(JSON.stringify(m.clip)); c.id = uid('clp'); m.playlist.clips.push(c); return { ...m, clip: c }; }); });
      sc.clear(); moving.forEach(m => sc.add(m.clip.id));
    }
    const orig = moving.map(m => ({ id: m.clip.id, start: m.clip.start, trackId: m.track.id }));
    const rows = this.rows().rows; const r0 = rows.indexOf(hit.row);
    const anchorStart = hit.clip.start;
    const mv = (ev) => {
      const r = this.canvas.getBoundingClientRect();
      const t2 = this.xToT(ev.clientX - r.left);
      let d = t2 - t;
      if (ev.shiftKey && !e.shiftKey) d = 0; // restringir vertical
      let ns = anchorStart + d;
      if (this.mode === 'grid') ns = this.snap(ns);
      if (this.mode === 'shuffle') ns = this.shuffleSnap(hit.track, hit.clip, ns);
      d = Math.max(-Math.min(...orig.map(o => o.start)), ns - anchorStart);
      const yy = ev.clientY - r.top + this.scroll.scrollTop;
      const ri = rows.findIndex(rr => yy >= rr.y && yy < rr.y + rr.h);
      const dRow = ri >= 0 ? ri - r0 : 0;
      this.store.live(p => {
        for (const o of orig) {
          const f = this.store.findClip(o.id); if (!f) continue;
          f.clip.start = Math.max(0, o.start + d);
          const srcIdx = rows.findIndex(rr => rr.t.id === o.trackId);
          const target = rows[clamp(srcIdx + dRow, 0, rows.length - 1)]?.t;
          if (target && target.id !== f.track.id && compatible(target, f.clip) && target.playlists[target.activePlaylist]) {
            f.playlist.clips.splice(f.playlist.clips.indexOf(f.clip), 1);
            target.playlists[target.activePlaylist].clips.push(f.clip);
          }
        }
      });
      this.dirty = true;
    };
    const up = () => {
      removeEventListener('pointermove', mv); removeEventListener('pointerup', up);
      this.store.live(p => { for (const tr of p.tracks) for (const pl of tr.playlists) pl.clips.sort((a, b) => a.start - b.start); });
      this.store.commit(dup ? 'Duplicar clip' : 'Mover clip');
      if (!this.engine.playing) this.engine.setPosition(this.snap(t));
    };
    addEventListener('pointermove', mv); addEventListener('pointerup', up);
  }
  shuffleSnap(track, clip, ns) {
    // En Shuffle el clip se pega al borde del clip vecino más cercano
    const others = clipsOf(track).filter(c => c !== clip);
    let best = ns, bd = Infinity;
    for (const o of others) for (const edge of [o.start + o.duration, o.start - clip.duration]) { const d = Math.abs(edge - ns); if (d < bd) { bd = d; best = edge; } }
    if (!others.length) best = 0;
    return Math.max(0, best);
  }
  trimDown(e, hit, zone) {
    const c = hit.clip; this.store.begin();
    const o = { start: c.start, dur: c.duration, off: c.offset, notes: c.notes ? JSON.parse(JSON.stringify(c.notes)) : null };
    const asset = this.store.assets.get(c.assetId);
    const maxLen = c.kind === 'audio' && asset ? (asset.buffer.duration - c.offset) / (c.rate || 1) : 1e9;
    const following = this.mode === 'shuffle' ? clipsOf(hit.track).filter(x => x.start >= o.start + o.dur - 1e-6 && x !== c).map(x => ({ x, s: x.start })) : [];
    const mv = (ev) => {
      const r = this.canvas.getBoundingClientRect();
      const t2 = this.snap(this.xToT(ev.clientX - r.left));
      this.store.live(() => {
        if (zone === 'trimR') {
          c.duration = clamp(t2 - o.start, 0.01, c.kind === 'audio' ? maxLen : 1e9);
          following.forEach(f => f.x.start = f.s + (c.duration - o.dur));
        } else {
          const minStart = c.kind === 'audio' ? o.start - o.off / (c.rate || 1) : 0;
          const ns = clamp(t2, Math.max(0, minStart), o.start + o.dur - 0.01);
          const d = ns - o.start;
          c.start = ns; c.duration = o.dur - d;
          if (c.kind === 'audio') c.offset = o.off + d * (c.rate || 1);
          else c.notes = o.notes.map(n => ({ ...n, t: n.t - d })).filter(n => n.t >= 0);
        }
      });
      this.dirty = true;
    };
    const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); this.store.commit('Recortar clip'); };
    addEventListener('pointermove', mv); addEventListener('pointerup', up);
  }
  fadeDown(e, hit, zone) {
    const c = hit.clip; this.store.begin();
    const mv = (ev) => {
      const r = this.canvas.getBoundingClientRect();
      const t2 = this.xToT(ev.clientX - r.left);
      this.store.live(() => {
        if (zone === 'fadeIn') c.fadeIn = clamp(t2 - c.start, 0, c.duration - c.fadeOut);
        else c.fadeOut = clamp(c.start + c.duration - t2, 0, c.duration - c.fadeIn);
      });
      this.dirty = true;
    };
    const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); this.store.commit('Fundido'); };
    addEventListener('pointermove', mv); addEventListener('pointerup', up);
  }
  automationDown(e, hit) {
    const t = hit.track, param = t.showAutomation, isVol = param === 'volume';
    const y0 = hit.row.y - this.scroll.scrollTop, hh = hit.row.h;
    const yToV = (y) => { const n = clamp((y - y0 - 6) / (hh - 12), 0, 1); return isVol ? normToVol(1 - n) : clamp((y0 + hh / 2 - y) / (hh / 2 - 6), -1, 1); };
    const vToY = (v) => isVol ? y0 + 6 + (1 - volToNorm(v)) * (hh - 12) : y0 + hh / 2 - v * (hh / 2 - 6);
    const tr = this.store.track(t.id);
    this.store.begin();
    let pts = tr.automation[param];
    const tt = this.xToT(e.offsetX);
    let pt = pts.find(p => Math.abs(this.tToX(p.t) - e.offsetX) < 6 && Math.abs(vToY(p.v) - e.offsetY) < 6);
    if (pt && e.altKey) { pts.splice(pts.indexOf(pt), 1); this.store.commit('Borrar punto'); this.dirty = true; this.engine.rebuild(); return; }
    if (!pt) {
      if (!pts.length) pts.push({ t: 0, v: isVol ? t.volume : t.pan });
      pt = { t: this.snap(tt), v: this.tool === 'pencil' ? yToV(e.offsetY) : valueAtPts(pts, tt) };
      pts.push(pt); pts.sort((a, b) => a.t - b.t);
    }
    const pencil = this.tool === 'pencil';
    let lastT = pt.t;
    const mv = (ev) => {
      const r = this.canvas.getBoundingClientRect(); const x = ev.clientX - r.left, y = ev.clientY - r.top;
      this.store.live(() => {
        if (pencil) {
          // dibujo libre
          const nt = this.xToT(x); if (Math.abs(nt - lastT) * this.pps < 4) return;
          for (let i = pts.length - 1; i >= 0; i--) if (pts[i].t > Math.min(lastT, nt) && pts[i].t < Math.max(lastT, nt)) pts.splice(i, 1);
          pts.push({ t: Math.max(0, nt), v: yToV(y) }); lastT = nt; pts.sort((a, b) => a.t - b.t);
        } else { pt.t = Math.max(0, this.snap(this.xToT(x))); pt.v = yToV(y); pts.sort((a, b) => a.t - b.t); }
      });
      this.dirty = true;
      this.app.setStatus((isVol ? 'Volumen ' + pt.v.toFixed(1) + ' dB' : 'Paneo ' + Math.round(pt.v * 100)) + ' @ ' + fmtMinSec(pt.t));
    };
    const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); this.store.commit('Automatización'); this.engine.rebuild(); };
    addEventListener('pointermove', mv); addEventListener('pointerup', up);
  }
  pencilDown(e, hit, t) {
    if (!hit?.track) return;
    const tr = hit.track;
    if (hit.clip?.kind === 'midi') { this.app.openPianoRoll(hit.clip.id); return; }
    if (tr.type === 'instrument' || tr.type === 'midi') {
      const p = this.store.project, bar = 60 / p.tempo * p.timeSig[0];
      const st = Math.floor(t / bar) * bar;
      const clip = this.store.edit('Crear clip MIDI', (pp) => { const c = newMidiClip(st, bar, [], 'MIDI'); pp.tracks.find(x => x.id === tr.id).playlists[tr.activePlaylist].clips.push(c); return c; });
      this.app.openPianoRoll(clip.id);
    }
  }
  scrubDown(e) {
    let last = this.xToT(e.offsetX);
    const mv = async (ev) => {
      const r = this.canvas.getBoundingClientRect(); const t = this.xToT(ev.clientX - r.left);
      const hit = this.hitClip(ev.clientX - r.left, ev.clientY - r.top);
      this.engine.position = Math.max(0, t); this.dirty = true;
      if (hit?.clip?.kind === 'audio' && Math.abs(t - last) > 0.02) {
        const a = this.store.assets.get(hit.clip.assetId); if (!a) return;
        const sr = a.buffer.sampleRate, from = Math.floor((hit.clip.offset + (t - hit.clip.start)) * sr), n = Math.floor(sr * 0.07);
        await this.engine.init();
        const b = this.engine.ctx.createBuffer(a.buffer.numberOfChannels, n, sr);
        for (let ch = 0; ch < b.numberOfChannels; ch++) b.copyToChannel(a.buffer.getChannelData(ch).subarray(from, from + n), ch);
        this.engine.preview(b); last = t;
      }
    };
    const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); this.engine.emit('position', this.engine.position); };
    addEventListener('pointermove', mv); addEventListener('pointerup', up);
  }
  onDbl(e) {
    const hit = this.hitClip(e.offsetX, e.offsetY);
    if (hit?.clip?.kind === 'midi') this.app.openPianoRoll(hit.clip.id);
    else if (hit?.clip) { this.sel = { start: hit.clip.start, end: hit.clip.start + hit.clip.duration, tracks: new Set([hit.track.id]) }; this.dirty = true; this.app.updateSelInfo(); }
  }
  onContext(e) {
    const hit = this.hitClip(e.offsetX, e.offsetY);
    if (hit?.clip) {
      if (!this.store.selectedClips.has(hit.clip.id)) { this.store.selectedClips.clear(); this.store.selectedClips.add(hit.clip.id); this.dirty = true; }
      this.app.clipContextMenu(hit.clip.id, e.clientX, e.clientY, this.xToT(e.offsetX));
    } else if (hit?.track) this.app.trackContextMenu(hit.track.id, e.clientX, e.clientY);
  }
  async onDrop(e) {
    e.preventDefault();
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const t = this.snap(this.xToT(x)); const row = this.rowAt(y);
    const assetId = e.dataTransfer.getData('text/mmx-asset');
    if (assetId) return this.app.placeAsset(assetId, row?.t?.id, t);
    if (e.dataTransfer.files.length) return this.app.importFiles([...e.dataTransfer.files], row?.t?.id, t);
  }
  // utilidades para comandos
  selectedRange() { return this.sel.end > this.sel.start ? { start: this.sel.start, end: this.sel.end, tracks: [...this.sel.tracks] } : null; }
  splitAtCursor() {
    const t = this.engine.getPosition();
    const sel = this.selectedRange();
    this.store.edit('Dividir clip', (p) => {
      const ids = new Set(this.store.selectedClips);
      for (const tr of p.tracks) {
        const clips = clipsOf(tr);
        for (const c of clips.slice()) {
          if (sel && sel.tracks.includes(tr.id)) { if (c.start < sel.end && c.start + c.duration > sel.start) { splitClip(clips, c, sel.end); splitClip(clips, c, sel.start); } }
          else if (!sel && (ids.has(c.id) || (ids.size === 0 && this.store.selectedTrack === tr.id))) splitClip(clips, c, t);
        }
      }
    });
  }
}

function compatible(track, clip) { return clip.kind === 'audio' ? track.type === 'audio' : (track.type === 'instrument' || track.type === 'midi'); }
function $$sel(cont, el) { for (const c of cont.children) c.classList.toggle('sel', c === el); }
function roundRect(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
export function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16); let r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  if (amt < 0) { r *= 1 + amt; g *= 1 + amt; b *= 1 + amt; } else { r += (255 - r) * amt; g += (255 - g) * amt; b += (255 - b) * amt; }
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}
// escala de fader: 0..1 <-> dB (-inf..+12)
export function volToNorm(db) { if (db <= -60) return Math.max(0, (db + 90) / 30 * 0.1); if (db <= 0) return 0.1 + (db + 60) / 60 * 0.75 * (1 - 0.0) - 0; return 0.85 + db / 12 * 0.15; }
export function normToVol(n) { if (n <= 0.1) return n / 0.1 * 30 - 90; if (n <= 0.85) return (n - 0.1) / 0.75 * 60 - 60; return (n - 0.85) / 0.15 * 12; }
function valueAtPts(pts, t) { if (!pts.length) return 0; if (t <= pts[0].t) return pts[0].v; for (let i = 1; i < pts.length; i++) if (t <= pts[i].t) { const a = pts[i - 1], b = pts[i]; return a.v + (b.v - a.v) * (t - a.t) / Math.max(1e-9, b.t - a.t); } return pts[pts.length - 1].v; }
