//go:build ios

#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <MWDATCore/MWDATCore-Swift.h>
#import <MWDATCamera/MWDATCamera-Swift.h>
#import <os/log.h>
#import "meta_camera_retry.h"
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
@property (nonatomic, strong) MWDATDeviceSession *retiringSession;
@property (nonatomic, strong) MWDATAutoDeviceSelector *deviceSelector;
@property (nonatomic, strong) ObjC_AnyListenerToken *deviceListener;
@property (nonatomic, strong) MWDATCamera *camera;
@property (nonatomic, strong) MWDATStream *stream;
@property (nonatomic, assign) BOOL configured;
@property (nonatomic, assign) BOOL registrationInFlight;
@property (nonatomic, assign) BOOL startPending;
@property (nonatomic, assign) BOOL startingSession;
@property (nonatomic, assign) BOOL permissionGrantedPending;
@property (nonatomic, assign) BOOL backgroundStopped;
@property (nonatomic, assign) BOOL deviceRetryScheduled;
@property (nonatomic, assign) CFAbsoluteTime deviceWaitStarted;
@property (nonatomic, assign) CFAbsoluteTime activationWaitUntil;
@property (nonatomic, assign) CFAbsoluteTime cameraWaitStarted;
@property (nonatomic, assign) CFAbsoluteTime nextSessionAttemptAt;
@property (nonatomic, assign) NSUInteger deviceWaitGeneration;
@property (nonatomic, assign) NSUInteger sessionCreateRetries;
@property (nonatomic, assign) BOOL framePending;
@property (nonatomic, assign) CFAbsoluteTime lastFrame;
+ (instancetype)shared;
- (void)connect;
- (void)continueStart;
- (void)beginSessionWhenActive;
- (void)requestCameraPermissionForSession:(MWDATDeviceSession *)session;
- (void)beginCameraWhenActive:(MWDATDeviceSession *)session;
- (void)addCameraToSession:(MWDATDeviceSession *)session;
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
            selector:@selector(appActivated:)
            name:UIApplicationDidBecomeActiveNotification object:nil];
        [[NSNotificationCenter defaultCenter] addObserver:instance
            selector:@selector(appBackgrounded:)
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
        [self reportError:@"Meta AI authorized BetterComms, but its glasses camera link did not become available. Headset audio can still work. Check the glasses connection and developer component in Meta AI."];
        [self stop];
        return;
    }
    if (self.deviceRetryScheduled) return;
    self.deviceRetryScheduled = YES;
    NSUInteger generation = self.deviceWaitGeneration;
    // A connected Bluetooth device can still be waiting for Meta's DAT data
    // channel. Give that channel time to settle instead of rapidly cycling
    // sessions and abandoning the request after only five attempts.
    NSTimeInterval retryDelay = self.sessionCreateRetries ? 3.0 : 1.0;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(retryDelay * NSEC_PER_SEC)),
                   dispatch_get_main_queue(), ^{
        if (generation != self.deviceWaitGeneration) return;
        self.deviceRetryScheduled = NO;
        [self continueStart];
    });
}

- (void)continueStart {
    if (!self.startPending || self.startingSession || self.session) return;
    if (self.stream) return;
    // Selector notifications must respect the retry delay and SDK teardown.
    if (CFAbsoluteTimeGetCurrent() < self.nextSessionAttemptAt ||
        (self.retiringSession && self.retiringSession.state != MWDATDeviceSessionStateStopped)) {
        [self waitForDevice];
        return;
    }
    self.retiringSession = nil;
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
    if (self.deviceWaitStarted == 0) self.deviceWaitStarted = CFAbsoluteTimeGetCurrent();
    BCMetaEmit(@{@"kind": @"starting"});
    // Meta's CameraAccess sample opens the device session before checking or
    // requesting camera consent. Keep the ready session across the Meta AI
    // permission redirect; only add the camera capability after consent.
    [self beginSessionWhenActive];
}

- (void)beginSessionWhenActive {
    if (!self.startPending) return;
    if ([UIApplication sharedApplication].applicationState != UIApplicationStateActive) {
        self.startingSession = NO;
        self.deviceWaitStarted = 0;
        NSLog(@"BetterComms Meta: waiting for app activation before session start");
        return;
    }
    if (CFAbsoluteTimeGetCurrent() < self.activationWaitUntil ||
        !self.deviceSelector.activeDevice.length) {
        self.startingSession = NO;
        [self waitForDevice];
        return;
    }
    [self beginSession];
}

- (void)beginSession {
    if (!self.startPending || self.session) return;
    MWDATWearables *wearables = [MWDATWearables sharedInstance];
    NSError *error = nil;
    NSString *selectedDevice = self.deviceSelector.activeDevice;
    MWDATDeviceSession *session = [wearables createSessionForDeviceIdentifier:selectedDevice error:&error];
    if (!session) {
        NSLog(@"BetterComms Meta: session creation failed (%@, %ld, selected=%d)",
              error.domain, (long)error.code, selectedDevice.length > 0);
        if (!self.deviceSelector.activeDevice.length ||
            BCMetaSessionErrorCanRetry(error, [NSBundle bundleForClass:[MWDATWearables class]])) {
            self.sessionCreateRetries++;
            self.nextSessionAttemptAt = CFAbsoluteTimeGetCurrent() + 3.0;
            self.startingSession = NO;
            [self waitForDevice];
            return;
        }
        [self reportError:@"Meta could not start a glasses session. Open Meta AI until the glasses show connected, then return and try again."];
        [self stop];
        return;
    }
    self.session = session;
    NSLog(@"BetterComms Meta: device session created (selectedMatches=%d)",
          [session.deviceIdentifier isEqualToString:selectedDevice]);
    [session startAndWaitUntilReadyWithCompletionHandler:^(NSError *startError) {
        dispatch_async(dispatch_get_main_queue(), ^{
            if (self.session != session) return;
            if (startError) {
                BOOL retryable = BCMetaSessionErrorCanRetry(startError,
                    [NSBundle bundleForClass:[MWDATWearables class]]);
                os_log_error(OS_LOG_DEFAULT,
                    "BetterComms Meta: session startup failed domain=%{public}@ code=%ld retryable=%d attempt=%lu",
                    startError.domain, (long)startError.code, retryable,
                    (unsigned long)self.sessionCreateRetries + 1);
                [session stop];
                self.retiringSession = session;
                self.session = nil;
                if (retryable) {
                    self.sessionCreateRetries++;
                    self.nextSessionAttemptAt = CFAbsoluteTimeGetCurrent() + 3.0;
                    self.startingSession = NO;
                    [self waitForDevice];
                } else {
                    [self reportError:startError.localizedDescription ?: @"Meta could not open the glasses camera link."];
                    [self stop];
                }
                return;
            }
            NSLog(@"BetterComms Meta: device session ready; checking camera permission");
            self.deviceWaitStarted = 0;
            [self requestCameraPermissionForSession:session];
        });
    }];
}

- (void)requestCameraPermissionForSession:(MWDATDeviceSession *)session {
    MWDATWearables *wearables = [MWDATWearables sharedInstance];
    [wearables checkPermissionStatus:MWDATPermissionCamera
        completionHandler:^(enum MWDATPermissionStatus status, NSError *error) {
            dispatch_async(dispatch_get_main_queue(), ^{
                if (!self.startPending || self.session != session) return;
                if (error) {
                    NSLog(@"BetterComms Meta: camera permission check failed (%@, %ld)",
                          error.domain, (long)error.code);
                    [self reportError:error.localizedDescription];
                    [self stop];
                } else if (status == MWDATPermissionStatusGranted) {
                    [self beginCameraWhenActive:session];
                } else {
                    // Meta AI owns consent and may switch apps. Keep this
                    // session; the sample only ends sessions on background
                    // when they already have an active camera stream.
                    [wearables requestPermission:MWDATPermissionCamera
                        completionHandler:^(enum MWDATPermissionStatus granted, NSError *permissionError) {
                            dispatch_async(dispatch_get_main_queue(), ^{
                                if (!self.startPending || self.session != session) return;
                                if (permissionError) {
                                    NSLog(@"BetterComms Meta: camera permission request failed (%@, %ld)",
                                          permissionError.domain, (long)permissionError.code);
                                    [self reportError:permissionError.localizedDescription];
                                    [self stop];
                                } else if (granted == MWDATPermissionStatusGranted) {
                                    [self beginCameraWhenActive:session];
                                } else {
                                    [self reportError:@"Allow glasses camera access in Meta AI, then try again."];
                                    [self stop];
                                }
                            });
                        }];
                }
            });
        }];
}

- (void)beginCameraWhenActive:(MWDATDeviceSession *)session {
    if (!self.startPending || self.session != session || self.stream) return;
    if ([UIApplication sharedApplication].applicationState != UIApplicationStateActive) {
        self.permissionGrantedPending = YES;
        NSLog(@"BetterComms Meta: camera permission granted; waiting for app activation");
        return;
    }
    CFAbsoluteTime now = CFAbsoluteTimeGetCurrent();
    if (now < self.activationWaitUntil || session.state != MWDATDeviceSessionStateStarted) {
        if (session.state == MWDATDeviceSessionStateStopped) {
            [self reportError:@"The glasses ended their camera session while Meta AI was open. Please try again."];
            [self stop];
            return;
        }
        if (self.cameraWaitStarted == 0) self.cameraWaitStarted = now;
        if (now - self.cameraWaitStarted >= 30) {
            [self reportError:@"The Meta glasses camera session did not resume after permission. Please try again."];
            [self stop];
            return;
        }
        self.permissionGrantedPending = YES;
        NSUInteger generation = self.deviceWaitGeneration;
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC),
                       dispatch_get_main_queue(), ^{
            if (generation == self.deviceWaitGeneration) [self beginCameraWhenActive:session];
        });
        return;
    }
    self.permissionGrantedPending = NO;
    self.cameraWaitStarted = 0;
    [self addCameraToSession:session];
}

- (void)addCameraToSession:(MWDATDeviceSession *)session {
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
    __weak MWDATStream *expectedStream = self.stream;
    self.stream.onVideoFrame = ^(MWDATVideoFrame *frame) {
        [weakSelf publishFrame:frame];
    };
    self.stream.onError = ^(enum MWDATStreamError streamError) {
        dispatch_async(dispatch_get_main_queue(), ^{
            if (!expectedStream || weakSelf.stream != expectedStream) return;
            [weakSelf reportError:[NSString stringWithFormat:
                @"Glasses stream stopped (error %ld).", (long)streamError]];
            [weakSelf stop];
        });
    };
    [self.stream start];
    BCMetaEmit(@{@"kind": @"streaming"});
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
    self.permissionGrantedPending = NO;
    self.deviceRetryScheduled = NO;
    self.deviceWaitStarted = 0;
    self.activationWaitUntil = 0;
    self.cameraWaitStarted = 0;
    self.nextSessionAttemptAt = 0;
    self.deviceWaitGeneration++;
    self.sessionCreateRetries = 0;
    [self.deviceListener cancel];
    self.deviceListener = nil;
    self.deviceSelector = nil;
    self.stream.onVideoFrame = nil;
    self.stream.onError = nil;
    [self.camera stop];
    [self.session stop];
    [self.retiringSession stop];
    self.retiringSession = nil;
    self.stream = nil;
    self.camera = nil;
    self.session = nil;
    self.framePending = NO;
    BCMetaEmit(@{@"kind": @"stopped"});
}

- (void)appActivated:(NSNotification *)notification {
    // The SDK can keep its external-accessory session across an app switch.
    // WebKit may defer a frame's JavaScript completion while in the background;
    // allow a fresh frame immediately when the call becomes visible again.
    @synchronized (self) {
        self.framePending = NO;
        self.lastFrame = 0;
    }
    if (self.backgroundStopped) {
        self.backgroundStopped = NO;
        // A WKWebView event queued during suspension may never reach the page.
        // Notify the resumed UI that the previously published track ended.
        BCMetaEmit(@{@"kind": @"stopped"});
    }
    if (self.startPending) {
        self.activationWaitUntil = CFAbsoluteTimeGetCurrent() + 2.0;
        if (self.session && self.permissionGrantedPending)
            [self beginCameraWhenActive:self.session];
        else if (!self.session)
            [self continueStart];
    }
}

- (void)appBackgrounded:(NSNotification *)notification {
    // DAT can retain a glasses broadcast when iOS suspends the app mid-stream.
    // This bridge publishes frames through WKWebView, which cannot keep sending
    // them in the background. End an active native session deliberately until
    // the call media sender itself runs outside the webview.
    if (!self.stream) return;
    self.backgroundStopped = YES;
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
