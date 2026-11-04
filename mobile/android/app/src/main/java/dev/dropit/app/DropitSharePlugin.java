package dev.dropit.app;

import android.app.DownloadManager;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;
import android.provider.OpenableColumns;
import android.webkit.CookieManager;
import android.webkit.MimeTypeMap;
import android.webkit.URLUtil;
import android.webkit.WebView;
import android.widget.Toast;
import androidx.core.content.FileProvider;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.WebViewListener;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Locale;
import java.util.Iterator;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

/**
 * RHEA-190: makes dropit an Android share target. The activity's ACTION_SEND(_MULTIPLE) intent is
 * captured here; JS takes it with take() (take-and-clear, so a share is handled once) and gets a
 * "share" event when a new one arrives while the app is running. Shared files are streamed straight
 * from their content:// URI to POST /api/spaces/:id/items/file, so large images never go through JS.
 *
 * RHEA-190 ui: after login the WebView shows the configured server's full web UI. Only that origin
 * stays inside the app (shouldOverrideLoad); every other http(s) link goes to the system browser.
 * On that origin, and only there, a small script (assets public/inject.js) adds the app button, and
 * an origin-restricted bridge object (DropitApp, WebViewCompat.addWebMessageListener) lets it read the
 * clipboard when the user taps 「从剪贴板发送」 and return to the app's own settings page.
 */
@CapacitorPlugin(name = "DropitShare")
public class DropitSharePlugin extends Plugin {
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final ArrayList<Uri> files = new ArrayList<>();
    private JSObject pending;
    private static final String PREFS = "dropit_app";
    private static final String BRIDGE_NAME = "DropitApp";
    /** scheme://host[:port] of the configured server, or null before setup. */
    private String serverOrigin;
    private boolean bridgeRegistered;
    private String injectScript;

    @Override
    public void load() {
        Intent intent = getActivity().getIntent();
        // Re-opening from recents replays the original launch intent; do not send it twice.
        if (intent != null && (intent.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) == 0) capture(intent);
        serverOrigin = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("origin", null);
        registerBridge();
        WebView webView = getBridge().getWebView();
        webView.setDownloadListener(this::download);
        getBridge().addWebViewListener(new WebViewListener() {
            @Override
            public void onPageLoaded(WebView view) {
                inject(view);
            }
        });
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (!capture(intent)) return;
        WebView webView = getBridge().getWebView();
        String current = webView.getUrl();
        if (current != null && isServer(Uri.parse(current))) {
            // The web UI is showing: hand the share to the app page, which sends it and returns to the web UI.
            webView.loadUrl(getBridge().getLocalUrl() + "/#share");
        } else {
            notifyListeners("share", new JSObject(), false);
        }
    }

    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        CookieManager.getInstance().flush();
    }

    static String originOf(Uri uri) {
        if (uri == null || uri.getScheme() == null || uri.getHost() == null) return null;
        String scheme = uri.getScheme().toLowerCase(Locale.ROOT);
        if (!scheme.equals("https") && !scheme.equals("http")) return null;
        int port = uri.getPort();
        boolean defaultPort = port == -1 || (scheme.equals("https") && port == 443) || (scheme.equals("http") && port == 80);
        return scheme + "://" + uri.getHost().toLowerCase(Locale.ROOT) + (defaultPort ? "" : ":" + port);
    }

    private boolean isServer(Uri uri) {
        String origin = originOf(uri);
        return origin != null && origin.equals(serverOrigin);
    }

    /** Keeps the configured server inside the app; other web links open in the system browser. */
    @Override
    public Boolean shouldOverrideLoad(Uri url) {
        String origin = originOf(url);
        if (origin == null) return null; // mailto:, tel:, intent: … use Capacitor's default handling
        if (origin.equals(serverOrigin)) return false;
        Uri app = Uri.parse(getBridge().getAppUrl());
        if (url.getHost() != null && url.getHost().equalsIgnoreCase(app.getHost()) && origin.startsWith(String.valueOf(app.getScheme()))) return null;
        try {
            getContext().startActivity(new Intent(Intent.ACTION_VIEW, url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (Exception ignored) {
            // No browser installed.
        }
        return true;
    }

    @PluginMethod
    public void setServer(PluginCall call) {
        String url = call.getString("url", "");
        String origin = url == null || url.isEmpty() ? null : originOf(Uri.parse(url));
        if (origin != null && !origin.startsWith("https://")) {
            call.reject("only https:// servers are supported");
            return;
        }
        boolean changed = origin == null ? serverOrigin != null : !origin.equals(serverOrigin);
        serverOrigin = origin;
        getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("origin", origin).apply();
        if (origin == null) {
            // Signed out / switching servers: drop the web session cookie this WebView holds.
            CookieManager.getInstance().removeAllCookies(null);
            CookieManager.getInstance().flush();
        }
        if (changed) getActivity().runOnUiThread(this::registerBridge);
        call.resolve();
    }

    private void registerBridge() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return;
        WebView webView = getBridge().getWebView();
        if (bridgeRegistered) {
            WebViewCompat.removeWebMessageListener(webView, BRIDGE_NAME);
            bridgeRegistered = false;
        }
        if (serverOrigin == null) return;
        try {
            WebViewCompat.addWebMessageListener(webView, BRIDGE_NAME, Collections.singleton(serverOrigin), this::onWebMessage);
            bridgeRegistered = true;
        } catch (Exception ignored) {
            // Invalid origin rule: the web UI still works, only the app button has no bridge.
        }
    }

    private void onWebMessage(WebView view, WebMessageCompat message, Uri sourceOrigin, boolean isMainFrame, JavaScriptReplyProxy reply) {
        if (!isMainFrame || !isServer(sourceOrigin) || message.getData() == null) return;
        String type;
        try {
            type = new JSONObject(message.getData()).optString("type");
        } catch (Exception e) {
            return;
        }
        if ("clipboard".equals(type)) {
            // Only ever called from a tap on 「从剪贴板发送」 while the app is in the foreground.
            JSONObject out = new JSONObject();
            try {
                out.put("type", "clipboard");
                ClipboardManager clipboard = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
                ClipData clip = clipboard == null ? null : clipboard.getPrimaryClip();
                StringBuilder text = new StringBuilder();
                if (clip != null) {
                    for (int i = 0; i < clip.getItemCount(); i++) {
                        CharSequence part = clip.getItemAt(i).coerceToText(getContext());
                        if (part != null && part.length() > 0) {
                            if (text.length() > 0) text.append('\n');
                            text.append(part);
                        }
                    }
                }
                out.put("text", text.toString());
            } catch (Exception e) {
                try { out.put("error", String.valueOf(e.getMessage())); } catch (Exception ignored) { /* unreachable */ }
            }
            reply.postMessage(out.toString());
        } else if ("settings".equals(type)) {
            view.loadUrl(getBridge().getLocalUrl() + "/#settings");
        } else if ("update".equals(type)) {
            // RHEA-190 au: 「检查更新」 in the web UI's app menu.
            view.loadUrl(getBridge().getLocalUrl() + "/#update");
        }
    }

    private void inject(WebView view) {
        String url = view.getUrl();
        if (url == null || !isServer(Uri.parse(url))) return;
        if (injectScript == null) {
            try (InputStream in = getContext().getAssets().open("public/inject.js")) {
                injectScript = readAll(in);
            } catch (IOException e) {
                return;
            }
        }
        view.evaluateJavascript(injectScript, null);
    }

    /**
     * File downloads from the web UI (Content-Disposition: attachment) go to Downloads with the session cookie.
     * RHEA-190 dl: the name comes from filename*= (RFC 5987, UTF-8, e.g. Chinese names) and the type from the
     * extension when the server only says application/octet-stream; before, everything became download.bin.
     */
    private void download(String url, String userAgent, String contentDisposition, String mimeType, long contentLength) {
        if (url.startsWith("blob:") || url.startsWith("data:")) {
            Toast.makeText(getContext(), "这种下载应用里暂不支持，请在浏览器里打开 dropit 下载", Toast.LENGTH_LONG).show();
            return;
        }
        Uri uri = Uri.parse(url);
        if (!isServer(uri)) {
            shouldOverrideLoad(uri);
            return;
        }
        try {
            String name = DownloadName.fromContentDisposition(contentDisposition);
            if (name == null) name = DownloadName.sanitize(URLUtil.guessFileName(url, contentDisposition, mimeType));
            if (name == null) name = "dropit-download";
            MimeTypeMap types = MimeTypeMap.getSingleton();
            String ext = DownloadName.extension(name);
            String mime = DownloadName.baseMime(mimeType);
            if (DownloadName.genericMime(mime)) {
                String guessed = ext == null ? null : types.getMimeTypeFromExtension(ext);
                mime = guessed != null ? guessed : "application/octet-stream";
            } else if (ext == null) {
                String guessedExt = types.getExtensionFromMimeType(mime);
                if (guessedExt != null) name = name + "." + guessedExt;
            }
            DownloadManager.Request request = new DownloadManager.Request(uri);
            String cookie = CookieManager.getInstance().getCookie(url);
            if (cookie != null) request.addRequestHeader("Cookie", cookie);
            request.addRequestHeader("User-Agent", userAgent);
            request.setMimeType(mime);
            request.setTitle(name);
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
            DownloadManager manager = (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
            manager.enqueue(request);
            Toast.makeText(getContext(), "正在下载 " + name, Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            Toast.makeText(getContext(), "下载失败：" + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    @SuppressWarnings("deprecation")
    private synchronized boolean capture(Intent intent) {
        if (intent == null) return false;
        String action = intent.getAction();
        boolean single = Intent.ACTION_SEND.equals(action);
        if (!single && !Intent.ACTION_SEND_MULTIPLE.equals(action)) return false;
        JSObject out = new JSObject();
        CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        if (text != null) out.put("text", text.toString());
        if (subject != null) out.put("subject", subject);
        ArrayList<Uri> uris = new ArrayList<>();
        if (single) {
            Uri uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (uri != null) uris.add(uri);
        } else {
            ArrayList<Uri> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (list != null) uris.addAll(list);
        }
        ContentResolver resolver = getContext().getContentResolver();
        JSArray list = new JSArray();
        for (Uri uri : uris) {
            if (uri == null) continue;
            JSObject file = new JSObject();
            file.put("id", String.valueOf(files.size()));
            files.add(uri);
            String[] info = describe(resolver, uri);
            file.put("name", info[0]);
            file.put("size", Long.parseLong(info[1]));
            String mime = resolver.getType(uri);
            if (mime == null) mime = intent.getType();
            if (mime == null || mime.contains("*")) mime = "application/octet-stream";
            file.put("mime", mime);
            list.put(file);
        }
        out.put("files", list);
        pending = out;
        return true;
    }

    private static String[] describe(ContentResolver resolver, Uri uri) {
        String name = uri.getLastPathSegment();
        long size = -1;
        try (Cursor cursor = resolver.query(uri, new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE }, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int n = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                int s = cursor.getColumnIndex(OpenableColumns.SIZE);
                if (n >= 0 && !cursor.isNull(n)) name = cursor.getString(n);
                if (s >= 0 && !cursor.isNull(s)) size = cursor.getLong(s);
            }
        } catch (Exception ignored) {
            // Some providers refuse queries; fall back to the URI's last segment.
        }
        if (name == null || name.isEmpty()) name = "shared";
        return new String[] { name, String.valueOf(size) };
    }

    @PluginMethod
    public void take(PluginCall call) {
        JSObject result = new JSObject();
        synchronized (this) {
            if (pending != null) result.put("share", pending);
            pending = null;
        }
        call.resolve(result);
    }

    @PluginMethod
    public void uploadFile(PluginCall call) {
        final Uri uri;
        synchronized (this) {
            int index;
            try {
                index = Integer.parseInt(call.getString("id", "-1"));
            } catch (NumberFormatException e) {
                index = -1;
            }
            if (index < 0 || index >= files.size()) {
                call.reject("unknown shared file");
                return;
            }
            uri = files.get(index);
        }
        final String url = call.getString("url", "");
        final String token = call.getString("token", "");
        final String name = call.getString("name", "shared");
        final String mime = call.getString("mime", "application/octet-stream");
        final JSObject headers = call.getObject("headers", new JSObject());
        if (!url.startsWith("https://")) {
            call.reject("only https:// servers are supported");
            return;
        }
        io.execute(() -> {
            HttpURLConnection conn = null;
            try (InputStream in = getContext().getContentResolver().openInputStream(uri)) {
                if (in == null) throw new IOException("cannot open shared file");
                conn = (HttpURLConnection) new URL(url).openConnection();
                conn.setRequestMethod("POST");
                conn.setDoOutput(true);
                conn.setConnectTimeout(15000);
                conn.setReadTimeout(120000);
                conn.setChunkedStreamingMode(64 * 1024);
                conn.setRequestProperty("Authorization", "Bearer " + token);
                conn.setRequestProperty("Content-Type", mime);
                conn.setRequestProperty("X-File-Name", Uri.encode(name));
                Iterator<String> keys = headers.keys();
                while (keys.hasNext()) {
                    String key = keys.next();
                    conn.setRequestProperty(key, headers.getString(key));
                }
                try (OutputStream out = conn.getOutputStream()) {
                    byte[] buffer = new byte[64 * 1024];
                    int read;
                    while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
                }
                int status = conn.getResponseCode();
                InputStream body = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
                JSObject result = new JSObject();
                result.put("status", status);
                result.put("body", body == null ? "" : readAll(body));
                call.resolve(result);
            } catch (Exception e) {
                JSObject result = new JSObject();
                result.put("status", 0);
                result.put("body", "");
                result.put("error", String.valueOf(e.getMessage()));
                call.resolve(result);
            } finally {
                if (conn != null) conn.disconnect();
            }
        });
    }

    // ---- RHEA-190 au: in-app updates ----

    /** Installed versionCode / versionName, for comparing with GET /api/app/android/latest. */
    @PluginMethod
    public void appInfo(PluginCall call) {
        try {
            PackageInfo info = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            long code = Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
            JSObject result = new JSObject();
            result.put("versionCode", code);
            result.put("versionName", info.versionName);
            call.resolve(result);
        } catch (Exception e) {
            call.reject(String.valueOf(e.getMessage()));
        }
    }

    /**
     * Downloads the update APK from the configured server (https, /api/app/android/download/ only) into the
     * app cache, checks size and SHA-256 against the manifest and hands it to the system installer through
     * the FileProvider. Android itself refuses an update signed with another key. Without the 「安装未知应用」
     * permission it opens that settings page first and resolves { needsPermission: true }.
     */
    @PluginMethod
    public void installUpdate(PluginCall call) {
        final String url = call.getString("url", "");
        final String sha256 = call.getString("sha256", "");
        final long size = call.getData().optLong("size", -1);
        if (!UpdateFiles.isUpdateUrl(serverOrigin, url)) {
            call.reject("更新只能从当前 https 服务器下载");
            return;
        }
        if (!UpdateFiles.isSha256(sha256) || size <= 0 || size > UpdateFiles.MAX_BYTES) {
            call.reject("更新信息无效");
            return;
        }
        if (Build.VERSION.SDK_INT >= 26 && !getContext().getPackageManager().canRequestPackageInstalls()) {
            try {
                Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()));
                getActivity().startActivity(settings);
            } catch (Exception ignored) {
                // Some ROMs hide the per-app page; the message in the app explains what to allow.
            }
            JSObject result = new JSObject();
            result.put("needsPermission", true);
            call.resolve(result);
            return;
        }
        new Thread(() -> {
            HttpURLConnection conn = null;
            File dir = new File(getContext().getCacheDir(), "updates");
            File apk = new File(dir, "dropit-update.apk");
            try {
                if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("cannot create cache directory");
                File[] old = dir.listFiles();
                if (old != null) for (File f : old) f.delete();
                conn = (HttpURLConnection) new URL(url).openConnection();
                conn.setInstanceFollowRedirects(false);
                conn.setConnectTimeout(15000);
                conn.setReadTimeout(60000);
                int status = conn.getResponseCode();
                if (status != 200) throw new IOException("HTTP " + status);
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                long received = 0;
                long reported = 0;
                try (InputStream in = conn.getInputStream(); OutputStream out = new FileOutputStream(apk)) {
                    byte[] buffer = new byte[64 * 1024];
                    int read;
                    while ((read = in.read(buffer)) != -1) {
                        received += read;
                        if (received > size) throw new IOException("安装包比服务器说明的大");
                        digest.update(buffer, 0, read);
                        out.write(buffer, 0, read);
                        if (received - reported >= 256 * 1024 || received == size) {
                            reported = received;
                            JSObject progress = new JSObject();
                            progress.put("received", received);
                            progress.put("total", size);
                            notifyListeners("updateProgress", progress);
                        }
                    }
                }
                if (received != size) throw new IOException("下载不完整");
                if (!UpdateFiles.hex(digest.digest()).equals(sha256)) throw new IOException("安装包校验失败（SHA-256 不一致）");
                Uri content = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk);
                Intent install = new Intent(Intent.ACTION_VIEW)
                    .setDataAndType(content, "application/vnd.android.package-archive")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                getActivity().startActivity(install);
                JSObject result = new JSObject();
                result.put("started", true);
                call.resolve(result);
            } catch (Exception e) {
                apk.delete();
                call.reject(String.valueOf(e.getMessage()));
            } finally {
                if (conn != null) conn.disconnect();
            }
        }, "dropit-update").start();
    }

    private static String readAll(InputStream in) throws IOException {
        try (InputStream stream = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int read;
            while ((read = stream.read(buffer)) != -1 && out.size() < 65536) out.write(buffer, 0, read);
            return out.toString(StandardCharsets.UTF_8.name());
        }
    }
}
