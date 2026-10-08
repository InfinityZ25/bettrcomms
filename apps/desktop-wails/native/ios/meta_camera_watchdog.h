#pragma once

// Monotonic source-frame time, independent of encoder output, peer count,
// JavaScript preview delivery and foreground/background transitions.
static inline int BCMetaCameraFramesExpired(double now, double started,
                                            double lastFrame, int receivedFrame) {
    double reference = receivedFrame ? lastFrame : started;
    double allowance = receivedFrame ? 30.0 : 60.0;
    return now >= reference && now - reference >= allowance;
}
