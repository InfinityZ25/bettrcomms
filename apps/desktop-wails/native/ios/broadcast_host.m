#import <UIKit/UIKit.h>
#import <ReplayKit/ReplayKit.h>
#import "webview_window_ios.h"
#import "application_ios_delegate.h"
#include <stdlib.h>

static UIViewController *broadcastPicker;
extern void bc_broadcast_picker_cancel(const char *session);

@interface BCBroadcastPickerController : UIViewController <UIAdaptivePresentationControllerDelegate>
@property(nonatomic, copy) NSString *session;
@end
@implementation BCBroadcastPickerController
- (void)presentationControllerDidDismiss:(UIPresentationController *)presentationController {
    bc_broadcast_picker_cancel(self.session.UTF8String);
}
@end

char *bc_broadcast_group_path(void) {
    NSURL *url=[NSFileManager.defaultManager containerURLForSecurityApplicationGroupIdentifier:@"group.com.bettrcomms.ios.broadcast"];
    return url ? strdup(url.path.fileSystemRepresentation) : NULL;
}

void bc_broadcast_picker_show(const char *session) {
    NSString *identifier=[NSString stringWithUTF8String:session];
    dispatch_async(dispatch_get_main_queue(), ^{
        // Every way out without a sheet cancels at once: otherwise the page's
        // start waits two minutes on a picker nobody can see.
        if (broadcastPicker) { bc_broadcast_picker_cancel(identifier.UTF8String); return; }
        UIViewController *host=appDelegate.window.rootViewController;
        if (![host isKindOfClass:WailsViewController.class]) { bc_broadcast_picker_cancel(identifier.UTF8String); return; }
        NSURL *url=((WailsViewController *)host).webView.URL;
        if (![url.scheme isEqualToString:@"wails"] || ![url.host isEqualToString:@"localhost"]) {
            bc_broadcast_picker_cancel(identifier.UTF8String);
            return;
        }
        // A controller that is already presenting cannot present the sheet.
        UIViewController *presenter=host;
        while (presenter.presentedViewController && !presenter.presentedViewController.isBeingDismissed)
            presenter=presenter.presentedViewController;
        BCBroadcastPickerController *view=[BCBroadcastPickerController new];
        view.session=identifier;
        view.modalPresentationStyle=UIModalPresentationPageSheet;
        view.view.backgroundColor=UIColor.systemBackgroundColor;
        UILabel *label=[UILabel new];
        label.text=@"Share your iPhone screen\n\nTap the broadcast button, then Start Broadcast. Everything on your screen will be visible to people in this call. Use the iOS broadcast indicator to stop sharing.";
        label.numberOfLines=0; label.textAlignment=NSTextAlignmentCenter;
        label.translatesAutoresizingMaskIntoConstraints=NO;
        RPSystemBroadcastPickerView *picker=[[RPSystemBroadcastPickerView alloc] initWithFrame:CGRectMake(0,0,64,64)];
        picker.preferredExtension=@"com.bettrcomms.ios.broadcast";
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
        [presenter presentViewController:view animated:YES completion:nil];
        view.presentationController.delegate=view;
    });
}
void bc_broadcast_picker_hide(void) {
    dispatch_async(dispatch_get_main_queue(), ^{
        [broadcastPicker dismissViewControllerAnimated:YES completion:nil]; broadcastPicker=nil;
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
