package dev.dropit.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** RHEA-190 dl: names from real dropit headers must not turn into download.bin. */
public class DownloadNameTest {
    @Test
    public void prefersRfc5987Name() {
        assertEquals("报告 2026.pdf",
            DownloadName.fromContentDisposition("attachment; filename=\"download.pdf\"; filename*=UTF-8''%E6%8A%A5%E5%91%8A%202026.pdf"));
        assertEquals("a+b (1).zip",
            DownloadName.fromContentDisposition("attachment; filename=\"a+b _1_.zip\"; filename*=UTF-8''a%2Bb%20%281%29.zip"));
        assertEquals("photo.jpg", DownloadName.fromContentDisposition("attachment; FILENAME*=utf-8'en'photo.jpg"));
    }

    @Test
    public void fallsBackToPlainName() {
        assertEquals("notes.txt", DownloadName.fromContentDisposition("attachment; filename=\"notes.txt\""));
        assertEquals("notes.txt", DownloadName.fromContentDisposition("attachment; filename=notes.txt"));
        assertEquals("a\"b.txt".replace('"', '_'), DownloadName.fromContentDisposition("attachment; filename=\"a\\\"b.txt\""));
        assertNull(DownloadName.fromContentDisposition("attachment"));
        assertNull(DownloadName.fromContentDisposition(null));
    }

    @Test
    public void sanitizesPathsAndReservedCharacters() {
        assertEquals("passwd", DownloadName.fromContentDisposition("attachment; filename*=UTF-8''..%2F..%2Fetc%2Fpasswd"));
        assertEquals("a_b_c.txt", DownloadName.sanitize("a:b\nc.txt"));
        assertEquals("env", DownloadName.sanitize(".env"));
        assertNull(DownloadName.sanitize("..."));
        String longName = DownloadName.sanitize(new String(new char[300]).replace('\0', 'x') + ".mp4");
        assertEquals(180, longName.length());
        assertTrue(longName.endsWith(".mp4"));
    }

    @Test
    public void extensionsAndGenericTypes() {
        assertEquals("pdf", DownloadName.extension("报告.PDF"));
        assertNull(DownloadName.extension("README"));
        assertTrue(DownloadName.genericMime("application/octet-stream"));
        assertTrue(DownloadName.genericMime(null));
        assertFalse(DownloadName.genericMime("image/png; charset=binary"));
        assertEquals("image/png", DownloadName.baseMime("Image/PNG; x=y"));
    }
}
