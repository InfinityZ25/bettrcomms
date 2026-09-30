#ifndef BC_BROADCAST_TIMING_H
#define BC_BROADCAST_TIMING_H
#include <stdbool.h>
#include <math.h>
// ReplayKit may deliver multiple capture samples together. Throttle by capture
// time, never by callback arrival, with tolerance for a jittered 30 FPS source.
typedef struct { double next, last; bool started; } BCBroadcastTiming;
static inline bool BCBroadcastAcceptFrame(BCBroadcastTiming *clock, double pts) {
    if (!isfinite(pts)) return false;
    if (clock->started && pts<=clock->last) return false;
    if (clock->started && pts+0.005<clock->next) return false;
    if (!clock->started || pts-clock->next>0.1) clock->next=pts;
    clock->started=true; clock->last=pts; clock->next+=1.0/30.0;
    if (clock->next<pts) clock->next=pts+1.0/30.0;
    return true;
}
#endif
