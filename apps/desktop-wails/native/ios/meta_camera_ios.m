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

static void BCMetaEmitWithCompletion(NSDictionary *detail, void (^completion)(void)) {
    WailsViewController *page = BCMetaPage();
    if (!page) { if (completion) completion(); return; }
    NSData *data = [NSJSONSerialization dataWithJSONObject:detail options:0 error:nil];
    if (!data) { if (completion) completion(); return; }
    NSString *json = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    NSString *script = [NSString stringWithFormat:
        @"window.dispatchEvent(new CustomEvent('bc-meta-camera',{detail:%@}));", json];
    [page.webView evaluateJavaScript:script completionHandler:^(__unused id result, __unused NSError *error) {
        if (completion) completion();
    }];
}

static void BCMetaEmit(NSDictionary *detail) {
    BCMetaEmitWithCompletion(detail, nil);
}

@interface BCMetaCamera : NSObject
@property (nonatomic, strong) MWDATDeviceSession *session;
@property (nonatomic, strong) MWDATAutoDeviceSelector *deviceSelector;
@property (nonatomic, strong) ObjC_AnyListenerToken *deviceListener;
@property (nonatomic, strong) MWDATCamera *camera;
@property (nonatomic, strong) MWDATStream *stream;
@property (nonatomic, assign) BOOL configured;
@property (nonatomic, assign) BOOL registrationInFlight;
@property (nonatomic, assign) BOOL startPending;
@property (nonatomic, assign) BOOL startingSession;
@property (nonatomic, assign) BOOL deviceRetryScheduled;
@property (nonatomic, assign) CFAbsoluteTime deviceWaitStarted;
@property (nonatomic, assign) NSUInteger deviceWaitGeneration;
@property (nonatomic, assign) NSUInteger sessionCreateRetries;
@property (nonatomic, assign) BOOL framePending;
@property (nonatomic, assign) CFAbsoluteTime lastFrame;
+ (instancetype)shared;
- (void)connect;
- (void)continueStart;
- (void)waitForDevice;
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
        if (self.startPending) [self continueStart];
        return;
    }
    if (self.registrationInFlight) return;
    self.registrationInFlight = YES;
    BCMetaEmit(@{@"kind": @"connecting"});
    [wearables startRegistrationWithCompletionHandler:^(NSError *error) {
        dispatch_async(dispatch_get_main_queue(), ^{
            self.registrationInFlight = NO;
            NSLog(@"BetterComms Meta: registration completed (state=%ld, error=%@/%ld)",
                  (long)wearables.registrationState, error.domain, (long)error.code);
            if (error) [self reportError:error.localizedDescription];
            else {
                BCMetaEmit(@{@"kind": @"registered"});
                if (self.startPending) [self continueStart];
            }
        });
    }];
}

- (void)handleURL:(NSURL *)url {
    if (![self prepare]) return;
    [[MWDATWearables sharedInstance] handleUrl:url completionHandler:^(BOOL handled, NSError *error) {
        dispatch_async(dispatch_get_main_queue(), ^{
            NSLog(@"BetterComms Meta: callback handled=%d (state=%ld, error=%@/%ld)",
                  handled, (long)[MWDATWearables sharedInstance].registrationState,
                  error.domain, (long)error.code);
            if (error) [self reportError:error.localizedDescription];
            else if (handled && [MWDATWearables sharedInstance].registrationState ==
                                  MWDATRegistrationStateRegistered) {
                BCMetaEmit(@{@"kind": @"registered"});
                if (self.startPending) [self continueStart];
            }
        });
    }];
}

- (void)start {
    if (![self prepare]) return;
    self.startPending = YES;
    [self continueStart];
}

- (void)waitForDevice {
    if (!self.startPending) return;
    CFAbsoluteTime now = CFAbsoluteTimeGetCurrent();
    if (self.deviceWaitStarted == 0) {
        self.deviceWaitStarted = now;
        MWDATWearables *wearables = [MWDATWearables sharedInstance];
        NSUInteger connected = 0, compatible = 0;
        for (NSString *identifier in wearables.devices) {
            MWDATDevice *device = [wearables deviceForIdentifier:identifier];
            if (device.linkState == MWDATLinkStateConnected) connected++;
            if (device.compatibility == MWDATCompatibilityCompatible) compatible++;
        }
        NSLog(@"BetterComms Meta: waiting for eligible device (registered=%d, known=%lu, connected=%lu, compatible=%lu)",
              wearables.registrationState == MWDATRegistrationStateRegistered,
              (unsigned long)wearables.devices.count, (unsigned long)connected,
              (unsigned long)compatible);
        BCMetaEmit(@{@"kind": @"waitingForDevice"});
    }
    if (now - self.deviceWaitStarted >= 60) {
        [self reportError:@"Meta AI authorized BetterComms, but the glasses did not reconnect. Open the arms and check their connection in Meta AI."];
        return;
    }
    if (self.deviceRetryScheduled) return;
    self.deviceRetryScheduled = YES;
    NSUInteger generation = self.deviceWaitGeneration;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(NSEC_PER_SEC)),
                   dispatch_get_main_queue(), ^{
        if (generation != self.deviceWaitGeneration) return;
        self.deviceRetryScheduled = NO;
        [self continueStart];
    });
}

- (void)continueStart {
    if (!self.startPending || self.startingSession || self.session) return;
    if (self.stream) return;
    MWDATWearables *wearables = [MWDATWearables sharedInstance];
    if (wearables.registrationState != MWDATRegistrationStateRegistered) {
        [self connect];
        return;
    }
    if (!self.deviceSelector) {
        self.deviceSelector = [MWDATAutoDeviceSelector new];
        __weak BCMetaCamera *weakSelf = self;
        self.deviceListener = [self.deviceSelector addActiveDeviceListener:^(NSString *identifier) {
            if (!identifier.length) return;
            dispatch_async(dispatch_get_main_queue(), ^{
                BCMetaCamera *camera = weakSelf;
                if (camera.startPending) [camera continueStart];
            });
        }];
    }
    if (!self.deviceSelector.activeDevice.length) {
        [self waitForDevice];
        return;
    }
    self.startingSession = YES;
    BCMetaEmit(@{@"kind": @"starting"});
    [wearables checkPermissionStatus:MWDATPermissionCamera
        completionHandler:^(enum MWDATPermissionStatus status, NSError *error) {
            dispatch_async(dispatch_get_main_queue(), ^{
                if (!self.startPending) return;
                if (error) {
                    NSLog(@"BetterComms Meta: camera permission check failed (%@, %ld)",
                          error.domain, (long)error.code);
                    if ([error.domain isEqualToString:MWDATPermissionErrorDomain] &&
                        (error.code == MWDATPermissionErrorNoDevice ||
                         error.code == MWDATPermissionErrorNoDeviceWithConnection)) {
                        self.startingSession = NO;
                        [self waitForDevice];
                    } else [self reportError:error.localizedDescription];
                } else if (status == MWDATPermissionStatusGranted) {
                    [self beginSession];
                } else {
                    // Meta AI owns glasses-camera consent and may switch apps.
                    [wearables requestPermission:MWDATPermissionCamera
                        completionHandler:^(enum MWDATPermissionStatus granted, NSError *permissionError) {
                            dispatch_async(dispatch_get_main_queue(), ^{
                                if (!self.startPending) return;
                                if (permissionError) {
                                    NSLog(@"BetterComms Meta: camera permission request failed (%@, %ld)",
                                          permissionError.domain, (long)permissionError.code);
                                    if ([permissionError.domain isEqualToString:MWDATPermissionErrorDomain] &&
                                        (permissionError.code == MWDATPermissionErrorNoDevice ||
                                         permissionError.code == MWDATPermissionErrorNoDeviceWithConnection)) {
                                        self.startingSession = NO;
                                        [self waitForDevice];
                                    } else [self reportError:permissionError.localizedDescription];
                                }
                                else if (granted == MWDATPermissionStatusGranted) [self beginSession];
                                else [self reportError:@"Allow glasses camera access in Meta AI, then try again."];
                            });
                        }];
                }
            });
        }];
}

- (void)beginSession {
    if (!self.startPending || self.session) return;
    MWDATWearables *wearables = [MWDATWearables sharedInstance];
    NSError *error = nil;
    MWDATDeviceSession *session = [wearables createSessionWithDeviceSelector:self.deviceSelector error:&error];
    if (!session) {
        NSLog(@"BetterComms Meta: session creation failed (%@, %ld, selected=%d)",
              error.domain, (long)error.code, self.deviceSelector.activeDevice.length > 0);
        if ((!self.deviceSelector.activeDevice.length ||
             [error.localizedDescription localizedCaseInsensitiveContainsString:@"eligible device"]) &&
            self.sessionCreateRetries < 4) {
            self.sessionCreateRetries++;
            self.startingSession = NO;
            [self waitForDevice];
            return;
        }
        [self reportError:@"Meta could not start a glasses session. Open Meta AI until the glasses show connected, then return and try again."];
        return;
    }
    self.session = session;
    [session startAndWaitUntilReadyWithCompletionHandler:^(NSError *startError) {
        dispatch_async(dispatch_get_main_queue(), ^{
            if (self.session != session) return;
            if (startError) {
                NSLog(@"BetterComms Meta: session startup failed (%@, %ld, attempt=%lu)",
                      startError.domain, (long)startError.code,
                      (unsigned long)self.sessionCreateRetries + 1);
                [session stop];
                self.session = nil;
                if (self.sessionCreateRetries < 4) {
                    self.sessionCreateRetries++;
                    self.startingSession = NO;
                    [self waitForDevice];
                } else {
                    [self reportError:@"Meta could not connect to the glasses camera. Check that the glasses show connected in Meta AI, then try again."];
                    [self stop];
                }
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
            else {
                BCMetaEmitWithCompletion(@{@"kind": @"frame", @"jpeg": base64,
                                           @"width": width, @"height": height}, ^{
                    @synchronized (self) { self.framePending = NO; }
                });
                return;
            }
        }
        @synchronized (self) { self.framePending = NO; }
    });
}

- (void)stop {
    self.startPending = NO;
    self.startingSession = NO;
    self.deviceRetryScheduled = NO;
    self.deviceWaitStarted = 0;
    self.deviceWaitGeneration++;
    self.sessionCreateRetries = 0;
    [self.deviceListener cancel];
    self.deviceListener = nil;
    self.deviceSelector = nil;
    self.stream.onVideoFrame = nil;
    self.stream.onError = nil;
    [self.camera stop];
    [self.session stop];
    self.stream = nil;
    self.camera = nil;
    self.session = nil;
    self.framePending = NO;
    BCMetaEmit(@{@"kind": @"stopped"});
}

- (void)backgrounded:(NSNotification *)notification {
    // Meta AI briefly backgrounds us during registration and camera consent.
    // Only a running capture needs to stop when WKWebView is suspended.
    if (self.session || self.stream) [self stop];
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
