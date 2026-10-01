#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>
#import <strings.h>

// Wails v3.0.0-beta.18 owns this class and already installs it as WKUIDelegate.
// A category adds only the media callback, leaving its navigation and file
// picker callbacks intact. Keep this paired with the pinned Wails version.
@interface WebviewWindowDelegate : NSObject <WKUIDelegate>
@end

bool bettercommsTrustedMediaOrigin(const char *originScheme, const char *originHost,
    long originPort, bool mainFrame, const char *pageScheme, const char *pageHost,
    bool pageHasPort, long mediaType) {
    if (!mainFrame || pageHasPort || originPort != 0 ||
        !originScheme || !originHost || !pageScheme || !pageHost) {
        return false;
    }
    if (mediaType != WKMediaCaptureTypeCamera &&
        mediaType != WKMediaCaptureTypeMicrophone &&
        mediaType != WKMediaCaptureTypeCameraAndMicrophone) {
        return false;
    }
    return strcasecmp(originScheme, "wails") == 0 &&
        strcasecmp(originHost, "wails") == 0 &&
        strcasecmp(pageScheme, "wails") == 0 &&
        strcasecmp(pageHost, "wails") == 0;
}

// Calling this from Go forces the linker to include this translation unit and
// therefore register the category method on Wails' delegate class.
void bettercommsInstallMediaPermissionDelegate(void) {
    (void)[WebviewWindowDelegate class];
}

bool bettercommsMediaPermissionDelegateIsInstalled(void) {
    Class delegate = objc_getClass("WebviewWindowDelegate");
    SEL mediaCallback = @selector(webView:requestMediaCapturePermissionForOrigin:
        initiatedByFrame:type:decisionHandler:);
    return delegate != Nil && class_getInstanceMethod(delegate, mediaCallback) != NULL;
}

@implementation WebviewWindowDelegate (BetterCommsMediaPermission)

- (void)webView:(WKWebView *)webView
    requestMediaCapturePermissionForOrigin:(WKSecurityOrigin *)origin
    initiatedByFrame:(WKFrameInfo *)frame
    type:(WKMediaCaptureType)type
    decisionHandler:(void (^)(WKPermissionDecision))decisionHandler {
    NSURL *page = webView.URL;
    bool trusted = bettercommsTrustedMediaOrigin(origin.protocol.UTF8String,
        origin.host.UTF8String, origin.port, frame.isMainFrame,
        page.scheme.UTF8String, page.host.UTF8String, page.port != nil, type);
    // This removes only WebKit's second prompt for our embedded app document.
    // macOS still enforces its own per-app camera/microphone permission. Other
    // pages retain WebKit's normal prompt rather than receiving a blanket grant.
    decisionHandler(trusted ? WKPermissionDecisionGrant : WKPermissionDecisionPrompt);
}

@end
