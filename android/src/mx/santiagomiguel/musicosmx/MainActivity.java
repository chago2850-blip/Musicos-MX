/*
 * Músicos MX para Android — contenedor nativo de la estación de audio.
 * Copyright (C) 2026 Santiago Miguel
 * Este programa es software libre: puede redistribuirlo y/o modificarlo bajo los términos de la
 * Licencia Pública General GNU, versión 3 o (a su elección) cualquier versión posterior.
 */
package mx.santiagomiguel.musicosmx;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ContentValues;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.util.Base64;
import android.view.View;
import android.view.Window;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

public class MainActivity extends Activity {
    private static final int REQ_AUDIO = 11, REQ_FILES = 12, REQ_STORAGE = 13;
    private WebView web;
    private PermissionRequest pendingPermission;
    private ValueCallback<Uri[]> fileCallback;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        Window w = getWindow();
        w.setStatusBarColor(Color.parseColor("#0d0f14"));
        w.setNavigationBarColor(Color.parseColor("#0d0f14"));
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#0d0f14"));
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setAllowFileAccessFromFileURLs(true);
        s.setAllowUniversalAccessFromFileURLs(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setTextZoom(100);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.addJavascriptInterface(new Bridge(), "MMXAndroid");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                Uri u = Uri.parse(url);
                String sch = u.getScheme();
                if ("http".equals(sch) || "https".equals(sch) || "mailto".equals(sch) || "tel".equals(sch)) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception e) { }
                    return true;
                }
                return false;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(new Runnable() { public void run() {
                    if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                        request.grant(request.getResources());
                    } else {
                        pendingPermission = request;
                        requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_AUDIO);
                    }
                }});
            }
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                try { startActivityForResult(Intent.createChooser(i, "Elegir archivo"), REQ_FILES); }
                catch (Exception e) { fileCallback = null; return false; }
                return true;
            }
        });
        if (Build.VERSION.SDK_INT < 29 && checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, REQ_STORAGE);
        }
        if (state != null) web.restoreState(state);
        else web.loadUrl("file:///android_asset/www/index.html");
    }

    @Override
    protected void onSaveInstanceState(Bundle out) { super.onSaveInstanceState(out); web.saveState(out); }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] res) {
        if (code == REQ_AUDIO && pendingPermission != null) {
            if (res.length > 0 && res[0] == PackageManager.PERMISSION_GRANTED) pendingPermission.grant(pendingPermission.getResources());
            else { pendingPermission.deny(); Toast.makeText(this, "Sin permiso de micrófono no se puede grabar.", Toast.LENGTH_LONG).show(); }
            pendingPermission = null;
        }
    }

    @Override
    protected void onActivityResult(int code, int result, Intent data) {
        if (code == REQ_FILES && fileCallback != null) {
            Uri[] uris = null;
            if (result == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int n = data.getClipData().getItemCount();
                    uris = new Uri[n];
                    for (int k = 0; k < n; k++) uris[k] = data.getClipData().getItemAt(k).getUri();
                } else if (data.getData() != null) uris = new Uri[]{data.getData()};
            }
            fileCallback.onReceiveValue(uris);
            fileCallback = null;
            return;
        }
        super.onActivityResult(code, result, data);
    }

    @Override
    public void onBackPressed() {
        new AlertDialog.Builder(this).setTitle("Músicos MX").setMessage("¿Salir de la aplicación? Guarda tu sesión antes de salir.")
            .setPositiveButton("Salir", new DialogInterface.OnClickListener() { public void onClick(DialogInterface d, int i) { finish(); } })
            .setNegativeButton("Cancelar", null).show();
    }

    @Override
    protected void onPause() { super.onPause(); web.evaluateJavascript("window.mmx&&window.mmx.autosave&&window.mmx.autosave()", null); }

    private static String mime(String name) {
        String n = name.toLowerCase();
        if (n.endsWith(".wav")) return "audio/wav";
        if (n.endsWith(".mp3")) return "audio/mpeg";
        if (n.endsWith(".mid")) return "audio/midi";
        if (n.endsWith(".zip") || n.endsWith(".mmxs")) return "application/zip";
        if (n.endsWith(".srt") || n.endsWith(".txt")) return "text/plain";
        return "application/octet-stream";
    }

    /** Puente JavaScript: guardar archivos en Descargas/MusicosMX */
    public class Bridge {
        @JavascriptInterface
        public String saveFile(String name, String base64) {
            try {
                byte[] data = Base64.decode(base64, Base64.DEFAULT);
                String safe = name.replaceAll("[\\\\/:*?\"<>|]", "_");
                String where;
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues v = new ContentValues();
                    v.put("_display_name", safe);
                    v.put("mime_type", mime(safe));
                    v.put("relative_path", "Download/MusicosMX");
                    Uri uri = getContentResolver().insert(Uri.parse("content://media/external/downloads"), v);
                    OutputStream os = getContentResolver().openOutputStream(uri);
                    os.write(data); os.close();
                    where = "Descargas/MusicosMX/" + safe;
                } else {
                    File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "MusicosMX");
                    if (!dir.exists() && !dir.mkdirs()) dir = getExternalFilesDir(null);
                    File f = new File(dir, safe);
                    FileOutputStream fo = new FileOutputStream(f); fo.write(data); fo.close();
                    where = f.getAbsolutePath();
                }
                final String msg = "Guardado en " + where;
                runOnUiThread(new Runnable() { public void run() { Toast.makeText(MainActivity.this, msg, Toast.LENGTH_LONG).show(); } });
                return where;
            } catch (Exception e) {
                try {
                    File f = new File(getExternalFilesDir(null), name);
                    FileOutputStream fo = new FileOutputStream(f); fo.write(Base64.decode(base64, Base64.DEFAULT)); fo.close();
                    return f.getAbsolutePath();
                } catch (Exception e2) { return ""; }
            }
        }
        @JavascriptInterface
        public String platform() { return "android"; }
    }
}
