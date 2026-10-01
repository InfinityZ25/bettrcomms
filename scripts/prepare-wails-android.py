#!/usr/bin/env python3
"""Stage the pinned Wails JNI host, with small reviewed BetterComms hooks.

Keep upstream sources out of the working tree and fail if their patch anchors
change. Wails' Java package must remain com.wails.app for its JNI exports.
"""
import pathlib
import shutil
import sys

module, destination = map(pathlib.Path, sys.argv[1:])
source = module / 'internal/commands/build_assets/android/app/src/main'
if destination.exists():
    destination.chmod(0o755)
    for file in destination.rglob('*'):
        file.chmod(0o755 if file.is_dir() else 0o644)
    shutil.rmtree(destination)
shutil.copytree(source / 'java', destination / 'java')
shutil.copytree(source / 'res', destination / 'res')
for file in destination.rglob('*'):
    file.chmod(0o755 if file.is_dir() else 0o644)
activity = destination / 'java/com/wails/app/MainActivity.java'
text = activity.read_text()

def replace(old, new):
    global text
    if text.count(old) != 1:
        raise SystemExit('Wails Android template changed: ' + old[:80])
    text = text.replace(old, new)

replace('private WebView webView;', 'private WebView webView;\n    private BetterCommsAndroidHost betterComms;')
replace('setContentView(R.layout.activity_main);', 'setContentView(R.layout.activity_main);\n        betterComms = new BetterCommsAndroidHost(this);')
replace('// Add JavaScript interface for Go communication', 'betterComms.configure(webView, bridge);\n\n        // Add JavaScript interface for Go communication')
replace('public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {',
        'public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {\n'
        '                if (!betterComms.allowResource(request.getUrl())) return betterComms.blockedResponse();')
replace('public void onPageFinished(WebView view, String url) {',
        'public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {\n'
        '                return betterComms.navigate(request.getUrl(), request.isForMainFrame());\n'
        '            }\n\n            @Override\n            public void onPageFinished(WebView view, String url) {')
replace('bridge.onPageFinished(url);', 'bridge.onPageFinished(url);\n                betterComms.onPageFinished();')
replace('settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);',
        '// Requests are independently restricted to the packaged origin, HTTPS assets,\n'
        '        // and the token-gated loopback proxy by shouldInterceptRequest.\n'
        '        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);')
replace('super.onDestroy();', 'if (betterComms != null) betterComms.destroy();\n        super.onDestroy();')
replace('''    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }''', '')
# Request paths can contain pairing or native-token query parameters.
for line in ['if (DEBUG) Log.d(TAG, "Wails API call: " + fullPath);',
             'if (DEBUG) Log.d(TAG, "Page loaded: " + url);',
             'if (DEBUG) Log.d(TAG, "Loading URL: " + url);']:
    replace(line, '// Request URLs are deliberately not logged.')
activity.write_text(text)

# JNI invoke logs must never include host tokens, authentication, or signaling.
bridge = destination / 'java/com/wails/app/WailsJSBridge.java'
text = bridge.read_text()
for line in ['if (DEBUG) Log.d(TAG, "Invoke called: " + message);',
             'if (DEBUG) Log.d(TAG, "InvokeAsync called: " + payload);']:
    if text.count(line) != 1:
        raise SystemExit('Wails bridge logging anchor changed')
    text = text.replace(line, '// Sensitive binding arguments are deliberately not logged.')
bridge.write_text(text)

# WailsBridge also has argument traces; omit them in both development/release.
bridge = destination / 'java/com/wails/app/WailsBridge.java'
text = bridge.read_text()
for line in ['if (DEBUG) Log.d(TAG, "Message from JS: " + message);',
             'if (DEBUG) Log.d(TAG, "Runtime call: " + payload);']:
    if text.count(line) != 1:
        raise SystemExit('Wails native logging anchor changed')
    text = text.replace(line, '// Do not log private binding arguments.')
for old, new in [
    ('if (DEBUG) Log.d(TAG, "Serving asset: " + path);', '// Request paths are not logged.'),
    ('Log.w(TAG, "Bridge not initialized, cannot serve asset: " + path);', 'Log.w(TAG, "Bridge not initialized, cannot serve asset");'),
    ('Log.e(TAG, "Error serving asset: " + path, e);', 'Log.e(TAG, "Error serving asset", e);'),
]:
    if text.count(old) != 1:
        raise SystemExit('Wails request logging anchor changed')
    text = text.replace(old, new)
anchor = 'private SharedPreferences securePrefs()'
if text.count(anchor) != 1:
    raise SystemExit('Wails secure preferences anchor changed')
text = text.replace(anchor, 'private synchronized SharedPreferences securePrefs()')
# BetterComms does not use location. Disable this generic host method instead
# of asking for unrelated, sensitive location permissions to satisfy lint.
start = text.index('    public void getLocation() {')
end = text.index('    private void emitLocation(Location l)', start)
text = text[:start] + '''    public void getLocation() {
        emitLocationError("Location is not enabled in BetterComms.");
    }

''' + text[end:]
bridge.write_text(text)

# Use the repository mark rather than Wails' sample icon at all densities.
for path in (destination / 'res').glob('mipmap-*/*.png'):
    shutil.copyfile(destination.parent.parent / 'build/appicon.png', path)
strings = destination / 'res/values/strings.xml'
strings.write_text('<resources><string name="app_name">BetterComms</string></resources>\n')
