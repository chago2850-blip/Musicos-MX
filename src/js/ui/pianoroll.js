// Músicos MX — Editor MIDI (rollo de piano), carril de velocidad y teclado virtual
// Copyright (C) 2026 Santiago Miguel — GNU GPL v3 o posterior.
import { $, h } from './dialogs.js';
import { noteName, clamp } from '../util.js';
import { quantizeNotes, humanize, SCALES, KEYS } from '../ai/ai.js';
import { DRUM_MAP } from '../engine/instruments.js';

const KW = 56;
const COMPUTER_KEYS = { a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12, o: 13, l: 14, p: 15, 'ñ': 16, ';': 16 };

export class PianoRoll {
  constructor(app) {
    this.app = app; this.store = app.store; this.engine = app.engine;
    this.clipId = null; this.nh = 13; this.pps = 160; this.scrollX = 0; this.scrollY = (127 - 84) * 13;
    this.tool = 'select'; this.gridDiv = 16; this.selNotes = new Set(); this.octave = 4;
    this.roll = $('#roll'); this.vel = $('#vel');
    this.buildBar(); this.buildKeys();
    new ResizeObserver(() => this.draw()).observe(this.roll.parentElement);
    this.roll.addEventListener('pointerdown', (e) => this.onDown(e));
    this.roll.addEventListener('dblclick', (e) => this.onDbl(e));
    this.roll.addEventListener('wheel', (e) => { e.preventDefault(); if (e.ctrlKey || e.metaKey) this.pps = clamp(this.pps * (e.deltaY < 0 ? 1.15 : 0.87), 20, 2000); else if (e.shiftKey) this.scrollX = Math.max(0, this.scrollX + e.deltaY); else { this.scrollY = clamp(this.scrollY + e.deltaY, 0, 128 * this.nh - this.roll.clientHeight); this.scrollX = Math.max(0, this.scrollX + e.deltaX); } this.draw(); }, { passive: false });
    this.vel.addEventListener('pointerdown', (e) => this.onVelDown(e));
    this.store.on('change', () => { if (this.app.view === 'midi') this.draw(); });
    this.held = new Set();
    addEventListener('keydown', (e) => this.onKey(e, true));
    addEventListener('keyup', (e) => this.onKey(e, false));
  }
  get found() { return this.clipId ? this.store.findClip(this.clipId) : null; }
  open(clipId) { this.clipId = clipId; this.selNotes.clear(); const f = this.found; if (f && f.clip.notes.length) { const avg = f.clip.notes.reduce((a, n) => a + n.p, 0) / f.clip.notes.length; this.scrollY = clamp((127 - avg) * this.nh - 200, 0, 128 * this.nh); } this.refreshBar(); this.draw(); }
  buildBar() {
    const bar = $('#midiBar');
    const tools = h('div', { class: 'seg' });
    for (const [t, l] of [['select', '↖ Seleccionar'], ['pencil', '✎ Lápiz'], ['erase', '⌫ Borrar']]) tools.append(h('button', { 'data-t': t, class: t === this.tool ? 'on' : '', onclick: () => { this.tool = t; [...tools.children].forEach(b => b.classList.toggle('on', b.dataset.t === t)); } }, l));
    const grid = h('select', {}); [[4, '1/4'], [8, '1/8'], [16, '1/16'], [32, '1/32'], [12, '1/8T'], [24, '1/16T']].forEach(([v, l]) => grid.append(h('option', { value: v, selected: v === 16 ? 'selected' : null }, l)));
    grid.addEventListener('change', () => { this.gridDiv = +grid.value; this.draw(); });
    this.clipLabel = h('b', {}, 'Sin clip MIDI');
    const btn = (l, f, title) => h('button', { class: 'btn small', onclick: f, title }, l);
    bar.append(this.clipLabel, tools, h('span', { class: 'lbl' }, 'Rejilla'), grid,
      btn('Cuantizar', () => this.quantize(), 'Ajusta las notas seleccionadas (o todas) a la rejilla'),
      btn('Humanizar', () => this.apply('Humanizar', ns => humanize(ns)), 'Variaciones sutiles de tiempo y fuerza'),
      btn('−8va', () => this.apply('Transponer', ns => ns.map(n => ({ ...n, p: clamp(n.p - 12, 0, 127) })))),
      btn('−1', () => this.apply('Transponer', ns => ns.map(n => ({ ...n, p: clamp(n.p - 1, 0, 127) })))),
      btn('+1', () => this.apply('Transponer', ns => ns.map(n => ({ ...n, p: clamp(n.p + 1, 0, 127) })))),
      btn('+8va', () => this.apply('Transponer', ns => ns.map(n => ({ ...n, p: clamp(n.p + 12, 0, 127) })))),
      btn('Legato', () => this.legato()),
      btn('Velocidad…', () => this.setVelocity()),
      btn('A escala', () => this.toScale(), 'Mueve las notas fuera de la tonalidad a la nota más cercana de la escala'),
      btn('Todo', () => { const f = this.found; if (f) { f.clip.notes.forEach((_, i) => this.selNotes.add(i)); this.draw(); } }),
      btn('Exportar .mid', () => this.app.exportMidiClip(this.clipId)),
      btn('↩ Edición', () => this.app.setView('edit')));
  }
  refreshBar() {
    const f = this.found;
    this.clipLabel.textContent = f ? `${f.track.name} › ${f.clip.name}` : 'Abre un clip MIDI (doble clic en un clip de instrumento)';
  }
  buildKeys() {
    const k = $('#vkeys'); k.innerHTML = '';
    for (let n = 36; n <= 96; n++) {
      const blk = [1, 3, 6, 8, 10].includes(n % 12);
      const el = h('div', { class: 'vk' + (blk ? ' blk' : ''), 'data-n': n }, !blk && n % 12 === 0 ? h('span', {}, 'C' + (n / 12 - 1)) : null);
      el.addEventListener('pointerdown', (e) => { e.preventDefault(); this.play(n, true); el.classList.add('on'); const up = () => { this.play(n, false); el.classList.remove('on'); removeEventListener('pointerup', up); }; addEventListener('pointerup', up); });
      k.append(el);
    }
  }
  targetTrack() { const f = this.found; if (f) return f.track.id; const t = this.store.track(this.store.selectedTrack); return t && t.instrument ? t.id : this.store.project.tracks.find(x => x.instrument)?.id; }
  play(n, on) { const id = this.targetTrack(); if (!id) return; if (on) { this.engine.init().then(() => this.engine.noteOn(id, n, 100)); } else this.engine.noteOff(id, n); }
  onKey(e, down) {
    if (this.app.view !== 'midi' || e.ctrlKey || e.metaKey || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    const k = e.key.toLowerCase();
    if (down && k === 'z') { this.octave = Math.max(0, this.octave - 1); this.app.setStatus('Octava del teclado: ' + this.octave); return; }
    if (down && k === 'x') { this.octave = Math.min(8, this.octave + 1); this.app.setStatus('Octava del teclado: ' + this.octave); return; }
    if ((k === 'delete' || k === 'backspace') && down && this.selNotes.size) { this.apply('Borrar notas', (ns, sel) => ns.filter((_, i) => !sel.has(i)), true); this.selNotes.clear(); e.preventDefault(); e.stopImmediatePropagation(); return; }
    if (COMPUTER_KEYS[k] === undefined) return;
    const n = (this.octave + 1) * 12 + COMPUTER_KEYS[k];
    if (down) { if (this.held.has(n)) return; this.held.add(n); this.play(n, true); } else { this.held.delete(n); this.play(n, false); }
    document.querySelector(`.vk[data-n="${n}"]`)?.classList.toggle('on', down);
    e.preventDefault(); e.stopImmediatePropagation();
  }
  apply(label, fn, all = false) {
    const f = this.found; if (!f) return;
    this.store.edit(label, () => {
      const c = this.store.findClip(this.clipId).clip;
      if (all || !this.selNotes.size) { c.notes = fn(c.notes, this.selNotes); return; }
      const idx = [...this.selNotes]; const sub = fn(idx.map(i => c.notes[i]));
      idx.forEach((i, k) => { c.notes[i] = sub[k]; });
    });
    this.draw();
  }
  grid() { return 60 / this.store.project.tempo * 4 / this.gridDiv; }
  quantize() { const g = this.grid(); this.apply('Cuantizar', ns => quantizeNotes(ns, g, 1, 0)); }
  legato() { this.apply('Legato', ns => { const s = ns.map((n, i) => ({ n, i })).sort((a, b) => a.n.t - b.n.t); const out = ns.slice(); s.forEach((x, k) => { const nx = s.slice(k + 1).find(y => y.n.t > x.n.t + 1e-4); if (nx) out[x.i] = { ...x.n, d: nx.n.t - x.n.t }; }); return out; }, true); }
  async setVelocity() { const v = await this.app.prompt('Velocidad', 'Nueva velocidad (1–127):', '100'); if (v) this.apply('Velocidad', ns => ns.map(n => ({ ...n, v: clamp(+v, 1, 127) }))); }
  toScale() {
    const p = this.store.project, root = KEYS.indexOf(p.key), sc = SCALES[p.scale] || SCALES.mayor;
    this.apply('A escala', ns => ns.map(n => { let best = n.p, bd = 99; for (let d = -2; d <= 2; d++) { const pc = ((n.p + d - root) % 12 + 12) % 12; if (sc.includes(pc) && Math.abs(d) < bd) { bd = Math.abs(d); best = n.p + d; } } return { ...n, p: best }; }));
  }
  // ---------- geometría ----------
  tToX(t) { return KW + t * this.pps - this.scrollX; }
  xToT(x) { return (x - KW + this.scrollX) / this.pps; }
  pToY(p) { return (127 - p) * this.nh - this.scrollY; }
  yToP(y) { return 127 - Math.floor((y + this.scrollY) / this.nh); }
  snap(t) { const g = this.grid(); return Math.round(t / g) * g; }
  draw() {
    if (this.app.view !== 'midi') return;
    const cv = this.roll, dpr = devicePixelRatio || 1, W = cv.parentElement.clientWidth, H = cv.parentElement.clientHeight;
    cv.width = W * dpr; cv.height = H * dpr; const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = '#0e1117'; c.fillRect(0, 0, W, H);
    const p = this.store.project, root = KEYS.indexOf(p.key), sc = SCALES[p.scale] || SCALES.mayor;
    const f = this.found; const isDrum = f?.track.instrument?.type === 'drums';
    for (let n = 0; n < 128; n++) {
      const y = this.pToY(n); if (y > H || y + this.nh < 0) continue;
      const blk = [1, 3, 6, 8, 10].includes(n % 12), inScale = sc.includes(((n - root) % 12 + 12) % 12);
      c.fillStyle = blk ? '#0b0d12' : (inScale ? '#141924' : '#11141b'); c.fillRect(KW, y, W, this.nh);
      c.fillStyle = '#1b2030'; c.fillRect(KW, y + this.nh - 1, W, 1);
      c.fillStyle = blk ? '#222' : '#ddd'; c.fillRect(0, y, KW - 2, this.nh - 1);
      if (n % 12 === 0 || isDrum) { c.fillStyle = blk ? '#aaa' : '#333'; c.font = '9px system-ui'; c.fillText(isDrum ? (DRUM_MAP[n] || noteName(n)).slice(0, 11) : noteName(n), 3, y + this.nh - 3); }
    }
    if (!f) { c.fillStyle = '#8b93a7'; c.font = '14px system-ui'; c.fillText('Selecciona o crea un clip MIDI: herramienta Lápiz ✎ sobre una pista de instrumento, o doble clic en un clip MIDI.', KW + 20, 40); this.drawVel(); return; }
    const clip = f.clip, beat = 60 / p.tempo, g = this.grid();
    for (let t = Math.floor(this.xToT(KW) / g) * g; this.tToX(t) < W; t += g) {
      if (t < 0) continue; const x = Math.round(this.tToX(t)) + .5, isBar = Math.abs(t / (beat * p.timeSig[0]) - Math.round(t / (beat * p.timeSig[0]))) < 1e-6, isBeat = Math.abs(t / beat - Math.round(t / beat)) < 1e-6;
      c.strokeStyle = isBar ? 'rgba(160,170,200,.35)' : isBeat ? 'rgba(160,170,200,.16)' : 'rgba(160,170,200,.06)'; c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke();
    }
    const ex = this.tToX(clip.duration); c.fillStyle = 'rgba(0,0,0,.4)'; c.fillRect(ex, 0, W, H);
    clip.notes.forEach((n, i) => {
      const x = this.tToX(n.t), y = this.pToY(n.p), w = Math.max(3, n.d * this.pps);
      if (x > W || x + w < KW || y > H || y < -this.nh) return;
      const sel = this.selNotes.has(i);
      c.fillStyle = sel ? '#ffffff' : `hsl(${330 - n.v}, 85%, ${45 + n.v / 8}%)`;
      c.fillRect(x, y + 1, w, this.nh - 2); c.strokeStyle = '#000'; c.strokeRect(x + .5, y + 1.5, w - 1, this.nh - 3);
    });
    // cabezal
    const pos = this.engine.getPosition() - clip.start; const px = this.tToX(pos);
    if (px > KW) { c.strokeStyle = '#2ee6c5'; c.beginPath(); c.moveTo(px, 0); c.lineTo(px, H); c.stroke(); }
    if (this.box) { c.strokeStyle = '#4fa3ff'; c.strokeRect(this.box.x, this.box.y, this.box.w, this.box.h); }
    this.drawVel();
  }
  drawVel() {
    const cv = this.vel, dpr = devicePixelRatio || 1, W = cv.parentElement.clientWidth, H = cv.parentElement.clientHeight;
    cv.width = W * dpr; cv.height = H * dpr; const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = '#10131a'; c.fillRect(0, 0, W, H); c.fillStyle = '#8b93a7'; c.font = '10px system-ui'; c.fillText('Velocidad', 4, 12);
    const f = this.found; if (!f) return;
    f.clip.notes.forEach((n, i) => { const x = this.tToX(n.t); if (x < KW || x > W) return; const hh = n.v / 127 * (H - 6); c.fillStyle = this.selNotes.has(i) ? '#fff' : `hsl(${330 - n.v}, 85%, 60%)`; c.fillRect(x, H - hh, 4, hh); });
  }
  hitNote(x, y) {
    const f = this.found; if (!f) return -1;
    const p = this.yToP(y), t = this.xToT(x);
    for (let i = f.clip.notes.length - 1; i >= 0; i--) { const n = f.clip.notes[i]; if (n.p === p && t >= n.t && t <= n.t + n.d) return i; }
    return -1;
  }
  onDown(e) {
    const f = this.found; if (!f) return;
    const r = this.roll.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    if (x < KW) { const p = this.yToP(y); this.play(p, true); setTimeout(() => this.play(p, false), 300); return; }
    let i = this.hitNote(x, y);
    if (this.tool === 'erase') { if (i >= 0) { this.selNotes.clear(); this.store.edit('Borrar nota', () => { f.clip.notes.splice(i, 1); }); this.draw(); } return; }
    if (i < 0 && this.tool === 'pencil') {
      const t = Math.max(0, Math.floor(this.xToT(x) / this.grid()) * this.grid()), p = this.yToP(y);
      this.store.edit('Añadir nota', () => { f.clip.notes.push({ p, t, d: this.grid(), v: 100 }); if (t + this.grid() > f.clip.duration) f.clip.duration = Math.ceil((t + this.grid()) / (60 / this.store.project.tempo * 4)) * (60 / this.store.project.tempo * 4); });
      i = f.clip.notes.length - 1; this.selNotes = new Set([i]); this.play(p, true); setTimeout(() => this.play(p, false), 200);
    }
    if (i < 0) { // selección por caja
      if (!e.shiftKey) this.selNotes.clear();
      const sx = x, sy = y;
      const mv = (ev) => { const x2 = ev.clientX - r.left, y2 = ev.clientY - r.top; this.box = { x: Math.min(sx, x2), y: Math.min(sy, y2), w: Math.abs(x2 - sx), h: Math.abs(y2 - sy) }; this.draw(); };
      const up = () => {
        removeEventListener('pointermove', mv); removeEventListener('pointerup', up);
        if (this.box) { const b = this.box; f.clip.notes.forEach((n, k) => { const nx = this.tToX(n.t), ny = this.pToY(n.p); if (nx + n.d * this.pps > b.x && nx < b.x + b.w && ny + this.nh > b.y && ny < b.y + b.h) this.selNotes.add(k); }); }
        this.box = null; this.draw();
      };
      addEventListener('pointermove', mv); addEventListener('pointerup', up); return;
    }
    if (!this.selNotes.has(i)) { if (!e.shiftKey) this.selNotes.clear(); this.selNotes.add(i); }
    const n0 = f.clip.notes[i];
    const resize = x > this.tToX(n0.t + n0.d) - 6;
    const orig = [...this.selNotes].map(k => ({ k, ...f.clip.notes[k] }));
    const st = this.xToT(x), sp = this.yToP(y);
    this.store.begin(); let lastP = n0.p;
    const mv = (ev) => {
      const x2 = ev.clientX - r.left, y2 = ev.clientY - r.top;
      const dt = this.snap(this.xToT(x2) - st), dp = this.yToP(y2) - sp;
      this.store.live(() => {
        for (const o of orig) {
          const n = f.clip.notes[o.k];
          if (resize) n.d = Math.max(this.grid() / 4, this.snap(o.d + dt) || this.grid());
          else { n.t = Math.max(0, o.t + dt); n.p = clamp(o.p + dp, 0, 127); }
        }
      });
      const np = f.clip.notes[i].p; if (!resize && np !== lastP) { lastP = np; this.play(np, true); setTimeout(() => this.play(np, false), 150); }
      this.draw();
    };
    const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); this.store.commit(resize ? 'Duración de nota' : 'Mover nota'); this.draw(); };
    addEventListener('pointermove', mv); addEventListener('pointerup', up);
    this.draw();
  }
  onDbl(e) {
    const f = this.found; if (!f || this.tool !== 'select') return;
    const r = this.roll.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    const i = this.hitNote(x, y);
    if (i >= 0) this.store.edit('Borrar nota', () => { f.clip.notes.splice(i, 1); });
    else { const t = Math.max(0, Math.floor(this.xToT(x) / this.grid()) * this.grid()); this.store.edit('Añadir nota', () => { f.clip.notes.push({ p: this.yToP(y), t, d: this.grid(), v: 100 }); }); }
    this.selNotes.clear(); this.draw();
  }
  onVelDown(e) {
    const f = this.found; if (!f) return;
    const r = this.vel.getBoundingClientRect(); this.store.begin();
    const set = (ev) => {
      const x = ev.clientX - r.left, v = clamp(Math.round((1 - (ev.clientY - r.top) / r.height) * 127), 1, 127);
      this.store.live(() => f.clip.notes.forEach((n, i) => { const nx = this.tToX(n.t); if (Math.abs(nx - x) < 5 && (!this.selNotes.size || this.selNotes.has(i))) n.v = v; }));
      this.draw();
    };
    set(e);
    const up = () => { removeEventListener('pointermove', set); removeEventListener('pointerup', up); this.store.commit('Velocidad'); };
    addEventListener('pointermove', set); addEventListener('pointerup', up);
  }
}
