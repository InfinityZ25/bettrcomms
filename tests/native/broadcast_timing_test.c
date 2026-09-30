#include <assert.h>
#include <stdio.h>
#include "broadcast_timing.h"
int main(void) {
    BCBroadcastTiming timing={0}; int accepted=0;
    // 60 FPS capture delivered instantly as a burst still produces 30 FPS.
    for (int i=0;i<600;i++) if (BCBroadcastAcceptFrame(&timing,100+i/60.0)) accepted++;
    assert(accepted==300);
    assert(!BCBroadcastAcceptFrame(&timing,timing.last));
    assert(!BCBroadcastAcceptFrame(&timing,NAN));
    assert(!BCBroadcastAcceptFrame(&timing,1));
    timing=(BCBroadcastTiming){0}; accepted=0;
    // Alternating callback/capture jitter must not halve an existing 30 FPS feed.
    for (int i=0;i<300;i++) if (BCBroadcastAcceptFrame(&timing,100+i/30.0+(i%2?0.002:-0.002))) accepted++;
    assert(accepted==300);
    assert(BCBroadcastAcceptFrame(&timing,150)); // Resume after a real pause.
    puts("ReplayKit capture-timestamp frame pacing passed.");
}
