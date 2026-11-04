package dev.dropit.app;

import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * RHEA-190: makes dropit an Android share target. The activity's ACTION_SEND(_MULTIPLE) intent is
 * captured here; JS takes it with take() (take-and-clear, so a share is handled once) and gets a
 * "share" event when a new one arrives while the app is running. Shared files are streamed straight
 * from their content:// URI to POST /api/spaces/:id/items/file, so large images never go through JS.
 */
@CapacitorPlugin(name = "DropitShare")
public class DropitSharePlugin extends Plugin {
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final ArrayList<Uri> files = new ArrayList<>();
    private JSObject pending;

    @Override
    public void load() {
        Intent intent = getActivity().getIntent();
        // Re-opening from recents replays the original launch intent; do not send it twice.
        if (intent != null && (intent.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) == 0) capture(intent);
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (capture(intent)) notifyListeners("share", new JSObject(), false);
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
