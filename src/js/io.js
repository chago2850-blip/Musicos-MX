// Músicos MX — entrada/salida: WAV, MP3, MIDI estándar y archivos de sesión .mmxs
// Copyright (C) 2026 Santiago Miguel — GNU GPL v3 o posterior.
import JSZip from 'jszip';
import { Mp3Encoder } from '@breezystack/lamejs';
import { normalizeProject } from './project.js';

export function encodeWav(buffer, bitDepth = 24, dither = true) {
  const nch = buffer.numberOfChannels, sr = buffer.sampleRate, len = buffer.length;
  const bps = bitDepth === 32 ? 4 : bitDepth / 8;
  const fmt = bitDepth === 32 ? 3 : 1;
  const dataLen = len * nch * bps;
  const ab = new ArrayBuffer(44 + dataLen), v = new DataView(ab);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); v.setUint32(4, 36 + dataLen, true); ws(8, 'WAVE'); ws(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, fmt, true); v.setUint16(22, nch, true); v.setUint32(24, sr, true);
  v.setUint32(28, sr * nch * bps, true); v.setUint16(32, nch * bps, true); v.setUint16(34, bitDepth, true);
  ws(36, 'data'); v.setUint32(40, dataLen, true);
  const chs = []; for (let c = 0; c < nch; c++) chs.push(buffer.getChannelData(c));
  let o = 44;
  const max = bitDepth === 16 ? 32767 : 8388607;
  for (let i = 0; i < len; i++) for (let c = 0; c < nch; c++) {
    let s = chs[c][i];
    if (bitDepth === 32) { v.setFloat32(o, s, true); o += 4; continue; }
    if (dither) s += (Math.random() - Math.random()) / max; // TPDF
    s = Math.max(-1, Math.min(1, s));
    const iv = Math.round(s * max);
    if (bitDepth === 16) { v.setInt16(o, iv, true); o += 2; }
    else { v.setUint8(o, iv & 255); v.setUint8(o + 1, (iv >> 8) & 255); v.setUint8(o + 2, (iv >> 16) & 255); o += 3; }
  }
  return new Blob([ab], { type: 'audio/wav' });
}

export async function encodeMp3(buffer, kbps = 320, onProgress) {
  const nch = Math.min(2, buffer.numberOfChannels);
  const enc = new Mp3Encoder(nch, buffer.sampleRate, kbps);
  const L = buffer.getChannelData(0), R = nch > 1 ? buffer.getChannelData(1) : L;
  const toI16 = (f, s, e) => { const o = new Int16Array(e - s); for (let i = s; i < e; i++) o[i - s] = Math.max(-32768, Math.min(32767, f[i] * 32767)); return o; };
  const parts = []; const block = 1152 * 20;
  for (let i = 0; i < L.length; i += block) {
    const e = Math.min(L.length, i + block);
    const out = nch > 1 ? enc.encodeBuffer(toI16(L, i, e), toI16(R, i, e)) : enc.encodeBuffer(toI16(L, i, e));
    if (out.length) parts.push(new Uint8Array(out));
    if (onProgress && (i / block) % 20 === 0) { onProgress(i / L.length); await new Promise(r => setTimeout(r)); }
  }
  const fin = enc.flush(); if (fin.length) parts.push(new Uint8Array(fin));
  return new Blob(parts, { type: 'audio/mpeg' });
}

export async function decodeFile(ctx, file) {
  const ab = await file.arrayBuffer();
  return await ctx.decodeAudioData(ab);
}

// ---------- MIDI estándar (SMF) ----------
export function parseMidi(ab) {
  const d = new DataView(ab); let p = 0;
  const str = (n) => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(d.getUint8(p + i)); p += n; return s; };
  const u32 = () => { const v = d.getUint32(p); p += 4; return v; }, u16 = () => { const v = d.getUint16(p); p += 2; return v; };
  const vlq = () => { let v = 0, b; do { b = d.getUint8(p++); v = (v << 7) | (b & 127); } while (b & 128); return v; };
  if (str(4) !== 'MThd') throw new Error('No es un archivo MIDI');
  const hl = u32(); const format = u16(), ntr = u16(), div = u16(); p += hl - 6;
  let tempo = 500000; const tempos = [];
  const tracks = [];
  for (let t = 0; t < ntr; t++) {
    if (str(4) !== 'MTrk') break;
    const len = u32(), end = p + len; let tick = 0, status = 0;
    const notes = [], open = {}; let name = 'Pista ' + (t + 1), channel = 0;
    while (p < end) {
      tick += vlq();
      let b = d.getUint8(p);
      if (b & 128) { status = b; p++; }
      const type = status >> 4, ch = status & 15;
      if (status === 0xFF) {
        const mt = d.getUint8(p++); const ml = vlq();
        if (mt === 0x51) { tempo = (d.getUint8(p) << 16) | (d.getUint8(p + 1) << 8) | d.getUint8(p + 2); tempos.push({ tick, tempo }); }
        if (mt === 0x03) { name = ''; for (let i = 0; i < ml; i++) name += String.fromCharCode(d.getUint8(p + i)); }
        p += ml;
      } else if (status === 0xF0 || status === 0xF7) { p += vlq(); }
      else if (type === 9 || type === 8) {
        const n = d.getUint8(p++), v = d.getUint8(p++); channel = ch;
        if (type === 9 && v > 0) open[n] = { tick, v };
        else if (open[n]) { notes.push({ p: n, v: open[n].v, tick: open[n].tick, dt: tick - open[n].tick }); delete open[n]; }
      } else if (type === 0xC || type === 0xD) p += 1; else p += 2;
    }
    p = end;
    if (notes.length) tracks.push({ name, notes, channel });
  }
  const usPerQ = tempos.length ? tempos[0].tempo : tempo;
  const secPerTick = usPerQ / 1e6 / div;
  return {
    bpm: Math.round(60e6 / usPerQ * 100) / 100,
    tracks: tracks.map(tr => ({ name: tr.name, drums: tr.channel === 9, notes: tr.notes.map(n => ({ p: n.p, v: n.v, t: n.tick * secPerTick, d: Math.max(0.02, n.dt * secPerTick) })) }))
  };
}

export function writeMidi(clips, tempo) {
  const div = 480, spt = 60 / tempo / div;
  const bytes = [];
  const push = (...a) => bytes.push(...a);
  const vlq = (v) => { const b = [v & 127]; while ((v >>= 7)) b.unshift((v & 127) | 128); return b; };
  const trackChunks = [];
  // pista de tempo
  const t0 = [0, 0xFF, 0x51, 3, ...[16, 8, 0].map(s => (Math.round(60e6 / tempo) >> s) & 255), 0, 0xFF, 0x2F, 0];
  trackChunks.push(t0);
  for (const c of clips) {
    const evs = [];
    for (const n of c.notes) { evs.push({ t: Math.round((c.start + n.t) / spt), b: [0x90 | (c.channel || 0), n.p, n.v] }); evs.push({ t: Math.round((c.start + n.t + n.d) / spt), b: [0x80 | (c.channel || 0), n.p, 0] }); }
    evs.sort((a, b) => a.t - b.t || (a.b[0] & 0xF0) - (b.b[0] & 0xF0));
    const out = []; let last = 0;
    const nm = [...(c.name || 'MIDI')].map(ch => ch.charCodeAt(0) & 127);
    out.push(0, 0xFF, 0x03, nm.length, ...nm);
    for (const e of evs) { out.push(...vlq(e.t - last), ...e.b); last = e.t; }
    out.push(0, 0xFF, 0x2F, 0);
    trackChunks.push(out);
  }
  push(0x4D, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, trackChunks.length, div >> 8, div & 255);
  for (const ch of trackChunks) { push(0x4D, 0x54, 0x72, 0x6B, (ch.length >> 24) & 255, (ch.length >> 16) & 255, (ch.length >> 8) & 255, ch.length & 255, ...ch); }
  return new Blob([new Uint8Array(bytes)], { type: 'audio/midi' });
}

// ---------- Sesión ----------
export async function saveSession(store) {
  const zip = new JSZip();
  const p = store.project;
  const used = new Set();
  for (const t of p.tracks) for (const pl of t.playlists) for (const c of pl.clips) if (c.assetId) used.add(c.assetId);
  if (p.videoAssetId) used.add(p.videoAssetId);
  const assetsMeta = [];
  for (const [id, a] of store.assets) {
    if (!used.has(id) && !a.keep) continue;
    if (a.video) { zip.file('video/' + id, a.videoBlob); assetsMeta.push({ id, name: a.name, video: true, type: a.videoBlob.type }); continue; }
    zip.file('audio/' + id + '.wav', encodeWav(a.buffer, 32, false));
    assetsMeta.push({ id, name: a.name });
  }
  zip.file('session.json', JSON.stringify({ project: p, assets: assetsMeta }, null, 1));
  zip.file('LEAME.txt', 'Sesión de Músicos MX (estación de audio libre, GPL-3.0-o-posterior).\nAbre este archivo .mmxs desde Archivo > Abrir sesión.');
  return await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 3 } });
}

export async function loadSession(ctx, blob, computePeaks) {
  const zip = await JSZip.loadAsync(blob);
  const meta = JSON.parse(await zip.file('session.json').async('string'));
  const assets = new Map();
  for (const a of meta.assets) {
    if (a.video) {
      const b = await zip.file('video/' + a.id).async('blob');
      const vb = new Blob([b], { type: a.type || 'video/mp4' });
      assets.set(a.id, { id: a.id, name: a.name, video: true, videoBlob: vb, url: URL.createObjectURL(vb) });
      continue;
    }
    const ab = await zip.file('audio/' + a.id + '.wav').async('arraybuffer');
    const buffer = await ctx.decodeAudioData(ab);
    assets.set(a.id, { id: a.id, name: a.name, buffer, peaks: computePeaks(buffer) });
  }
  return { project: normalizeProject(meta.project), assets };
}

export function bufferFromChannels(ctx, chans, sr) {
  const b = ctx.createBuffer(chans.length, chans[0].length, sr);
  chans.forEach((c, i) => b.copyToChannel(c, i));
  return b;
}
