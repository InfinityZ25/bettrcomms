#!/usr/bin/env python3
"""Patch Wails beta.18's iOS media decision and edge-to-edge webview layout.

The patch is made in a temporary copy of the pinned module during packaging.
Exact anchors intentionally fail the build if Wails changes its implementation.
"""

from pathlib import Path
import sys


def replace_once(path: Path, old: str, new: str) -> None:
    source = path.read_text()
    if source.count(old) != 1:
        raise SystemExit(f"Unexpected Wails iOS source at {path}: missing/duplicate anchor")
    path.chmod(path.stat().st_mode | 0o200)
    path.write_text(source.replace(old, new, 1))


application = Path(sys.argv[1]) / "pkg" / "application"
header = application / "webview_window_ios.h"
implementation = application / "webview_window_ios.m"

replace_once(
    header,
    "@interface WailsViewController : UIViewController <WKNavigationDelegate, UITabBarDelegate>",
    "@interface WailsViewController : UIViewController <WKNavigationDelegate, WKUIDelegate, UITabBarDelegate>",
)
replace_once(
    implementation,
    "    self.webView.navigationDelegate = self;\n",
    """    self.webView.navigationDelegate = self;
    self.webView.UIDelegate = self;
    // The app has its own zoom controls for shared content. Pinch-zooming the
    // entire WKWebView shrinks the navigation and leaves unusable blank space.
    self.webView.scrollView.pinchGestureRecognizer.enabled = NO;
    WKUserScript *viewportScript = [[WKUserScript alloc]
        initWithSource:@"var viewport = document.querySelector('meta[name=viewport]'); if (viewport) viewport.content = 'width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover';"
        injectionTime:WKUserScriptInjectionTimeAtDocumentEnd
        forMainFrameOnly:YES];
    [self.webView.configuration.userContentController addUserScript:viewportScript];
""",
)
replace_once(
    implementation,
    """    CGFloat webTop = safe.top;
    CGFloat webBottom = safe.bottom + tabH;
    self.webView.frame = UIEdgeInsetsInsetRect(self.view.bounds, UIEdgeInsetsMake(webTop, safe.left, webBottom, safe.right));
""",
    """    // The packaged page uses viewport-fit=cover and safe-area CSS for its
    // controls. Insetting WKWebView itself leaves blank bars at the top and
    // bottom, even when the document fills its own viewport.
    CGFloat webBottom = tabH > 0 ? safe.bottom + tabH : 0;
    self.webView.frame = UIEdgeInsetsInsetRect(self.view.bounds, UIEdgeInsetsMake(0, 0, webBottom, 0));
""",
)
replace_once(
    implementation,
    "// GENERATED EVENTS START\n",
    """// iOS already asks the user for app-level microphone/camera permission. Avoid
// WebKit's second website prompt only for our packaged, top-level document.
// Navigation to any other document retains WebKit's ordinary prompt.
- (void)webView:(WKWebView *)webView
    requestMediaCapturePermissionForOrigin:(WKSecurityOrigin *)origin
    initiatedByFrame:(WKFrameInfo *)frame
    type:(WKMediaCaptureType)type
    decisionHandler:(void (^)(WKPermissionDecision))decisionHandler API_AVAILABLE(ios(15.0)) {
    NSURL *page = webView.URL;
    BOOL trusted = frame.isMainFrame &&
        [page.scheme isEqualToString:@"wails"] &&
        [page.host isEqualToString:@"localhost"] &&
        [origin.protocol isEqualToString:@"wails"] &&
        [origin.host isEqualToString:@"localhost"] &&
        origin.port == 0;
    decisionHandler(trusted ? WKPermissionDecisionGrant : WKPermissionDecisionPrompt);
}

// GENERATED EVENTS START
""",
)
