package com.wails.app;

// No @JavascriptInterface: only the authenticated Go bindings can command
// this controller. Encoded access units go straight to Go's WebRTC sender.
public final class BetterCommsNative {
    static { System.loadLibrary("wails"); }
    public static native void attach(BetterCommsAndroidHost host, String privateDirectory);
    public static native void encoded(int source, String sessionId, byte[] annexB, long capturedMicros);
    public static native void screenStopped(String sessionId);
    public static native long encoderControl(int source);
    public static native void stopped(int source);
    public static native void detach();
}
