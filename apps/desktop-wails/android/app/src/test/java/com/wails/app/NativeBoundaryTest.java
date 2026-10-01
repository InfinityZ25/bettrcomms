package com.wails.app;

import org.junit.Test;
import static org.junit.Assert.*;

public class NativeBoundaryTest {
    @Test public void onlyPackagedHttpsOriginCanUseMediaPermissions() {
        assertTrue(TrustedPage.packaged("https://wails.localhost/"));
        assertTrue(TrustedPage.packaged("https://wails.localhost/settings/audio"));
        for (String address : new String[]{"https://wails.localhost.evil/", "http://wails.localhost/", "https://wails.localhost:443/", "https://user@wails.localhost/", "file:///tmp/app.html", "https://app.bettrcomms.com/", "not an address"})
            assertFalse(address, TrustedPage.packaged(address));
    }
    @Test public void cleartextIsLimitedToLoopbackApi() {
        assertTrue(TrustedPage.resource("http://127.0.0.1:18081/api/session"));
        assertTrue(TrustedPage.resource("https://example.com/avatar.png"));
        for (String address : new String[]{"http://example.com/api/session", "http://127.0.0.1:18081/", "http://localhost:18081/api/session", "http://user@127.0.0.1:18081/api/session", "file:///data/session", "content://provider/session"})
            assertFalse(address, TrustedPage.resource(address));
    }
    @Test public void normalizesNalLengthsAndKeepsStartCodes() {
        byte[] start = {0, 0, 0, 1, 101, 12};
        assertArrayEquals(start, AnnexB.normalize(start));
        assertArrayEquals(new byte[]{0,0,0,1,101,12,0,0,0,1,65}, AnnexB.normalize(new byte[]{0,0,0,2,101,12,0,0,0,1,65}));
    }
    @Test public void rejectsTruncatedOrOversizedNalLengths() {
        for (byte[] bytes : new byte[][]{{0,0,2}, {0,0,0,4,101}, {-1,-1,-1,-1,101}, {0,0,0,0}}) {
            assertThrows(IllegalArgumentException.class, () -> AnnexB.normalize(bytes));
        }
    }
}
