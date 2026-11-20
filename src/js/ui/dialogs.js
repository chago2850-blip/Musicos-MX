// Músicos MX — diálogos, ventanas flotantes, menús contextuales y avisos
// Copyright (C) 2026 Santiago Miguel — GNU GPL v3 o posterior.
import { escapeHtml } from '../util.js';

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const k in attrs) {
    if (k === 'class') e.className = attrs[k];
    else if (k === 'style' && typeof attrs[k] === 'object') Object.assign(e.style, attrs[k]);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), attrs[k]);
    else if (k === 'html') e.innerHTML = attrs[k];
    else if (attrs[k] !== undefined && attrs[k] !== null && attrs[k] !== false) e.setAttribute(k, attrs[k]);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
}

let modalStack = [];
export function modal(title, body, buttons = [{ label: 'Aceptar', primary: true, value: true }], opts = {}) {
  // gancho para pruebas automatizadas (no se usa en uso normal)
  if (window.__modalAnswer !== undefined) return Promise.resolve(window.__modalAnswer);
  return new Promise((resolve) => {
    const back = $('#modalBack');
    const m = h('div', { class: 'modal', style: opts.width ? { width: opts.width } : {} });
    m.append(h('h2', {}, title));
    const b = h('div', { class: 'mbody' }); if (typeof body === 'string') b.innerHTML = body; else b.append(body);
    m.append(b);
    const f = h('div', { class: 'mfoot' });
    const close = (v) => { m.remove(); modalStack.pop(); if (!modalStack.length) back.classList.remove('on'); resolve(v); };
    for (const bt of buttons) f.append(h('button', { class: 'btn' + (bt.primary ? ' primary' : ''), onclick: () => close(typeof bt.value === 'function' ? bt.value(m) : bt.value) }, bt.label));
    m.append(f);
    m._close = close;
    back.innerHTML = ''; back.append(m); back.classList.add('on'); modalStack.push(m);
    m.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(null); if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') { const pb = buttons.find(x => x.primary); if (pb) close(typeof pb.value === 'function' ? pb.value(m) : pb.value); } e.stopPropagation(); });
    setTimeout(() => (m.querySelector('input,select,textarea') || f.querySelector('.primary'))?.focus(), 30);
  });
}
export const alertBox = (title, msg) => modal(title, `<p>${msg}</p>`);
export const confirmBox = (title, msg, yes = 'Sí', no = 'Cancelar') => modal(title, `<p>${msg}</p>`, [{ label: no, value: false }, { label: yes, primary: true, value: true }]);
export async function promptBox(title, label, value = '') {
  const inp = h('input', { type: 'text', value, style: { width: '100%' } });
  const r = await modal(title, h('div', {}, h('p', {}, label), inp), [{ label: 'Cancelar', value: null }, { label: 'Aceptar', primary: true, value: () => inp.value }]);
  return r;
}
// Formulario genérico: fields = [{key,label,type:'text'|'number'|'select'|'check'|'range',options,value,min,max,step}]
export async function formBox(title, fields, okLabel = 'Aceptar', intro = '') {
  if (window.__formAnswer) { // gancho para pruebas automatizadas
    const a = window.__formAnswer, o = {}; window.__formAnswer = null;
    for (const f of fields) o[f.key] = a[f.key] !== undefined ? a[f.key] : (f.type === 'number' ? parseFloat(f.value) : f.value);
    return o;
  }
  const form = h('div', { class: 'form' });
  const inputs = {};
  for (const f of fields) {
    let inp;
    if (f.type === 'select') { inp = h('select', {}); for (const o of f.options) { const [v, l] = Array.isArray(o) ? o : [o, o]; inp.append(h('option', { value: v, selected: String(v) === String(f.value) ? 'selected' : null }, l)); } }
    else if (f.type === 'check') inp = h('input', { type: 'checkbox', checked: f.value ? 'checked' : null });
    else if (f.type === 'textarea') inp = h('textarea', { rows: f.rows || 4 }, f.value || '');
    else inp = h('input', { type: f.type || 'text', value: f.value ?? '', min: f.min, max: f.max, step: f.step });
    inputs[f.key] = inp;
    form.append(h('label', {}, f.label), inp);
  }
  const body = h('div', {}, intro ? h('p', { style: { marginTop: 0, color: 'var(--dim)' } }, intro) : null, form);
  const r = await modal(title, body, [{ label: 'Cancelar', value: null }, { label: okLabel, primary: true, value: () => true }]);
  if (!r) return null;
  const out = {};
  for (const f of fields) { const i = inputs[f.key]; out[f.key] = f.type === 'check' ? i.checked : (f.type === 'number' || f.type === 'range') ? parseFloat(i.value) : i.value; }
  return out;
}

export function progressBox(title, msg = '') {
  const bar = h('i'), txt = h('p', {}, msg);
  const back = $('#modalBack');
  const m = h('div', { class: 'modal', style: { width: '440px' } }, h('h2', {}, title), h('div', { class: 'mbody' }, txt, h('div', { class: 'progress' }, bar)));
  back.innerHTML = ''; back.append(m); back.classList.add('on'); modalStack.push(m);
  return {
    set(p, t) { bar.style.width = Math.round(Math.max(0, Math.min(1, p)) * 100) + '%'; if (t) txt.textContent = t; },
    close() { m.remove(); modalStack.pop(); if (!modalStack.length) back.classList.remove('on'); }
  };
}

let toastT;
export function toast(msg, err = false, ms = 3500) {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const t = h('div', { class: 'toast' + (err ? ' err' : '') }, msg);
  document.body.append(t); clearTimeout(toastT); toastT = setTimeout(() => t.remove(), ms);
}

export function contextMenu(x, y, items) {
  closeContext();
  const m = h('div', { class: 'ctx', id: 'ctxMenu' });
  for (const it of items) {
    if (it === '-') { m.append(h('div', { class: 'msep' })); continue; }
    if (it.head) { m.append(h('div', { class: 'mhead' }, it.head)); continue; }
    m.append(h('div', { class: 'mitem', onclick: () => { closeContext(); it.action(); } }, h('span', {}, it.label), it.key ? h('span', { class: 'k' }, it.key) : ''));
  }
  document.body.append(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 6) + 'px';
  m.style.top = Math.min(y, innerHeight - r.height - 6) + 'px';
  setTimeout(() => document.addEventListener('pointerdown', onDocDown), 0);
}
function onDocDown(e) { if (!e.target.closest('#ctxMenu')) closeContext(); }
export function closeContext() { document.getElementById('ctxMenu')?.remove(); document.removeEventListener('pointerdown', onDocDown); }

let zTop = 500;
export function floatWindow(id, title, content, opts = {}) {
  let w = document.getElementById(id);
  if (w) { w.remove(); }
  w = h('div', { class: 'float', id });
  const head = h('div', { class: 'fhead' }, ...(opts.headExtra || []), h('span', { class: 't' }, title), h('span', { class: 'x', title: 'Cerrar', onclick: () => { w.remove(); opts.onClose?.(); } }, '✕'));
  const body = h('div', { class: 'fbody' }); body.append(content);
  w.append(head, body);
  w.style.left = (opts.x ?? Math.max(20, innerWidth / 2 - (opts.w || 380) / 2)) + 'px';
  w.style.top = (opts.y ?? 120) + 'px';
  if (opts.w) w.style.width = opts.w + 'px';
  w.style.zIndex = ++zTop;
  w.addEventListener('pointerdown', () => { w.style.zIndex = ++zTop; });
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.x,button,select,input')) return;
    const sx = e.clientX - w.offsetLeft, sy = e.clientY - w.offsetTop;
    const mv = (ev) => { w.style.left = Math.max(0, ev.clientX - sx) + 'px'; w.style.top = Math.max(0, ev.clientY - sy) + 'px'; };
    const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); };
    addEventListener('pointermove', mv); addEventListener('pointerup', up);
  });
  document.body.append(w);
  return w;
}
export { escapeHtml };
