#!/usr/bin/env python3
"""Apply the iOS-only WKWebView media decision missing in Wails beta.18.

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
    "    self.webView.navigationDelegate = self;\n    self.webView.UIDelegate = self;\n",
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
