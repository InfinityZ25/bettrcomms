package com.wails.app;

import java.io.ByteArrayOutputStream;

/** MediaCodec usually emits start codes; also accept four-byte AVCC lengths. */
final class AnnexB {
    static byte[] normalize(byte[] data) {
        if (data.length >= 4 && data[0] == 0 && data[1] == 0
                && (data[2] == 1 || (data[2] == 0 && data[3] == 1))) return data;
        ByteArrayOutputStream result = new ByteArrayOutputStream(data.length + 16);
        for (int i = 0; i < data.length;) {
            if (data.length - i < 4) throw new IllegalArgumentException("Truncated AVC length");
            long size = ((long)(data[i] & 255) << 24) | ((long)(data[i+1] & 255) << 16)
                    | ((long)(data[i+2] & 255) << 8) | (data[i+3] & 255);
            i += 4;
            if (size <= 0 || size > data.length - i) throw new IllegalArgumentException("Invalid AVC length");
            result.write(0); result.write(0); result.write(0); result.write(1);
            result.write(data, i, (int)size);
            i += (int)size;
        }
        return result.toByteArray();
    }
    /** Retain the newest SPS/PPS even when a codec emits them separately. */
    static byte[] parameterSets(byte[] previous, byte[] update) {
        byte[][] sets = new byte[2][];
        for (byte[] bytes : new byte[][]{previous, update}) {
            for (int i = 0; i < bytes.length;) {
                int prefix = startCode(bytes, i);
                if (prefix == 0) { i++; continue; }
                int nal = i + prefix, end = nal;
                while (end < bytes.length && startCode(bytes, end) == 0) end++;
                if (nal < end) {
                    int type = bytes[nal] & 31;
                    if (type == 7 || type == 8)
                        sets[type - 7] = java.util.Arrays.copyOfRange(bytes, i, end);
                }
                i = end;
            }
        }
        ByteArrayOutputStream result = new ByteArrayOutputStream();
        for (byte[] set : sets) if (set != null) result.write(set, 0, set.length);
        return result.toByteArray();
    }
    private static int startCode(byte[] bytes, int offset) {
        if (offset + 2 >= bytes.length || bytes[offset] != 0 || bytes[offset + 1] != 0) return 0;
        if (bytes[offset + 2] == 1) return 3;
        return offset + 3 < bytes.length && bytes[offset + 2] == 0 && bytes[offset + 3] == 1 ? 4 : 0;
    }
}
