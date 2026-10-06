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
    @Test public void replacesSpsWithoutDroppingSeparatePps() {
        byte[] old = {0,0,0,1,103,10,0,0,1,104,20};
        byte[] next = {0,0,0,1,103,30};
        assertArrayEquals(new byte[]{0,0,0,1,103,30,0,0,1,104,20}, AnnexB.parameterSets(old, next));
        assertArrayEquals(old, AnnexB.parameterSets(old, new byte[]{0,0,0,1,101,40}));
    }
    @Test public void copiesVisibleCropFromPaddedRowsWithoutMovingCursors() {
        java.nio.ByteBuffer source = java.nio.ByteBuffer.wrap(new byte[]{99, 0,1,2,3,88,88, 4,5,6,7,88,88, 8,9,10,11,88,88});
        source.position(1);
        java.nio.ByteBuffer target = java.nio.ByteBuffer.allocate(7); target.position(1);
        YuvPlane.copy(source, 6, 1, 1, 1, target, 3, 1, 2, 2);
        assertArrayEquals(new byte[]{0,5,6,0,9,10,0}, target.array());
        assertEquals(1, source.position()); assertEquals(1, target.position());
    }
    @Test public void copiesInterleavedChromaWithoutPaddingSamples() {
        java.nio.ByteBuffer source = java.nio.ByteBuffer.wrap(new byte[]{1,99,2,99,88,88,3,99,4,99,88,88});
        java.nio.ByteBuffer target = java.nio.ByteBuffer.allocate(8); target.position(1);
        YuvPlane.copy(source, 6, 2, 0, 0, target, 4, 2, 2, 2);
        assertArrayEquals(new byte[]{0,1,0,2,0,3,0,4}, target.array());
    }
}
