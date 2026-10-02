//go:build darwin && !ios && cgo

#include "pushtotalk_darwin.h"
#include <CoreGraphics/CoreGraphics.h>
#include <CoreFoundation/CoreFoundation.h>
#include <stdlib.h>

extern void bcInputEvent(uintptr_t handle, int index, int down);
extern int bcInputTick(uintptr_t handle);

struct bc_input_tap {
    uintptr_t handle;
    int keys[3], buttons[3], count;
    CFMachPortRef port;
    CFRunLoopRef loop;
    CFRunLoopSourceRef source;
    CFRunLoopTimerRef timer;
};

int bc_input_permission(void) { return CGPreflightListenEventAccess(); }
int bc_input_request_permission(void) { return CGRequestListenEventAccess(); }
int bc_input_down(int key, int button) {
    return key >= 0 ? CGEventSourceKeyState(kCGEventSourceStateCombinedSessionState, key)
        : CGEventSourceButtonState(kCGEventSourceStateCombinedSessionState, button);
}

static CGEventRef callback(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void *context) {
    bc_input_tap *tap = context;
    if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
        // Fail closed. Rejoining after fixing consent creates a fresh observer.
        CFRunLoopStop(tap->loop);
        return event;
    }
    int key = -1, button = -1, down = 0;
    if (type == kCGEventKeyDown || type == kCGEventKeyUp || type == kCGEventFlagsChanged) {
        if (CGEventGetIntegerValueField(event, kCGKeyboardEventAutorepeat)) return event;
        key = (int)CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode);
        down = type == kCGEventFlagsChanged ? bc_input_down(key, -1) : type == kCGEventKeyDown;
    } else {
        button = (int)CGEventGetIntegerValueField(event, kCGMouseEventButtonNumber);
        down = type == kCGEventLeftMouseDown || type == kCGEventRightMouseDown || type == kCGEventOtherMouseDown;
    }
    for (int i = 0; i < tap->count; i++) {
        if ((key >= 0 && tap->keys[i] == key) || (button >= 0 && tap->keys[i] < 0 && tap->buttons[i] == button))
            bcInputEvent(tap->handle, i, down);
    }
    return event; // listen-only: never suppresses or modifies another app's input.
}

static void tick(CFRunLoopTimerRef timer, void *context) {
    bc_input_tap *tap = context;
    if (!bcInputTick(tap->handle)) CFRunLoopStop(tap->loop);
}

bc_input_tap *bc_input_create(uintptr_t handle, const int *keys, const int *buttons, int count) {
    if (count < 1 || count > 3 || !bc_input_permission()) return NULL;
    bc_input_tap *tap = calloc(1, sizeof(*tap));
    if (!tap) return NULL;
    tap->handle = handle; tap->count = count;
    CGEventMask mask = 0;
    for (int i = 0; i < count; i++) {
        tap->keys[i] = keys[i]; tap->buttons[i] = buttons[i];
        if (keys[i] >= 0) mask |= CGEventMaskBit(kCGEventKeyDown) | CGEventMaskBit(kCGEventKeyUp) | CGEventMaskBit(kCGEventFlagsChanged);
        else mask |= CGEventMaskBit(kCGEventLeftMouseDown) | CGEventMaskBit(kCGEventLeftMouseUp)
            | CGEventMaskBit(kCGEventRightMouseDown) | CGEventMaskBit(kCGEventRightMouseUp)
            | CGEventMaskBit(kCGEventOtherMouseDown) | CGEventMaskBit(kCGEventOtherMouseUp);
    }
    tap->loop = CFRunLoopGetCurrent(); CFRetain(tap->loop);
    tap->port = CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap, kCGEventTapOptionListenOnly, mask, callback, tap);
    if (!tap->port) { bc_input_destroy(tap); return NULL; }
    tap->source = CFMachPortCreateRunLoopSource(NULL, tap->port, 0);
    CFRunLoopTimerContext timerContext = {0, tap, NULL, NULL, NULL};
    tap->timer = CFRunLoopTimerCreate(NULL, CFAbsoluteTimeGetCurrent() + .25, .25, 0, 0, tick, &timerContext);
    if (!tap->source || !tap->timer) { bc_input_destroy(tap); return NULL; }
    CFRunLoopAddSource(tap->loop, tap->source, kCFRunLoopCommonModes);
    CFRunLoopAddTimer(tap->loop, tap->timer, kCFRunLoopCommonModes);
    CGEventTapEnable(tap->port, true);
    return tap;
}
void bc_input_run(bc_input_tap *tap) { CFRunLoopRun(); }
void bc_input_stop(bc_input_tap *tap) { CFRunLoopStop(tap->loop); CFRunLoopWakeUp(tap->loop); }
void bc_input_destroy(bc_input_tap *tap) {
    if (!tap) return;
    if (tap->timer) { CFRunLoopTimerInvalidate(tap->timer); CFRelease(tap->timer); }
    if (tap->source) { CFRunLoopSourceInvalidate(tap->source); CFRelease(tap->source); }
    if (tap->port) { CGEventTapEnable(tap->port, false); CFMachPortInvalidate(tap->port); CFRelease(tap->port); }
    if (tap->loop) CFRelease(tap->loop);
    free(tap);
}
