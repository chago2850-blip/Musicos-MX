// Músicos MX — genera el manual HTML (y PDF con --pdf) a partir de docs/MANUAL.md (GPL-3.0-o-posterior)
import { marked } from 'marked';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
const md = readFileSync('docs/MANUAL.md', 'utf8');
const slug = (t) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '');
const toc = [];
const renderer = new marked.Renderer();
renderer.heading = function ({ tokens, depth }) {
  const text = this.parser.parseInline(tokens); const plain = text.replace(/<[^>]+>/g, '');
  const id = slug(plain); if (depth === 2 || depth === 3) toc.push({ depth, id, text: plain });
  return `<h${depth} id="${id}">${text}</h${depth}>\n`;
};
const body = marked.parse(md, { renderer, gfm: true });
const tocHtml = toc.map(t => `<a class="l${t.depth}" href="#${t.id}">${t.text}</a>`).join('\n');
const html = `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Manual del usuario — Músicos MX</title><link rel="icon" href="img/logo.png">
<style>
:root{--a:#ff3d7f;--g:#ffb547;--t:#2ee6c5;--bg:#0f1117;--p:#171b24;--tx:#e6e9f0;--d:#9aa3b8;--l:#2a3040}
*{box-sizing:border-box}body{margin:0;font:16px/1.65 system-ui,-apple-system,"Segoe UI",Roboto,Ubuntu,sans-serif;background:var(--bg);color:var(--tx)}
nav{position:fixed;top:0;left:0;bottom:0;width:290px;overflow:auto;background:var(--p);border-right:1px solid var(--l);padding:18px 14px}
nav .brand{display:flex;gap:10px;align-items:center;font-weight:800;font-size:18px;margin-bottom:14px}nav .brand img{width:36px;border-radius:8px}
nav a{display:block;color:var(--d);text-decoration:none;padding:3px 6px;border-radius:5px;font-size:14px}nav a:hover{background:#232a38;color:#fff}nav a.l3{padding-left:20px;font-size:13px}
main{margin-left:290px;padding:30px 54px 80px;max-width:1080px}
h1{font-size:36px;margin:0 0 6px;background:linear-gradient(90deg,var(--a),var(--g));-webkit-background-clip:text;background-clip:text;color:transparent}
h2{margin-top:46px;padding-bottom:6px;border-bottom:2px solid var(--l);font-size:26px}h3{margin-top:28px;color:var(--g)}
a{color:var(--t)}img{max-width:100%;border-radius:10px;border:1px solid var(--l);box-shadow:0 10px 30px rgba(0,0,0,.4);margin:10px 0}
table{border-collapse:collapse;width:100%;margin:14px 0;font-size:14.5px}td,th{border:1px solid var(--l);padding:7px 10px;vertical-align:top}th{background:#1d2230;text-align:left}tr:nth-child(even) td{background:#141821}
code{background:#1d2230;padding:1px 6px;border-radius:4px;font-size:.92em}pre{background:#0a0c10;padding:14px;border-radius:8px;overflow:auto;border:1px solid var(--l)}pre code{background:none;padding:0}
blockquote{border-left:4px solid var(--g);margin:14px 0;padding:6px 16px;background:#1a1810;color:#e8dcc0;border-radius:0 8px 8px 0}
hr{border:0;border-top:1px solid var(--l);margin:30px 0}
@media (max-width:900px){nav{position:static;width:auto;max-height:none}main{margin:0;padding:18px}}
@media print{nav{display:none}main{margin:0;padding:0 8mm;max-width:none}body{background:#fff;color:#111;font-size:11pt}h1{color:#c2185b;-webkit-text-fill-color:#c2185b}h2{border-color:#ddd;page-break-before:auto}h3{color:#b26a00}th{background:#f2f2f2}tr:nth-child(even) td{background:#fafafa}td,th{border-color:#ccc}code,pre{background:#f4f4f4;color:#111;border-color:#ddd}img{box-shadow:none;border-color:#ccc;page-break-inside:avoid}a{color:#00796b}blockquote{background:#fff8e1;color:#5d4300}table{page-break-inside:auto}tr{page-break-inside:avoid}}
</style></head><body>
<nav><div class="brand"><img src="img/logo.png" alt="">Músicos MX</div>${tocHtml}</nav>
<main>${body}</main></body></html>`;
mkdirSync('docs/manual/img', { recursive: true });
copyFileSync('src/img/logo.png', 'docs/manual/img/logo.png');
writeFileSync('docs/manual/index.html', html);
console.log('docs/manual/index.html generado,', toc.length, 'secciones');
if (process.argv.includes('--pdf')) {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const puppeteer = require('puppeteer-core');
  const exe = process.env.CHROME || '/usr/bin/google-chrome';
  const b = await puppeteer.launch({ executablePath: exe, headless: 'new', args: ['--no-sandbox', '--allow-file-access-from-files'] });
  const pg = await b.newPage();
  await pg.goto('file://' + process.cwd() + '/docs/manual/index.html', { waitUntil: 'load' });
  await pg.pdf({ path: 'docs/Manual-Musicos-MX.pdf', format: 'A4', printBackground: true, margin: { top: '16mm', bottom: '16mm', left: '10mm', right: '10mm' }, displayHeaderFooter: true, headerTemplate: '<div style="font-size:8px;width:100%;text-align:right;padding-right:10mm;color:#888">Manual del usuario — Músicos MX</div>', footerTemplate: '<div style="font-size:8px;width:100%;text-align:center;color:#888"><span class="pageNumber"></span> / <span class="totalPages"></span></div>' });
  await b.close(); console.log('docs/Manual-Musicos-MX.pdf generado');
}
