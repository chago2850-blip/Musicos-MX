// Músicos MX — Ventana de Mezcla: canales, inserciones, envíos, faders y medidores
// Copyright (C) 2026 Santiago Miguel — GNU GPL v3 o posterior.
import { $, h } from './dialogs.js';
import { PLUGINS } from '../engine/plugins.js';
import { volToNorm, normToVol } from './edit.js';
import { clamp } from '../util.js';

const N_INSERTS = 6, N_SENDS = 4;

export class MixView {
  constructor(app) {
    this.app = app; this.store = app.store; this.engine = app.engine;
    this.el = $('#mixer'); this.meters = [];
    this.store.on('change', () => { if (this.app.view === 'mix') this.build(); else this.stale = true; });
    this.loop();
  }
  show() { if (this.stale || !this.el.children.length) this.build(); this.stale = false; }
  build() {
    const p = this.store.project; this.el.innerHTML = ''; this.meters = [];
    for (const t of p.tracks) if (!t.hidden && t.type !== 'video') this.el.append(this.strip(t));
    this.el.append(this.masterStrip());
  }
  strip(t) {
    const s = h('div', { class: 'strip' + (this.store.selectedTrack === t.id ? ' sel' : '') });
    s.addEventListener('pointerdown', () => { this.store.selectedTrack = t.id; for (const x of this.el.children) x.classList.toggle('sel', x === s); });
    s.append(h('div', { class: 'slabel' }, 'Inserciones'));
    for (let i = 0; i < N_INSERTS; i++) s.append(this.insertSlot(t.id, t.inserts[i], i));
    s.append(h('div', { class: 'slabel' }, 'Envíos'));
    for (let i = 0; i < N_SENDS; i++) s.append(this.sendSlot(t, t.sends[i], i));
    s.append(h('div', { class: 'slabel' }, 'Salida'));
    const out = h('select', { title: 'Salida de la pista' });
    out.append(h('option', { value: 'master' }, 'Master'));
    for (const a of this.store.project.tracks.filter(x => x.type === 'aux' && x.id !== t.id)) out.append(h('option', { value: a.id, selected: t.output === a.id ? 'selected' : null }, a.name));
    out.addEventListener('change', () => { this.store.edit('Salida', p => { p.tracks.find(x => x.id === t.id).output = out.value; }); this.engine.rebuild(); });
    s.append(out);
    const am = h('select', { title: 'Automatización' });
    [['off', 'off'], ['read', 'leer'], ['touch', 'touch'], ['latch', 'latch'], ['write', 'escribir']].forEach(([v, l]) => am.append(h('option', { value: v, selected: t.automationMode === v ? 'selected' : null }, l)));
    am.addEventListener('change', () => this.store.edit('Modo de automatización', p => { p.tracks.find(x => x.id === t.id).automationMode = am.value; }));
    s.append(am);
    if (t.spatial?.enabled) s.append(h('button', { class: 'btn small', onclick: () => this.app.spatialPanner(t.id) }, '🎧 3D'));
    else s.append(this.knob(t));
    const btns = h('div', { class: 'btns' });
    const b = (cls, label, key, title) => h('button', { class: 'tb ' + cls + (t[key] ? ' on' : ''), title, onclick: (e) => this.app.toggleTrack(t.id, key, e.shiftKey) }, label);
    if (t.type !== 'aux') btns.append(b('rec', '●', 'recArm', 'Grabar'));
    btns.append(b('solo', 'S', 'solo', 'Solo'), b('mute', 'M', 'mute', 'Silencio'));
    s.append(btns);
    s.append(this.faderArea(t.id, () => this.store.track(t.id)?.volume ?? 0, (v) => {
      this.store.live(p => { p.tracks.find(x => x.id === t.id).volume = v; });
      this.engine.updateMix(); this.engine.writeAutomation(t.id, 'volume', v);
    }, () => this.engine.graph?.tracks.get(t.id)?.analyser));
    const name = h('div', { class: 'sname', style: { background: t.color }, title: t.name }, t.name);
    name.addEventListener('dblclick', () => this.app.renameTrack(t.id));
    s.append(name);
    return s;
  }
  masterStrip() {
    const p = this.store.project;
    const s = h('div', { class: 'strip master' });
    s.append(h('div', { class: 'slabel' }, 'Inserciones Master'));
    for (let i = 0; i < N_INSERTS; i++) s.append(this.insertSlot('master', p.master.inserts[i], i));
    s.append(h('div', { class: 'slabel' }, 'Sonoridad'));
    const lufs = h('div', { class: 'vol', id: 'masterLufs' }, '— LUFS'); s.append(lufs);
    s.append(h('button', { class: 'btn small', onclick: () => this.app.aiMaster() }, '✨ Masterizar'));
    s.append(h('div', { class: 'btns' }, h('button', { class: 'tb mute' + (p.master.mute ? ' on' : ''), onclick: () => { this.store.edit('Silenciar master', pp => { pp.master.mute = !pp.master.mute; }); this.engine.updateMix(); } }, 'M')));
    s.append(this.faderArea('master', () => this.store.project.master.volume, (v) => { this.store.live(pp => { pp.master.volume = v; }); this.engine.updateMix(); }, () => [this.engine.graph?.masterAnL, this.engine.graph?.masterAnR]));
    s.append(h('div', { class: 'sname', style: { background: 'linear-gradient(90deg,#ff3d7f,#ffb547)' } }, 'MASTER'));
    return s;
  }
  insertSlot(trackId, ins, i) {
    const el = h('div', { class: 'slot' + (ins ? ' used' : '') + (ins?.bypass ? ' byp' : ''), title: ins ? PLUGINS[ins.type]?.name + ' (clic: abrir · clic derecho: opciones)' : 'Insertar complemento' }, ins ? PLUGINS[ins.type]?.name || ins.type : String.fromCharCode(97 + i) + ' —');
    el.addEventListener('click', (e) => { if (ins) this.app.openPlugin(trackId, ins.id); else this.app.insertMenu(trackId, e.clientX, e.clientY, i); });
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); if (ins) this.app.insertContext(trackId, ins.id, e.clientX, e.clientY); else this.app.insertMenu(trackId, e.clientX, e.clientY, i); });
    return el;
  }
  sendSlot(t, s, i) {
    const bus = s && this.store.track(s.bus);
    const el = h('div', { class: 'slot send' + (s ? ' used' : ''), title: s ? 'Envío a ' + (bus?.name || '?') + ' ' + s.level.toFixed(1) + ' dB (rueda: nivel)' : 'Nuevo envío' }, s ? `${bus?.name || '?'} ${s.level.toFixed(0)}` : String.fromCharCode(102 + i) + ' —');
    el.addEventListener('click', (e) => this.app.sendMenu(t.id, i, e.clientX, e.clientY));
    el.addEventListener('wheel', (e) => {
      if (!s) return; e.preventDefault();
      this.store.live(p => { const ss = p.tracks.find(x => x.id === t.id).sends[i]; ss.level = clamp(ss.level - Math.sign(e.deltaY), -60, 12); el.textContent = `${bus?.name || '?'} ${ss.level.toFixed(0)}`; });
      this.engine.updateMix();
    }, { passive: false });
    return el;
  }
  knob(t) {
    const wrap = h('div', { class: 'knob', title: 'Paneo (doble clic: centro)' });
    const cv = h('canvas', { width: 76, height: 76 }); wrap.append(cv);
    const draw = () => {
      const v = this.store.track(t.id)?.pan ?? 0, c = cv.getContext('2d');
      c.clearRect(0, 0, 76, 76); c.lineWidth = 6; c.lineCap = 'round';
      c.strokeStyle = '#2a3040'; c.beginPath(); c.arc(38, 38, 28, Math.PI * 0.75, Math.PI * 2.25); c.stroke();
      c.strokeStyle = '#4fa3ff'; c.beginPath(); const mid = Math.PI * 1.5, a = mid + v * Math.PI * 0.75; c.arc(38, 38, 28, Math.min(mid, a), Math.max(mid, a) + 0.001); c.stroke();
      c.fillStyle = '#e6e9f0'; c.font = 'bold 16px system-ui'; c.textAlign = 'center';
      c.fillText(v === 0 ? 'C' : (v < 0 ? 'I' : 'D') + Math.round(Math.abs(v) * 100), 38, 44);
    };
    draw();
    wrap.addEventListener('dblclick', () => { this.store.edit('Paneo', p => { p.tracks.find(x => x.id === t.id).pan = 0; }); this.engine.updateMix(); draw(); });
    wrap.addEventListener('pointerdown', (e) => {
      const sy = e.clientY, sv = this.store.track(t.id).pan; this.store.begin();
      const mv = (ev) => { const v = clamp(sv + (sy - ev.clientY) / 120, -1, 1); this.store.live(p => { p.tracks.find(x => x.id === t.id).pan = Math.round(v * 100) / 100; }); this.engine.updateMix(); this.engine.writeAutomation(t.id, 'pan', v); draw(); };
      const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); this.store.commit('Paneo'); };
      addEventListener('pointermove', mv); addEventListener('pointerup', up);
    });
    return wrap;
  }
  faderArea(id, get, set, getAn) {
    const area = h('div', { class: 'fader-area' });
    const fader = h('div', { class: 'fader' }, h('div', { class: 'track' }));
    const cap = h('div', { class: 'cap' }); fader.append(cap);
    const scale = h('div', { class: 'scale' });
    for (const db of [12, 6, 0, -6, -12, -24, -40, -60]) scale.append(h('div', { style: { position: 'absolute', top: `calc(${(1 - volToNorm(db)) * 100}% - 5px)` } }, String(db)));
    fader.append(scale);
    const meterL = h('div', { class: 'meter' }, h('canvas', { width: 14, height: 300 }));
    area.append(fader, meterL);
    const volEl = h('div', { class: 'vol' });
    const place = () => { const v = get(); cap.style.top = `calc(6px + ${(1 - volToNorm(v))} * (100% - 12px))`; volEl.textContent = v <= -89 ? '-∞' : (v > 0 ? '+' : '') + v.toFixed(1); };
    place();
    cap.addEventListener('pointerdown', (e) => {
      e.preventDefault(); const r = fader.getBoundingClientRect(); this.store.begin();
      const fine = e.ctrlKey || e.metaKey; const sy = e.clientY, sv = volToNorm(get());
      const mv = (ev) => { const n = clamp(sv - (ev.clientY - sy) / (r.height - 12) * (fine ? 0.1 : 1), 0, 1); set(Math.round(normToVol(n) * 10) / 10); place(); };
      const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); this.store.commit('Volumen'); };
      addEventListener('pointermove', mv); addEventListener('pointerup', up);
    });
    cap.addEventListener('dblclick', () => { set(0); place(); });
    fader.addEventListener('wheel', (e) => { e.preventDefault(); set(clamp(Math.round((get() - Math.sign(e.deltaY) * 0.5) * 10) / 10, -90, 12)); place(); }, { passive: false });
    const wrap = h('div', { style: { display: 'flex', flexDirection: 'column', flex: 1, gap: '4px' } }, area, volEl);
    this.meters.push({ canvas: meterL.firstChild, getAn, place, hold: 0, holdT: 0 });
    return wrap;
  }
  loop() {
    const tick = () => {
      if (this.app.view === 'mix' && this.engine.graph) {
        for (const m of this.meters) {
          const an = m.getAn(); const c = m.canvas.getContext('2d');
          const W = m.canvas.width, H = m.canvas.height;
          c.fillStyle = '#07090c'; c.fillRect(0, 0, W, H);
          const ans = Array.isArray(an) ? an : [an];
          ans.forEach((a, i) => {
            if (!a) return;
            const pk = this.engine.peak(a), db = pk > 0 ? 20 * Math.log10(pk) : -90;
            const n = volToNorm(Math.min(12, db)), w = W / ans.length;
            const g = c.createLinearGradient(0, H, 0, 0); g.addColorStop(0, '#3ddc84'); g.addColorStop(0.8, '#ffd23f'); g.addColorStop(0.86, '#ff4757');
            c.fillStyle = g; c.fillRect(i * w + 1, H - n * H, w - 2, n * H);
            if (db > m.hold || performance.now() - m.holdT > 1500) { m.hold = db; m.holdT = performance.now(); }
            c.fillStyle = m.hold >= -0.1 ? '#ff4757' : '#fff'; c.fillRect(i * w + 1, H - volToNorm(Math.min(12, m.hold)) * H, w - 2, 2);
          });
        }
        if (this.engine.playing) for (const m of this.meters) m.place();
        const lu = document.getElementById('masterLufs'); if (lu) lu.textContent = (this.app.lufsM ?? -70).toFixed(1) + ' LUFS';
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}
