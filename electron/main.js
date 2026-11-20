// Músicos MX — proceso principal de escritorio (Electron)
// Copyright (C) 2026 Santiago Miguel — GNU GPL v3 o posterior.
const { app, BrowserWindow, ipcMain, dialog, Menu, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');

let win = null;
let pendingFile = process.argv.find(a => /\.mmxs$/i.test(a)) || null;

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 560,
    backgroundColor: '#0d0f14', title: 'Músicos MX',
    icon: path.join(__dirname, '..', 'build', 'icons', '512x512.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, autoplayPolicy: 'no-user-gesture-required' }
  });
  Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([
    { label: 'Músicos MX', submenu: [{ role: 'about', label: 'Acerca de Músicos MX' }, { type: 'separator' }, { role: 'hide', label: 'Ocultar' }, { role: 'quit', label: 'Salir' }] },
    { label: 'Edición', submenu: [{ role: 'cut', label: 'Cortar' }, { role: 'copy', label: 'Copiar' }, { role: 'paste', label: 'Pegar' }, { role: 'selectAll', label: 'Seleccionar todo' }] },
    { label: 'Ventana', submenu: [{ role: 'minimize', label: 'Minimizar' }, { role: 'togglefullscreen', label: 'Pantalla completa' }, { role: 'toggleDevTools', label: 'Herramientas de desarrollo' }] }
  ]) : null);
  win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow', overrideBrowserWindowOptions: { width: 1100, height: 850, autoHideMenuBar: true, icon: path.join(__dirname, '..', 'build', 'icons', '256x256.png') } };
  });
  win.webContents.on('did-finish-load', () => { if (pendingFile) { sendFile(pendingFile); pendingFile = null; } });
  win.on('close', async (e) => {
    if (win.__canClose) return;
    e.preventDefault();
    const dirty = await win.webContents.executeJavaScript('window.mmx && window.mmx.store.dirty').catch(() => false);
    if (!dirty) { win.__canClose = true; win.close(); return; }
    const r = await dialog.showMessageBox(win, { type: 'question', buttons: ['Guardar y salir', 'Salir sin guardar', 'Cancelar'], defaultId: 0, cancelId: 2, message: 'Hay cambios sin guardar en la sesión.' });
    if (r.response === 2) return;
    if (r.response === 0) await win.webContents.executeJavaScript('window.mmx.saveSessionFile()').catch(() => { });
    win.__canClose = true; win.close();
  });
}
function sendFile(p) { try { const data = fs.readFileSync(p); win.webContents.send('open-file', { name: path.basename(p), data }); } catch (e) { } }

ipcMain.handle('save-file', async (_e, { name, data, filters, path: known }) => {
  let target = known;
  if (!target) {
    const r = await dialog.showSaveDialog(win, { defaultPath: name, filters: filters || [] });
    if (r.canceled || !r.filePath) return null;
    target = r.filePath;
  }
  fs.writeFileSync(target, Buffer.from(data));
  return target;
});
ipcMain.handle('open-manual', () => {
  const w = new BrowserWindow({ width: 1100, height: 850, autoHideMenuBar: true, title: 'Manual de Músicos MX', icon: path.join(__dirname, '..', 'build', 'icons', '256x256.png') });
  w.loadFile(path.join(__dirname, '..', 'dist', 'manual', 'index.html'));
});

const single = app.requestSingleInstanceLock();
if (!single) app.quit();
else {
  app.on('second-instance', (_e, argv) => { const f = argv.find(a => /\.mmxs$/i.test(a)); if (win) { if (win.isMinimized()) win.restore(); win.focus(); if (f) sendFile(f); } });
  app.on('open-file', (e, p) => { e.preventDefault(); if (win) sendFile(p); else pendingFile = p; });
  app.whenReady().then(() => {
    // permitir micrófono y MIDI para grabar
    session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(['media', 'midi', 'midiSysex', 'clipboard-read', 'clipboard-sanitized-write'].includes(perm)));
    session.defaultSession.setPermissionCheckHandler((_wc, perm) => ['media', 'midi', 'midiSysex'].includes(perm));
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
