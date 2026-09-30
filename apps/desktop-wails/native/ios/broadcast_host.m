#import <UIKit/UIKit.h>
#import <ReplayKit/ReplayKit.h>
#import "webview_window_ios.h"
#import "application_ios_delegate.h"
#include <stdlib.h>

// The sheet on screen and the share it belongs to. Main queue only.
static UIViewController *broadcastPicker;
static NSString *broadcastPickerSession;
// Shares whose sheet may still be shown. A delayed retry for a share that has
// since ended finds itself missing here and gives up. Main queue only.
static NSMutableSet<NSString *> *broadcastPickerPending;
extern void bc_broadcast_picker_cancel(const char *session);

@interface BCBroadcastPickerController : UIViewController <UIAdaptivePresentationControllerDelegate>
@property(nonatomic, copy) NSString *session;
@end
@implementation BCBroadcastPickerController
- (void)presentationControllerDidDismiss:(UIPresentationController *)presentationController {
    if (broadcastPicker == self) { broadcastPicker = nil; broadcastPickerSession = nil; }
    bc_broadcast_picker_cancel(self.session.UTF8String);
}
@end

// Derived from this app's own bundle ID, so a developer who re-signs under
// another App ID gets a matching extension and App Group. Keep in sync with
// package-desktop-wails-ios.sh, sign-desktop-wails-ios.sh and SampleHandler.m.
static NSString *BCBroadcastExtensionID(void) {
    return [NSBundle.mainBundle.bundleIdentifier stringByAppendingString:@".broadcast"];
}

char *bc_broadcast_group_path(void) {
    NSString *group=[@"group." stringByAppendingString:BCBroadcastExtensionID()];
    NSURL *url=[NSFileManager.defaultManager containerURLForSecurityApplicationGroupIdentifier:group];
    return url ? strdup(url.path.fileSystemRepresentation) : NULL;
}

static BOOL BCPresentationSettling(UIViewController *host) {
    for (UIViewController *c=host; c; c=c.presentedViewController)
        if (c.isBeingPresented || c.isBeingDismissed) return YES;
    return NO;
}

static void BCShowPicker(NSString *identifier, int attempt) {
    if (![broadcastPickerPending containsObject:identifier]) return;
    UIViewController *host=appDelegate.window.rootViewController;
    // A previous share's sheet may still be animating away after a quick
    // cancel and restart. UIKit refuses to present during a transition, so
    // wait for it (up to about three seconds) rather than fail.
    if (broadcastPicker || BCPresentationSettling(host)) {
        if (attempt < 20) {
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 150 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
                BCShowPicker(identifier, attempt + 1);
            });
        } else {
            bc_broadcast_picker_cancel(identifier.UTF8String);
        }
        return;
    }
    // Every other way out without a sheet cancels at once: otherwise the
    // page's start waits two minutes on a picker nobody can see.
    if (![host isKindOfClass:WailsViewController.class]) { bc_broadcast_picker_cancel(identifier.UTF8String); return; }
    NSURL *url=((WailsViewController *)host).webView.URL;
    if (![url.scheme isEqualToString:@"wails"] || ![url.host isEqualToString:@"localhost"]) {
        bc_broadcast_picker_cancel(identifier.UTF8String);
        return;
    }
    // A controller that is already presenting cannot present the sheet.
    UIViewController *presenter=host;
    while (presenter.presentedViewController) presenter=presenter.presentedViewController;
    BCBroadcastPickerController *view=[BCBroadcastPickerController new];
    view.session=identifier;
    view.modalPresentationStyle=UIModalPresentationPageSheet;
    view.view.backgroundColor=UIColor.systemBackgroundColor;
    UILabel *label=[UILabel new];
    label.text=@"Share your iPhone screen\n\nTap the broadcast button, then Start Broadcast. Everything on your screen will be visible to people in this call. Use the iOS broadcast indicator to stop sharing.";
    label.numberOfLines=0; label.textAlignment=NSTextAlignmentCenter;
    label.translatesAutoresizingMaskIntoConstraints=NO;
    RPSystemBroadcastPickerView *picker=[[RPSystemBroadcastPickerView alloc] initWithFrame:CGRectMake(0,0,64,64)];
    picker.preferredExtension=BCBroadcastExtensionID();
    picker.showsMicrophoneButton=NO;
    picker.translatesAutoresizingMaskIntoConstraints=NO;
    [view.view addSubview:label]; [view.view addSubview:picker];
    UIButton *cancel=[UIButton buttonWithType:UIButtonTypeSystem];
    [cancel setTitle:@"Cancel" forState:UIControlStateNormal];
    [cancel addAction:[UIAction actionWithHandler:^(__unused UIAction *action) {
        bc_broadcast_picker_cancel(identifier.UTF8String);
    }] forControlEvents:UIControlEventTouchUpInside];
    cancel.translatesAutoresizingMaskIntoConstraints=NO;
    [view.view addSubview:cancel];
    [NSLayoutConstraint activateConstraints:@[
        [label.leadingAnchor constraintEqualToAnchor:view.view.safeAreaLayoutGuide.leadingAnchor constant:28],
        [label.trailingAnchor constraintEqualToAnchor:view.view.safeAreaLayoutGuide.trailingAnchor constant:-28],
        [label.centerYAnchor constraintEqualToAnchor:view.view.centerYAnchor constant:-60],
        [picker.topAnchor constraintEqualToAnchor:label.bottomAnchor constant:24],
        [picker.centerXAnchor constraintEqualToAnchor:view.view.centerXAnchor],
        [picker.widthAnchor constraintEqualToConstant:64], [picker.heightAnchor constraintEqualToConstant:64],
        [cancel.topAnchor constraintEqualToAnchor:picker.bottomAnchor constant:24],
        [cancel.centerXAnchor constraintEqualToAnchor:view.view.centerXAnchor],
        [cancel.heightAnchor constraintGreaterThanOrEqualToConstant:44]]];
    broadcastPicker=view;
    broadcastPickerSession=identifier;
    [presenter presentViewController:view animated:YES completion:nil];
    view.presentationController.delegate=view;
}

void bc_broadcast_picker_show(const char *session) {
    NSString *identifier=[NSString stringWithUTF8String:session];
    dispatch_async(dispatch_get_main_queue(), ^{
        if (!broadcastPickerPending) broadcastPickerPending=[NSMutableSet set];
        [broadcastPickerPending addObject:identifier];
        BCShowPicker(identifier, 0);
    });
}

// Dismisses only the given share's sheet, so a late hide from one share can
// never take down the picker of the share that replaced it.
void bc_broadcast_picker_hide(const char *session) {
    NSString *identifier=[NSString stringWithUTF8String:session];
    dispatch_async(dispatch_get_main_queue(), ^{
        // Every start ends with exactly one hide, so the set stays bounded.
        [broadcastPickerPending removeObject:identifier];
        if (!broadcastPicker || ![broadcastPickerSession isEqualToString:identifier]) return;
        UIViewController *sheet=broadcastPicker;
        broadcastPicker=nil; broadcastPickerSession=nil;
        if (sheet.presentingViewController) [sheet dismissViewControllerAnimated:YES completion:nil];
    });
}
void bc_broadcast_host_ended(const char *session) {
    NSString *identifier=[NSString stringWithUTF8String:session];
    dispatch_async(dispatch_get_main_queue(), ^{
        UIViewController *host=appDelegate.window.rootViewController;
        if (![host isKindOfClass:WailsViewController.class]) return;
        WailsViewController *page=(WailsViewController *)host;
        if (![page.webView.URL.scheme isEqualToString:@"wails"] || ![page.webView.URL.host isEqualToString:@"localhost"]) return;
        NSData *data=[NSJSONSerialization dataWithJSONObject:@{@"sessionId":identifier,@"reason":@"Screen broadcast ended."} options:0 error:nil];
        NSString *json=[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
        [page.webView evaluateJavaScript:[NSString stringWithFormat:@"window.dispatchEvent(new CustomEvent('bc-ios-broadcast-ended',{detail:%@}))",json] completionHandler:nil];
    });
}
