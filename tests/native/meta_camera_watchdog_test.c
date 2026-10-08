#include <assert.h>
#include <stdio.h>
#include "meta_camera_watchdog.h"

int main(void) {
    assert(!BCMetaCameraFramesExpired(159.9, 100, 0, 0));
    assert(BCMetaCameraFramesExpired(160, 100, 0, 0));
    // Frames keep a long-running session healthy, even without a viewer or
    // preview and across app switches. Short audio interruptions get grace.
    assert(!BCMetaCameraFramesExpired(10000, 100, 9999, 1));
    assert(!BCMetaCameraFramesExpired(129.9, 0, 100, 1));
    assert(BCMetaCameraFramesExpired(130, 0, 100, 1));
    assert(!BCMetaCameraFramesExpired(130, 0, 129, 1));
    assert(!BCMetaCameraFramesExpired(99, 0, 100, 1));
    puts("Meta camera frame deadlines passed.");
}
