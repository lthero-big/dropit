package dev.dropit.app;

import java.net.URI;
import java.util.Locale;

/**
 * RHEA-190 au: pure checks for the in-app update download (unit tested, no Android classes).
 * An update APK is only fetched from the configured server's own https origin and only from
 * /api/app/android/download/<name>.apk; it is only installed when its SHA-256 matches the manifest.
 */
final class UpdateFiles {
    static final long MAX_BYTES = 200L * 1024 * 1024;

    private UpdateFiles() {}

    static boolean isUpdateUrl(String serverOrigin, String url) {
        if (serverOrigin == null || url == null) return false;
        try {
            URI uri = new URI(url);
            if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null || uri.getRawUserInfo() != null) return false;
            if (uri.getRawQuery() != null || uri.getRawFragment() != null) return false;
            int port = uri.getPort();
            String origin = "https://" + uri.getHost().toLowerCase(Locale.ROOT) + (port == -1 || port == 443 ? "" : ":" + port);
            String path = uri.getRawPath();
            return origin.equals(serverOrigin) && path != null && !path.contains("..")
                && path.matches("/api/app/android/download/[A-Za-z0-9][A-Za-z0-9._-]{0,120}\\.apk");
        } catch (Exception e) {
            return false;
        }
    }

    static boolean isSha256(String hex) {
        return hex != null && hex.matches("[0-9a-f]{64}");
    }

    static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) out.append(String.format(Locale.ROOT, "%02x", b & 0xff));
        return out.toString();
    }
}
