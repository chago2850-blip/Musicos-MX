// Músicos MX — compila la interfaz web en dist/ (GPL-3.0-o-posterior)
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const dev = process.argv.includes('--dev');
rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });
await build({ entryPoints: ['src/js/app.js'], bundle: true, format: 'iife', target: ['chrome100'], outfile: 'dist/app.js', minify: !dev, sourcemap: dev, legalComments: 'eof', logLevel: 'info' });
cpSync('src/index.html', 'dist/index.html');
cpSync('src/styles.css', 'dist/styles.css');
cpSync('src/img', 'dist/img', { recursive: true });
if (existsSync('docs/manual')) cpSync('docs/manual', 'dist/manual', { recursive: true });
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
writeFileSync('dist/version.json', JSON.stringify({ version: pkg.version }));
console.log('dist/ listo, versión', pkg.version);
