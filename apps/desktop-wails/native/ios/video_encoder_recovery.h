#ifndef BC_VIDEO_ENCODER_RECOVERY_H
#define BC_VIDEO_ENCODER_RECOVERY_H
#include <VideoToolbox/VideoToolbox.h>
#include <stdbool.h>

typedef struct {
    unsigned failures;
    double retryAt;
    bool resetRequired;
} BCVideoEncoderRecovery;

static inline bool BCVideoEncoderCanRecover(OSStatus status) {
    return status == kVTInvalidSessionErr || status == kVTVideoEncoderNotAvailableNowErr;
}

static inline bool BCVideoDecoderCanRecover(OSStatus status) {
    return status == kVTInvalidSessionErr || status == kVTVideoDecoderNotAvailableNowErr;
}

// Invoked by the native capture queue, never a webview timer. Keep attempts
// bounded while iOS withholds the encoder; a foreground transition can wake it.
static inline double BCVideoEncoderScheduleRetry(BCVideoEncoderRecovery *state, double now) {
    if (state->failures < 5) state->failures++;
    double delay = 0.5 * (1u << (state->failures - 1));
    if (delay > 5) delay = 5;
    state->retryAt = now + delay;
    state->resetRequired = true;
    return delay;
}

static inline void BCVideoEncoderRecovered(BCVideoEncoderRecovery *state) {
    state->failures = 0;
    state->retryAt = 0;
    state->resetRequired = false;
}
#endif
