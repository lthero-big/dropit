package dev.dropit.app;

import java.io.ByteArrayOutputStream;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * RHEA-190 dl: file name and type for a WebView download. Android's URLUtil.guessFileName ignores
 * RFC 5987 filename*= (which dropit uses for every real name) and turns application/octet-stream into
 * ".bin", so every file used to be saved as download.bin. Pure Java so it is covered by unit tests.
 */
final class DownloadName {
    private DownloadName() {}

    private static final Pattern EXTENDED = Pattern.compile(
        "(?:^|;)\\s*filename\\*\\s*=\\s*([A-Za-z0-9!#$&+^_`{}~.-]*)'[^']*'([^;\\s]+)", Pattern.CASE_INSENSITIVE);
    private static final Pattern PLAIN = Pattern.compile(
        "(?:^|;)\\s*filename\\s*=\\s*(?:\"((?:[^\"\\\\]|\\\\.)*)\"|([^;\\s]+))", Pattern.CASE_INSENSITIVE);

    /** Real file name from a Content-Disposition header (filename* first, then filename), or null. */
    static String fromContentDisposition(String header) {
        if (header == null) return null;
        Matcher m = EXTENDED.matcher(header);
        if (m.find()) {
            String name = sanitize(percentDecode(m.group(2), m.group(1)));
            if (name != null) return name;
        }
        m = PLAIN.matcher(header);
        if (m.find()) {
            String raw = m.group(1) != null ? m.group(1).replaceAll("\\\\(.)", "$1") : m.group(2);
            return sanitize(raw);
        }
        return null;
    }

    /** %XX decoding in the given charset (default UTF-8). '+' stays a plus, unlike URLDecoder. */
    static String percentDecode(String value, String charset) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c == '%' && i + 2 < value.length() && hex(value.charAt(i + 1)) >= 0 && hex(value.charAt(i + 2)) >= 0) {
                out.write(hex(value.charAt(i + 1)) * 16 + hex(value.charAt(i + 2)));
                i += 2;
            } else {
                byte[] bytes = String.valueOf(c).getBytes(StandardCharsets.UTF_8);
                out.write(bytes, 0, bytes.length);
            }
        }
        Charset cs = StandardCharsets.UTF_8;
        try {
            if (charset != null && !charset.isEmpty()) cs = Charset.forName(charset);
        } catch (Exception ignored) {
            // Unknown charset: UTF-8 is what dropit sends anyway.
        }
        return new String(out.toByteArray(), cs);
    }

    private static int hex(char c) {
        if (c >= '0' && c <= '9') return c - '0';
        if (c >= 'a' && c <= 'f') return c - 'a' + 10;
        if (c >= 'A' && c <= 'F') return c - 'A' + 10;
        return -1;
    }

    /** Safe single file name: no path, no control or reserved characters, at most 180 chars. */
    static String sanitize(String name) {
        if (name == null) return null;
        String base = name.substring(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1);
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < base.length(); ) {
            int cp = base.codePointAt(i);
            i += Character.charCount(cp);
            if (cp < 0x20 || cp == 0x7f || ":*?\"<>|".indexOf(cp) >= 0) out.append('_');
            else out.appendCodePoint(cp);
        }
        String clean = out.toString().trim();
        while (clean.startsWith(".")) clean = clean.substring(1);
        if (clean.isEmpty()) return null;
        if (clean.length() > 180) {
            String ext = extension(clean);
            String suffix = ext == null || ext.length() > 16 ? "" : "." + ext;
            clean = clean.substring(0, 180 - suffix.length()) + suffix;
        }
        return clean;
    }

    /** Extension without the dot (lower case), or null. */
    static String extension(String name) {
        if (name == null) return null;
        int dot = name.lastIndexOf('.');
        if (dot <= 0 || dot == name.length() - 1) return null;
        String ext = name.substring(dot + 1);
        return ext.matches("[A-Za-z0-9]{1,16}") ? ext.toLowerCase(Locale.ROOT) : null;
    }

    /** MIME types that say nothing about the file, so the extension decides. */
    static boolean genericMime(String mime) {
        if (mime == null) return true;
        String m = baseMime(mime);
        return m.isEmpty() || m.equals("application/octet-stream") || m.equals("binary/octet-stream")
            || m.equals("application/download") || m.equals("application/force-download") || m.equals("application/x-download")
            || m.equals("application/unknown");
    }

    static String baseMime(String mime) {
        if (mime == null) return "";
        int semi = mime.indexOf(';');
        return (semi >= 0 ? mime.substring(0, semi) : mime).trim().toLowerCase(Locale.ROOT);
    }
}
