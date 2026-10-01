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
}
