//go:build ios

#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <MWDATCore/MWDATCore-Swift.h>
#import <MWDATCamera/MWDATCamera-Swift.h>
#import "webview_window_ios.h"
#import "application_ios_delegate.h"

static WailsViewController *BCMetaPage(void) {
    UIViewController *controller = appDelegate.window.rootViewController;
    if (![controller isKindOfClass:[WailsViewController class]]) return nil;
    WailsViewController *page = (WailsViewController *)controller;
    NSURL *url = page.webView.URL;
    if (![url.scheme isEqualToString:@"wails"] ||
        ![url.host isEqualToString:@"localhost"]) return nil;
    return page;
}

static void BCMetaEmit(NSDictionary *detail) {
    WailsViewController *page = BCMetaPage();
    if (!page) return;
    NSData *data = [NSJSONSerialization dataWithJSONObject:detail options:0 error:nil];
    if (!data) return;
    NSString *json = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    NSString *script = [NSString stringWithFormat:
        @"window.dispatchEvent(new CustomEvent('bc-meta-camera',{detail:%@}));", json];
    [page.webView evaluateJavaScript:script completionHandler:nil];
}

@interface BCMetaCamera : NSObject
@property (nonatomic, strong) MWDATDeviceSession *session;
@property (nonatomic, strong) MWDATCamera *camera;
@property (nonatomic, strong) MWDATStream *stream;
@property (nonatomic, assign) BOOL configured;
@property (nonatomic, assign) BOOL framePending;
@property (nonatomic, assign) CFAbsoluteTime lastFrame;
+ (instancetype)shared;
- (void)connect;
- (void)start;
- (void)stop;
- (void)handleURL:(NSURL *)url;
@end

@implementation BCMetaCamera
+ (instancetype)shared {
    static BCMetaCamera *instance;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        instance = [BCMetaCamera new];
        [[NSNotificationCenter defaultCenter] addObserver:instance
            selector:@selector(backgrounded:)
            name:UIApplicationDidEnterBackgroundNotification object:nil];
    });
    return instance;
}

- (void)reportError:(NSString *)message {
    BCMetaEmit(@{@"kind": @"error", @"message": message ?: @"Glasses camera failed."});
}

- (BOOL)prepare {
    if (self.configured) return YES;
    NSError *error = nil;
    [MWDATWearables configure:&error];
    if (error) {
        [self reportError:error.localizedDescription];
        return NO;
    }
    self.configured = YES;
    return YES;
}

- (void)connect {
    if (![self prepare]) return;
    MWDATWearables *wearables = [MWDATWearables sharedInstance];
    if (wearables.registrationState == MWDATRegistrationStateRegistered) {
        BCMetaEmit(@{@"kind": @"registered"});
        return;
    }
    BCMetaEmit(@{@"kind": @"connecting"});
    [wearables startRegistrationWithCompletionHandler:^(NSError *error) {
        dispatch_async(dispatch_get_main_queue(), ^{
            if (error) [self reportError:error.localizedDescription];
            else BCMetaEmit(@{@"kind": @"registered"});
        });
    }];
}

- (void)handleURL:(NSURL *)url {
    if (![self prepare]) return;
    [[MWDATWearables sharedInstance] handleUrl:url completionHandler:^(BOOL handled, NSError *error) {
        dispatch_async(dispatch_get_main_queue(), ^{
            if (error) [self reportError:error.localizedDescription];
            else if (handled) BCMetaEmit(@{@"kind": @"registered"});
        });
    }];
}

- (void)start {
    if (![self prepare]) return;
    if (self.stream) return;
    MWDATWearables *wearables = [MWDATWearables sharedInstance];
    if (wearables.registrationState != MWDATRegistrationStateRegistered) {
        [self connect];
        [self reportError:@"Connect your Ray-Ban Meta glasses in the Meta AI app, then choose them again."];
        return;
    }
    if (wearables.devices.count == 0) {
        [self reportError:@"No Meta glasses are available. Put them on and connect them in Meta AI."];
        return;
    }
    BCMetaEmit(@{@"kind": @"starting"});
    [wearables checkPermissionStatus:MWDATPermissionCamera
        completionHandler:^(enum MWDATPermissionStatus status, NSError *error) {
            dispatch_async(dispatch_get_main_queue(), ^{
                if (error) {
                    [self reportError:error.localizedDescription];
                } else if (status == MWDATPermissionStatusGranted) {
                    [self beginSession];
                } else {
                    // Meta AI owns glasses-camera consent and may switch apps.
                    [wearables requestPermission:MWDATPermissionCamera
                        completionHandler:^(enum MWDATPermissionStatus granted, NSError *permissionError) {
                            dispatch_async(dispatch_get_main_queue(), ^{
                                if (permissionError) [self reportError:permissionError.localizedDescription];
                                else if (granted == MWDATPermissionStatusGranted) [self beginSession];
                                else [self reportError:@"Allow glasses camera access in Meta AI, then try again."];
                            });
                        }];
                }
            });
        }];
}

- (void)beginSession {
    if (self.session) return;
    MWDATWearables *wearables = [MWDATWearables sharedInstance];
    MWDATAutoDeviceSelector *selector = [MWDATAutoDeviceSelector new];
    NSError *error = nil;
    MWDATDeviceSession *session = [wearables createSessionWithDeviceSelector:selector error:&error];
    if (!session) {
        [self reportError:error.localizedDescription ?: @"Could not connect to your glasses."];
        return;
    }
    self.session = session;
    [session startAndWaitUntilReadyWithCompletionHandler:^(NSError *startError) {
        dispatch_async(dispatch_get_main_queue(), ^{
            if (self.session != session) return;
            if (startError) {
                [self reportError:startError.localizedDescription];
                [self stop];
                return;
            }
            MWDATStreamConfiguration *config = [[MWDATStreamConfiguration alloc]
                initWithVideoCodec:MWDATVideoCodecRaw
                resolution:MWDATStreamingResolutionLow frameRate:15];
            NSError *cameraError = nil;
            MWDATCamera *camera = [session addCameraWithConfig:config error:&cameraError];
            if (!camera) {
                [self reportError:cameraError.localizedDescription ?: @"Glasses camera is unavailable."];
                [self stop];
                return;
            }
            self.camera = camera;
            self.stream = camera.stream;
            __weak BCMetaCamera *weakSelf = self;
            self.stream.onVideoFrame = ^(MWDATVideoFrame *frame) {
                [weakSelf publishFrame:frame];
            };
            self.stream.onError = ^(enum MWDATStreamError streamError) {
                dispatch_async(dispatch_get_main_queue(), ^{
                    [weakSelf reportError:[NSString stringWithFormat:
                        @"Glasses stream stopped (error %ld).", (long)streamError]];
                    [weakSelf stop];
                });
            };
            [self.stream start];
            BCMetaEmit(@{@"kind": @"streaming"});
        });
    }];
}

- (void)publishFrame:(MWDATVideoFrame *)frame {
    @synchronized (self) {
        CFAbsoluteTime now = CFAbsoluteTimeGetCurrent();
        if (self.framePending || now - self.lastFrame < 1.0 / 15.0) return;
        self.framePending = YES;
        self.lastFrame = now;
    }
    UIImage *image = frame.image;
    NSData *jpeg = image ? UIImageJPEGRepresentation(image, 0.66) : nil;
    if (!jpeg) {
        @synchronized (self) { self.framePending = NO; }
        return;
    }
    NSString *base64 = [jpeg base64EncodedStringWithOptions:0];
    NSNumber *width = @(CGImageGetWidth(image.CGImage));
    NSNumber *height = @(CGImageGetHeight(image.CGImage));
    dispatch_async(dispatch_get_main_queue(), ^{
        if (self.stream) {
            if (!BCMetaPage()) [self stop];
            else BCMetaEmit(@{@"kind": @"frame", @"jpeg": base64,
                              @"width": width, @"height": height});
        }
        @synchronized (self) { self.framePending = NO; }
    });
}

- (void)stop {
    self.stream.onVideoFrame = nil;
    self.stream.onError = nil;
    [self.camera stop];
    [self.session stop];
    self.stream = nil;
    self.camera = nil;
    self.session = nil;
    BCMetaEmit(@{@"kind": @"stopped"});
}

- (void)backgrounded:(NSNotification *)notification {
    // Raw frames and WKWebView publishing cannot continue in the background.
    [self stop];
}
@end

@implementation WailsAppDelegate (BetterCommsMeta)
- (BOOL)application:(UIApplication *)application openURL:(NSURL *)url
            options:(NSDictionary<UIApplicationOpenURLOptionsKey, id> *)options {
    if (![url.scheme isEqualToString:@"bettrcomms-meta"]) return NO;
    [[BCMetaCamera shared] handleURL:url];
    return YES;
}
@end

void bc_meta_connect(void) {
    dispatch_async(dispatch_get_main_queue(), ^{ [[BCMetaCamera shared] connect]; });
}
void bc_meta_start(void) {
    dispatch_async(dispatch_get_main_queue(), ^{ [[BCMetaCamera shared] start]; });
}
void bc_meta_stop(void) {
    dispatch_async(dispatch_get_main_queue(), ^{ [[BCMetaCamera shared] stop]; });
}
