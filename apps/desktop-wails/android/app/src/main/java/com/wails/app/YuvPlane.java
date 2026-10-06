package com.wails.app;

import java.nio.ByteBuffer;

/** Copy visible YUV samples without padding or changing either buffer's cursor. */
final class YuvPlane {
    static void copy(ByteBuffer source, int sourceRowStride, int sourcePixelStride,
                     int left, int top, ByteBuffer target, int targetRowStride,
                     int targetPixelStride, int width, int height) {
        ByteBuffer src = source.duplicate(), dst = target.duplicate();
        int sourceBase = src.position() + top * sourceRowStride + left * sourcePixelStride;
        int targetBase = dst.position();
        for (int row = 0; row < height; row++) {
            int from = sourceBase + row * sourceRowStride, to = targetBase + row * targetRowStride;
            if (sourcePixelStride == 1 && targetPixelStride == 1) {
                src.limit(source.limit()); src.position(from); src.limit(from + width);
                dst.position(to); dst.put(src);
            } else {
                for (int col = 0; col < width; col++)
                    dst.put(to + col * targetPixelStride, src.get(from + col * sourcePixelStride));
            }
        }
    }
}
