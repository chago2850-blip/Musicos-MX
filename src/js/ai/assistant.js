// Músicos MX — Asistente de sesión: comandos en lenguaje natural (español) + LLM local opcional (Ollama)
// Copyright (C) 2026 Santiago Miguel — GNU GPL v3 o posterior.
import { GENRES } from './ai.js';

const NUM = { un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, doce: 12, dieciséis: 16, dieciseis: 16, veinte: 20 };
const num = (s) => { if (s == null) return null; const n = parseFloat(String(s).replace(',', '.')); return isNaN(n) ? NUM[String(s).toLowerCase()] ?? null : n; };
const strip = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const PLUGIN_WORDS = [['eq7', /ecualizador|\beq\b/], ['comp', /compresor|compresion/], ['limiter', /limitador|maximizador/], ['gate', /compuerta|gate/], ['deesser', /de-?esser|sibilan/], ['reverb', /reverb|reverberacion/], ['delay', /delay|retardo|eco/], ['chorus', /coro|chorus|flanger/], ['saturator', /saturac|distorsion|calidez/], ['filter', /filtro/], ['tremolo', /tremolo/], ['stereo', /estereo|amplitud|ancho/], ['pitchrt', /doblador|doblar voz/]];

export const COMMAND_HELP = [
  'crea 4 pistas de audio  ·  crea una pista de instrumento llamada Piano',
  'tempo 96  ·  compás 3/4  ·  metrónomo encendido',
  'reproduce  ·  detén  ·  graba  ·  ve al compás 17  ·  ve al inicio',
  'silencia la pista Batería  ·  solo a Voz  ·  arma la pista 2',
  'volumen de Voz a -6 dB  ·  sube el bajo 3 dB  ·  paneo de Guitarra a la izquierda 40',
  'agrega reverb a Voz  ·  pon un compresor en el bajo  ·  agrega limitador al master',
  'normaliza la pista 3  ·  invierte el clip  ·  quita silencios de Voz',
  'bucle del compás 5 al 9  ·  crea marcador Coro',
  'genera batería de cumbia de 8 compases  ·  genera acordes en La menor  ·  genera bajo  ·  genera melodía',
  'separa los stems de la pista Mezcla  ·  transcribe la pista Diálogo  ·  detecta tempo de Batería',
  'mezcla automática  ·  masteriza para streaming  ·  exporta la mezcla en mp3  ·  exporta stems',
  'renombra la pista 1 a Bombo  ·  elimina la pista 4  ·  deshaz  ·  rehaz'
];

function findTrackRef(text) {
  // "pista 3", "pista Voz", "a Voz", "de la batería"
  let m = text.match(/pista\s+(?:numero\s+)?(\d+)/);
  if (m) return { index: parseInt(m[1]) - 1 };
  m = text.match(/(?:pista|canal)\s+(?:de\s+|del\s+|de la\s+)?["“]?([\wáéíóúñ\- ]+?)["”]?(?:\s+(?:a|en|al|con|de|y)\b|$)/);
  if (m) return { name: m[1].trim() };
  return null;
}

export function parseCommand(input, project) {
  const raw = input.trim(); const t = strip(raw);
  const cmds = [];
  // dividir instrucciones encadenadas con "y luego", ";"
  const parts = t.split(/\s*(?:;|\by luego\b|\bdespues\b|\bentonces\b)\s*/).filter(Boolean);
  for (const p of parts) cmds.push(...parseOne(p, project));
  return cmds;
}

function resolveTrack(ref, project, text) {
  if (!ref) {
    // buscar nombre de pista mencionado en el texto
    const tr = project.tracks.slice().sort((a, b) => b.name.length - a.name.length).find(tk => text.includes(strip(tk.name)));
    return tr ? tr.id : null;
  }
  if (ref.index != null) return project.tracks[ref.index]?.id || null;
  const n = strip(ref.name);
  const tr = project.tracks.find(tk => strip(tk.name) === n) || project.tracks.find(tk => strip(tk.name).includes(n) || n.includes(strip(tk.name)));
  return tr ? tr.id : null;
}

function parseOne(t, project) {
  const out = [];
  const trackId = () => resolveTrack(findTrackRef(t), project, t);
  let m;
  if (/^(deshaz|deshacer|undo)/.test(t)) return [{ cmd: 'undo' }];
  if (/^(rehaz|rehacer|redo)/.test(t)) return [{ cmd: 'redo' }];
  if ((m = t.match(/(?:crea|agrega|anade|nueva?s?)\s+(\w+)?\s*pistas?\s+(?:de\s+)?(audio|instrumento|midi|auxiliar|aux|bus|video)?(?:.*?(?:llamada|nombre)\s+(.+))?/)) && /pista/.test(t) && !/efecto|reverb|compresor/.test(t)) {
    const n = num(m[1]) || 1;
    const typeW = m[2] || (/instrumento|piano|sinte/.test(t) ? 'instrumento' : /bater/.test(t) ? 'instrumento' : 'audio');
    const type = { audio: 'audio', instrumento: 'instrument', midi: 'midi', auxiliar: 'aux', aux: 'aux', bus: 'aux', video: 'video' }[typeW] || 'audio';
    return [{ cmd: 'addTracks', type, count: n, name: m[3] ? m[3].trim() : null, drums: /bater/.test(t) }];
  }
  if ((m = t.match(/(?:tempo|bpm|velocidad)\s*(?:a|de|en)?\s*([\d.,]+)/)) || (m = t.match(/([\d.,]+)\s*bpm/))) return [{ cmd: 'tempo', bpm: num(m[1]) }];
  if ((m = t.match(/compas\s+(?:de\s+)?(\d+)\s*\/\s*(\d+)/))) return [{ cmd: 'timeSig', a: +m[1], b: +m[2] }];
  if (/metronomo|click|clic/.test(t)) return [{ cmd: 'metronome', on: !/apaga|quita|desactiva|off/.test(t) }];
  if ((m = t.match(/(?:ve|ir|salta|lleva(?:me)?)\s+(?:al?\s+)?compas\s+(\d+)/))) return [{ cmd: 'gotoBar', bar: +m[1] }];
  if (/(ve|ir|regresa|vuelve)\s+al?\s+(inicio|principio|comienzo)/.test(t)) return [{ cmd: 'gotoStart' }];
  if (/^(reproduce|play|toca|dale play|inicia)/.test(t)) return [{ cmd: 'play' }];
  if (/^(deten|para|stop|alto|pausa)/.test(t)) return [{ cmd: 'stop' }];
  if (/^(graba|grabar|record)\b/.test(t) && !/pista/.test(t)) return [{ cmd: 'record' }];
  if ((m = t.match(/bucle\s+(?:del?\s+)?compas\s+(\d+)\s+(?:al?|hasta)\s+(?:el\s+)?(?:compas\s+)?(\d+)/))) return [{ cmd: 'loop', from: +m[1], to: +m[2] }];
  if (/(quita|desactiva|apaga)\s+(el\s+)?bucle/.test(t)) return [{ cmd: 'loopOff' }];
  if ((m = t.match(/marcador\s+(?:llamado\s+)?(.+)/))) return [{ cmd: 'marker', name: m[1].trim() }];
  if ((m = t.match(/renombra\s+(?:la\s+)?pista\s+(.+?)\s+(?:a|como)\s+(.+)/))) return [{ cmd: 'rename', trackId: resolveTrack(/^\d+$/.test(m[1]) ? { index: +m[1] - 1 } : { name: m[1] }, project, t), name: m[2].trim() }];
  if (/(elimina|borra|quita)\s+(la\s+)?pista/.test(t)) return [{ cmd: 'deleteTrack', trackId: trackId() }];
  if (/(dessilencia|activa el sonido|quita(?:le)? el silencio|unmute)/.test(t)) return [{ cmd: 'mute', trackId: trackId(), on: false }];
  if (/(silencia|mute|enmudece)/.test(t)) return [{ cmd: 'mute', trackId: trackId(), on: true }];
  if (/\bsolo\b/.test(t)) return [{ cmd: 'solo', trackId: trackId(), on: !/quita|sin solo/.test(t) }];
  if (/\barma\b|armar|preparar para grabar/.test(t)) return [{ cmd: 'arm', trackId: trackId(), on: !/desarma/.test(t) }];
  if ((m = t.match(/volumen\s+(?:de\s+(?:la\s+)?)?(?:pista\s+)?(.+?)\s+(?:a|en)\s+(-?[\d.,]+)/))) return [{ cmd: 'volume', trackId: resolveTrack(/^\d+$/.test(m[1]) ? { index: +m[1] - 1 } : { name: m[1] }, project, t), db: num(m[2]) }];
  if ((m = t.match(/(sube|baja)\s+(?:el\s+|la\s+)?(?:volumen\s+de\s+(?:la\s+)?)?(.+?)\s+(-?[\d.,]+)\s*db/))) return [{ cmd: 'volumeRel', trackId: resolveTrack({ name: m[2].replace(/^pista\s+/, '') }, project, t), db: (m[1] === 'sube' ? 1 : -1) * num(m[3]) }];
  if ((m = t.match(/paneo\s+(?:de\s+(?:la\s+)?)?(.+?)\s+(?:a\s+la\s+)?(izquierda|derecha|centro)\s*(\d+)?/))) { const amt = m[3] ? +m[3] / 100 : (m[2] === 'centro' ? 0 : 0.5); return [{ cmd: 'pan', trackId: resolveTrack({ name: m[1].replace(/^pista\s+/, '') }, project, t), value: m[2] === 'izquierda' ? -amt : m[2] === 'derecha' ? amt : 0 }]; }
  for (const [pl, re] of PLUGIN_WORDS) if (re.test(t) && /(agrega|pon|inserta|anade|aplica|usa|mete)/.test(t)) {
    return [{ cmd: 'insert', plugin: pl, trackId: /master|maestro|mezcla final/.test(t) ? 'master' : trackId() }];
  }
  if (/normaliza/.test(t)) return [{ cmd: 'audiosuite', op: 'normalize', trackId: trackId() }];
  if (/invierte|reversa|al reves/.test(t)) return [{ cmd: 'audiosuite', op: 'reverse', trackId: trackId() }];
  if (/silencios|strip silence/.test(t)) return [{ cmd: 'stripSilence', trackId: trackId() }];
  if (/(reduce|quita|limpia).*(ruido)|denoise/.test(t)) return [{ cmd: 'audiosuite', op: 'denoise', trackId: trackId() }];
  if (/afina|autotune|auto-tune/.test(t)) return [{ cmd: 'autotune', trackId: trackId() }];
  if ((m = t.match(/genera(?:r)?\s+(?:una?\s+)?(?:pista\s+de\s+)?bateria(?:\s+de|\s+estilo)?\s*([\w\-\/]+)?(?:.*?(\d+)\s+compases)?/))) {
    const g = Object.keys(GENRES).find(k => strip(k).startsWith(strip(m[1] || 'pop').slice(0, 4))) || 'Pop';
    return [{ cmd: 'genDrums', genre: g, bars: +(m[2] || 8) }];
  }
  if ((m = t.match(/genera(?:r)?\s+(?:unos?\s+)?acordes(?:\s+en\s+(\w+#?)\s*(mayor|menor)?)?(?:.*?(\d+)\s+compases)?/))) return [{ cmd: 'genChords', key: m[1], mode: m[2], bars: +(m[3] || 8) }];
  if (/genera(?:r)?\s+(?:una?\s+)?(?:linea de\s+)?bajo/.test(t)) return [{ cmd: 'genBass' }];
  if (/genera(?:r)?\s+(?:una?\s+)?melodia/.test(t)) return [{ cmd: 'genMelody' }];
  if (/separa|stems|aisla/.test(t) && !/exporta/.test(t)) return [{ cmd: 'stems', trackId: trackId() }];
  if (/transcrib|subtitul|letra/.test(t)) return [{ cmd: 'transcribe', trackId: trackId() }];
  if (/detecta.*(tempo|bpm)/.test(t)) return [{ cmd: 'detectTempo', trackId: trackId() }];
  if (/detecta.*(tonalidad|tono|escala)/.test(t)) return [{ cmd: 'detectKey', trackId: trackId() }];
  if (/a midi|convierte.*midi/.test(t)) return [{ cmd: 'audioToMidi', trackId: trackId() }];
  if (/mezcla automatica|auto ?mezcla|mezcla por mi|balancea/.test(t)) return [{ cmd: 'automix' }];
  if (/masteriza|master automatico|mastering/.test(t)) return [{ cmd: 'master', target: /club|fuerte/.test(t) ? -9 : /radio|tv|broadcast/.test(t) ? -23 : /podcast|apple/.test(t) ? -16 : -14 }];
  if (/exporta.*stems|bounce.*stems/.test(t)) return [{ cmd: 'exportStems' }];
  if (/exporta|bounce|rebota|renderiza/.test(t)) return [{ cmd: 'export', format: /mp3/.test(t) ? 'mp3' : 'wav' }];
  if (/guarda/.test(t)) return [{ cmd: 'save' }];
  return out;
}

// LLM local opcional: traduce peticiones libres a comandos del asistente
export async function askLocalLLM(text, project, settings) {
  const url = (settings.ollamaUrl || 'http://localhost:11434').replace(/\/$/, '') + '/api/generate';
  const tracks = project.tracks.map((t, i) => `${i + 1}. ${t.name} (${t.type})`).join('\n');
  const prompt = `Eres el asistente de la estación de audio Músicos MX. Convierte la petición del usuario en una lista de órdenes cortas en español, una por línea, usando SOLO estas formas:\n${COMMAND_HELP.join('\n')}\n\nPistas actuales:\n${tracks || '(ninguna)'}\nTempo: ${project.tempo} BPM\n\nPetición: ${text}\n\nResponde únicamente con las órdenes, una por línea, sin explicaciones.`;
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: settings.ollamaModel || 'llama3.2', prompt, stream: false, options: { temperature: 0.1 } }) });
  if (!r.ok) throw new Error('El servidor de IA local respondió ' + r.status);
  const j = await r.json();
  return (j.response || '').split('\n').map(s => s.replace(/^[\-\*\d\.\)\s]+/, '').trim()).filter(Boolean);
}
