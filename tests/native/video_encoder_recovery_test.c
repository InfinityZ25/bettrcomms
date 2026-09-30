#include "video_encoder_recovery.h"
#include <assert.h>
#include <stdio.h>

int main(void) {
    assert(BCVideoEncoderCanRecover(kVTInvalidSessionErr));
    assert(BCVideoEncoderCanRecover(kVTVideoEncoderNotAvailableNowErr));
    assert(!BCVideoEncoderCanRecover(kVTParameterErr));
    assert(!BCVideoEncoderCanRecover(kVTVideoDecoderBadDataErr));
    assert(!BCVideoEncoderCanRecover(noErr));
    assert(BCVideoDecoderCanRecover(kVTInvalidSessionErr));
    assert(BCVideoDecoderCanRecover(kVTVideoDecoderNotAvailableNowErr));
    assert(!BCVideoDecoderCanRecover(kVTVideoEncoderNotAvailableNowErr));
    assert(!BCVideoDecoderCanRecover(kVTVideoDecoderBadDataErr));

    // Simulate a minute with the encoder unavailable: retries must remain
    // delayed and bounded, rather than recreating a session on every frame.
    BCVideoEncoderRecovery recovery = {0};
    double now = 100, lastDelay = 0;
    unsigned attempts = 0;
    while (now < 160) {
        double delay = BCVideoEncoderScheduleRetry(&recovery, now);
        assert(delay >= 0.5 && delay <= 5 && delay >= lastDelay);
        assert(recovery.resetRequired && recovery.retryAt > now);
        now = recovery.retryAt;
        lastDelay = delay;
        attempts++;
    }
    assert(attempts < 20);

    // Real output clears the old failure history. A later interruption starts
    // with a short delay instead of inheriting the previous prolonged outage.
    BCVideoEncoderRecovered(&recovery);
    assert(!recovery.resetRequired && recovery.retryAt == 0);
    assert(BCVideoEncoderScheduleRetry(&recovery, now) == 0.5);
    puts("Video encoder recovery policy passed.");
}
