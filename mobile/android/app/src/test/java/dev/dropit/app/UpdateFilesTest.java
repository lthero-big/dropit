package dev.dropit.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import org.junit.Test;

public class UpdateFilesTest {
    private static final String SERVER = "https://dropit.lthero.com";

    @Test
    public void onlyTheServersOwnDownloadPath() {
        assertTrue(UpdateFiles.isUpdateUrl(SERVER, "https://dropit.lthero.com/api/app/android/download/dropit-android-0.3.2.apk"));
        assertTrue(UpdateFiles.isUpdateUrl(SERVER, "https://DROPIT.lthero.com:443/api/app/android/download/a.apk"));
        assertFalse(UpdateFiles.isUpdateUrl(SERVER, "http://dropit.lthero.com/api/app/android/download/a.apk"));
        assertFalse(UpdateFiles.isUpdateUrl(SERVER, "https://evil.example/api/app/android/download/a.apk"));
        assertFalse(UpdateFiles.isUpdateUrl(SERVER, "https://dropit.lthero.com:8443/api/app/android/download/a.apk"));
        assertFalse(UpdateFiles.isUpdateUrl(SERVER, "https://u@dropit.lthero.com/api/app/android/download/a.apk"));
        assertFalse(UpdateFiles.isUpdateUrl(SERVER, "https://dropit.lthero.com/api/app/android/download/../x.apk"));
        assertFalse(UpdateFiles.isUpdateUrl(SERVER, "https://dropit.lthero.com/api/app/android/download/a.apk?x=1"));
        assertFalse(UpdateFiles.isUpdateUrl(SERVER, "https://dropit.lthero.com/api/items/a.apk"));
        assertFalse(UpdateFiles.isUpdateUrl(null, "https://dropit.lthero.com/api/app/android/download/a.apk"));
    }

    @Test
    public void sha256Hex() throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest("abc".getBytes(StandardCharsets.UTF_8));
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", UpdateFiles.hex(digest));
        assertTrue(UpdateFiles.isSha256(UpdateFiles.hex(digest)));
        assertFalse(UpdateFiles.isSha256("BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD"));
        assertFalse(UpdateFiles.isSha256("abc"));
    }
}
