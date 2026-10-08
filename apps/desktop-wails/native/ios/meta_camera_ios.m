//go:build ios

#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <AVFoundation/AVFoundation.h>
#import <MWDATCore/MWDATCore-Swift.h>
#import <MWDATCamera/MWDATCamera-Swift.h>
#import <os/log.h>
#import "meta_camera_retry.h"
#import "meta_camera_watchdog.h"
#import "meta_video_encoder.h"
extern void bc_meta_sender_ended(void);
extern int bc_meta_encoder_control(int *force_keyframe);
#import "BetterCommsMeta-Swift.h"
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
@property (nonatomic, strong) ObjC_AnyListenerToken *sessionListener;
@property (nonatomic, strong) MWDATDeviceSession *retiringSession;
@property (nonatomic, strong) MWDATCamera *retiringCamera;
@property (nonatomic, strong) MWDATStream *retiringStream;
@property (nonatomic, strong) MWDATAutoDeviceSelector *deviceSelector;
@property (nonatomic, strong) ObjC_AnyListenerToken *deviceListener;
@property (nonatomic, strong) MWDATCamera *camera;
@property (nonatomic, strong) MWDATStream *stream;
@property (atomic, strong) BCMetaVideoEncoder *videoEncoder;
@property (atomic, assign) BOOL publishing;
@property (atomic, assign) BOOL foreground;
@property (atomic, assign) double lastInputFrameTime;
@property (atomic, assign) BOOL receivedInputFrame;
@property (nonatomic, assign) BOOL configured;
@property (nonatomic, assign) BOOL registrationInFlight;
@property (nonatomic, assign) BOOL unregistrationInFlight;
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
@property (nonatomic, assign) UIBackgroundTaskIdentifier cleanupTask;
+ (instancetype)shared;
- (BOOL)prepare;
- (void)connect;
- (void)reconnect;
- (void)continueStart;
- (void)beginSessionWhenActive;
- (void)waitUntilSessionReady:(MWDATDeviceSession *)session;
- (void)session:(MWDATDeviceSession *)session finishedStartingWithError:(NSError *)error;
- (void)requestCameraPermissionForSession:(MWDATDeviceSession *)session;
- (void)beginCameraWhenActive:(MWDATDeviceSession *)session;
- (void)addCameraToSession:(MWDATDeviceSession *)session;
- (void)watchFramesForStream:(MWDATStream *)stream started:(double)started;
- (void)waitForDevice;
- (void)start;
- (void)stop;
- (void)handleURL:(NSURL *)url;
@end

@implementation BCMetaCamera
+ (void)load {
    // Restore DAT registration/device discovery at launch, before a preview
    // request can mistake SDK initialization for an unregistered account.
    [[NSNotificationCenter defaultCenter] addObserverForName:UIApplicationDidFinishLaunchingNotification
        object:nil queue:[NSOperationQueue mainQueue] usingBlock:^(__unused NSNotification *note) {
            [[BCMetaCamera shared] prepare];
        }];
}
+ (instancetype)shared {
    static BCMetaCamera *instance;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        instance = [BCMetaCamera new];
        instance.cleanupTask = UIBackgroundTaskInvalid;
        instance.foreground = YES;
        [[NSNotificationCenter defaultCenter] addObserver:instance
            selector:@selector(appActivated:)
            name:UIApplicationDidBecomeActiveNotification object:nil];
        [[NSNotificationCenter defaultCenter] addObserver:instance
            selector:@selector(appTerminating:)
            name:UIApplicationWillTerminateNotification object:nil];
        [[NSNotificationCenter defaultCenter] addObserver:instance
            selector:@selector(appBackgrounded:)
            name:UIApplicationDidEnterBackgroundNotification object:nil];
        [[NSNotificationCenter defaultCenter] addObserver:instance
            selector:@selector(audioChanged:)
            name:AVAudioSessionRouteChangeNotification object:nil];
        [[NSNotificationCenter defaultCenter] addObserver:instance
            selector:@selector(audioChanged:)
            name:AVAudioSessionInterruptionNotification object:nil];
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
    [[NSNotificationCenter defaultCenter] addObserver:self
        selector:@selector(registrationStateChanged:)
        name:[NSNotification wearablesRegistrationStateChanged] object:nil];
    return YES;
}

- (void)registrationStateChanged:(NSNotification *)notification {
    dispatch_async(dispatch_get_main_queue(), ^{
        MWDATRegistrationState state = [MWDATWearables sharedInstance].registrationState;
        NSLog(@"BetterComms Meta: registration state changed=%ld", (long)state);
        if (self.unregistrationInFlight) {
            if (state == MWDATRegistrationStateAvailable) {
                self.unregistrationInFlight = NO;
                self.registrationInFlight = NO;
                [self connect];
            }
            return;
        }
        if (state == MWDATRegistrationStateRegistered) {
            self.registrationInFlight = NO;
            BCMetaEmit(@{@"kind": @"registered"});
            if (self.startPending) [self continueStart];
        }
        // Available is also a transient state during a successful Meta callback.
        // Only the registration completion error may mark consent as cancelled.
    });
}

- (void)reconnect {
    if (![self prepare] || self.registrationInFlight) return;
    [self stop];
    MWDATWearables *wearables = [MWDATWearables sharedInstance];
    if (wearables.registrationState != MWDATRegistrationStateRegistered) {
        [self connect];
        return;
    }
    self.registrationInFlight = YES;
    BCMetaEmit(@{@"kind": @"connecting"});
    self.unregistrationInFlight = YES;
    [wearables startUnregistrationWithCompletionHandler:^(NSError *error) {
        dispatch_async(dispatch_get_main_queue(), ^{
            if (error) {
                self.unregistrationInFlight = NO;
                self.registrationInFlight = NO;
                [self reportError:error.localizedDescription];
                return;
            }
            if (self.unregistrationInFlight && wearables.registrationState == MWDATRegistrationStateAvailable) {
                self.unregistrationInFlight = NO;
                self.registrationInFlight = NO;
                [self connect];
            }
        });
    }];
}

- (void)connect {
    if (![self prepare]) return;
    MWDATWearables *wearables = [MWDATWearables sharedInstance];
    if (wearables.registrationState == MWDATRegistrationStateRegistered) {
        BCMetaEmit(@{@"kind": @"registered"});
        if (self.startPending) [self continueStart];
        return;
    }
    if (self.registrationInFlight || wearables.registrationState == MWDATRegistrationStateRegistering) return;
    if (wearables.registrationState == MWDATRegistrationStateUnavailable) {
        // Do not initiate registration while the SDK is restoring its state.
        if (self.startPending) [self waitForDevice];
        return;
    }
    self.registrationInFlight = YES;
    BCMetaEmit(@{@"kind": @"connecting"});
    [wearables startRegistrationWithCompletionHandler:^(NSError *error) {
        dispatch_async(dispatch_get_main_queue(), ^{
            NSLog(@"BetterComms Meta: registration request returned (state=%ld, error=%@/%ld)",
                  (long)wearables.registrationState, error.domain, (long)error.code);
            if (error) {
                self.registrationInFlight = NO;
                [self reportError:error.localizedDescription];
            } else if (wearables.registrationState == MWDATRegistrationStateRegistered) {
                self.registrationInFlight = NO;
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
            else if (handled && !self.unregistrationInFlight && [MWDATWearables sharedInstance].registrationState ==
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
    self.retiringStream = nil;
    self.retiringCamera = nil;
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
    [self.sessionListener cancel];
    __weak BCMetaCamera *weakSelf = self;
    __weak MWDATDeviceSession *expectedSession = session;
    self.sessionListener = [session addStateListener:^(MWDATDeviceSessionState state) {
        dispatch_async(dispatch_get_main_queue(), ^{
            BCMetaCamera *owner = weakSelf;
            if (!expectedSession || owner.session != expectedSession) return;
            BCNativeVideoLog([NSString stringWithFormat:@"session state=%ld", (long)state]);
            if (state == MWDATDeviceSessionStateStopped &&
                expectedSession.state == MWDATDeviceSessionStateStopped && owner.stream) {
                [owner reportError:@"Meta ended the glasses camera session. Call audio can continue; try glasses video again."];
                [owner stop];
            }
        });
    }];
    NSLog(@"BetterComms Meta: device session created (selectedMatches=%d)",
          [session.deviceIdentifier isEqualToString:selectedDevice]);
    // Start directly so synchronous DAT errors retain their original domain
    // instead of the ObjC helper replacing them with a generic stopped error.
    NSError *startError = nil;
    [session start:&startError];
    if (startError) [self session:session finishedStartingWithError:startError];
    else [self waitUntilSessionReady:session];
}

- (void)waitUntilSessionReady:(MWDATDeviceSession *)session {
    if (!self.startPending || self.session != session) return;
    if (session.state == MWDATDeviceSessionStateStarted) {
        [self session:session finishedStartingWithError:nil];
        return;
    }
    if (session.state == MWDATDeviceSessionStateStopped) {
        NSError *error = [NSError errorWithDomain:@"MWDATDeviceSession" code:1
            userInfo:@{NSLocalizedDescriptionKey: @"Device session stopped before becoming ready"}];
        [self session:session finishedStartingWithError:error];
        return;
    }
    if (CFAbsoluteTimeGetCurrent() - self.deviceWaitStarted >= 60) {
        [self reportError:@"The glasses camera connection timed out. Please try again."];
        [self stop];
        return;
    }
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC / 4),
        dispatch_get_main_queue(), ^{ [self waitUntilSessionReady:session]; });
}

- (void)session:(MWDATDeviceSession *)session finishedStartingWithError:(NSError *)startError {
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
        if (retryable && self.sessionCreateRetries >= 2) {
            [self reportError:@"Meta could not reopen the glasses camera after three attempts. If Meta AI still shows an active broadcast, end it there before trying video again."];
            [self stop];
        } else if (retryable) {
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
        initWithVideoCodec:MWDATVideoCodecHvc1
        resolution:MWDATStreamingResolutionHigh frameRate:30];
    NSError *cameraError = nil;
    MWDATCamera *camera = [session addCameraWithConfig:config error:&cameraError];
    if (!camera) {
        [self reportError:cameraError.localizedDescription ?: @"Glasses camera is unavailable."];
        [self stop];
        return;
    }
    self.camera = camera;
    self.stream = camera.stream;
    self.receivedInputFrame = NO;
    self.lastInputFrameTime = 0;
    self.videoEncoder = [BCMetaVideoEncoder new];
    [self.videoEncoder appForegroundChanged:self.foreground];
    __weak BCMetaCamera *weakSelf = self;
    __weak MWDATStream *expectedStream = self.stream;
    BCMetaVideoEncoder *encoder = self.videoEncoder;
    encoder.onError = ^(NSString *message) {
        dispatch_async(dispatch_get_main_queue(), ^{
            if (weakSelf.videoEncoder != encoder) return;
            [weakSelf reportError:message];
            [weakSelf stop];
        });
    };
    self.stream.onVideoFrame = ^(MWDATVideoFrame *frame) {
        BCMetaCamera *owner = weakSelf;
        if (!owner || owner.videoEncoder != encoder) return;
        owner.lastInputFrameTime = NSProcessInfo.processInfo.systemUptime;
        owner.receivedInputFrame = YES;
        // Native encode/send never waits for JavaScript or the preview image.
        BOOL preview = owner.foreground;
        @synchronized(owner) { preview = preview && !owner.framePending && CFAbsoluteTimeGetCurrent() - owner.lastFrame >= 0.1; }
        if (owner.publishing) {
            int forceKeyframe = 0;
            int bitrate = bc_meta_encoder_control(&forceKeyframe);
            [encoder configureBitrate:bitrate forceKeyframe:forceKeyframe != 0];
        }
        UIImage *image = [encoder process:frame.sampleBuffer publish:owner.publishing preview:preview];
        if (image) [owner publishImage:image];
    };
    self.stream.onError = ^(enum MWDATStreamError streamError) {
        dispatch_async(dispatch_get_main_queue(), ^{
            if (!expectedStream || weakSelf.stream != expectedStream) return;
            BCNativeVideoLog([NSString stringWithFormat:@"stream error=%ld foreground=%d",
                (long)streamError, weakSelf.foreground]);
            [weakSelf reportError:[NSString stringWithFormat:
                @"Glasses stream stopped (error %ld).", (long)streamError]];
            [weakSelf stop];
        });
    };
    self.stream.onStateChanged = ^(enum MWDATStreamState state) {
        dispatch_async(dispatch_get_main_queue(), ^{
            BCMetaCamera *owner = weakSelf;
            if (!expectedStream || owner.stream != expectedStream) return;
            BCNativeVideoLog([NSString stringWithFormat:@"stream state=%ld foreground=%d receivedFrame=%d",
                (long)state, owner.foreground, owner.receivedInputFrame]);
            // The initial stopped state can be delivered during start. Only a
            // current terminal state after frames have arrived ends capture.
            if (state == MWDATStreamStateStopped && owner.receivedInputFrame &&
                expectedStream.state == MWDATStreamStateStopped) {
                [owner reportError:@"Meta stopped glasses video. Call audio can continue; try video again."];
                [owner stop];
            }
        });
    };
    [self.stream start];
    [self watchFramesForStream:self.stream started:NSProcessInfo.processInfo.systemUptime];
    BCMetaEmit(@{@"kind": @"streaming"});
}

- (void)watchFramesForStream:(MWDATStream *)stream started:(double)started {
    if (self.stream != stream) return;
    double now = NSProcessInfo.processInfo.systemUptime;
    if (BCMetaCameraFramesExpired(now, started, self.lastInputFrameTime, self.receivedInputFrame)) {
        BCNativeVideoLog([NSString stringWithFormat:@"capture stalled state=%ld foreground=%d receivedFrame=%d",
            (long)stream.state, self.foreground, self.receivedInputFrame]);
        [self reportError:@"The glasses stopped sending video. The camera session has been ended; call audio can continue. Try glasses video again."];
        [self stop];
        return;
    }
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC),
        dispatch_get_main_queue(), ^{ [self watchFramesForStream:stream started:started]; });
}

- (void)audioChanged:(NSNotification *)notification {
    // Numeric event codes and port types only: never device names/identifiers.
    dispatch_async(dispatch_get_main_queue(), ^{
        if (!self.stream) return;
        AVAudioSession *audio = AVAudioSession.sharedInstance;
        BOOL route = [notification.name isEqualToString:AVAudioSessionRouteChangeNotification];
        NSNumber *code = notification.userInfo[route ? AVAudioSessionRouteChangeReasonKey : AVAudioSessionInterruptionTypeKey];
        BCNativeVideoLog([NSString stringWithFormat:@"audio event=%@ code=%ld category=%@ mode=%@ streamState=%ld foreground=%d",
            route ? @"route" : @"interruption", (long)code.integerValue,
            audio.category, audio.mode, (long)self.stream.state, self.foreground]);
    });
}

- (void)publishImage:(UIImage *)image {
    @synchronized (self) {
        CFAbsoluteTime now = CFAbsoluteTimeGetCurrent();
        // DAT controls capture cadence. A second wall-clock rate limiter drops
        // valid frames whenever delivery jitters around the requested interval.
        // Keep one-frame backpressure so a slow webview cannot build a queue.
        if (self.framePending) return;
        self.framePending = YES;
        self.lastFrame = now;
    }
    NSData *jpeg = image ? UIImageJPEGRepresentation(image, 0.85) : nil;
    if (!jpeg) {
        @synchronized (self) { self.framePending = NO; }
        return;
    }
    NSString *base64 = [jpeg base64EncodedStringWithOptions:0];
    NSNumber *width = @(CGImageGetWidth(image.CGImage));
    NSNumber *height = @(CGImageGetHeight(image.CGImage));
    dispatch_async(dispatch_get_main_queue(), ^{
        if (self.stream && self.foreground) {
            // Preview is optional during a native call. A queued foreground
            // frame must not tear down DAT when the page is being suspended.
            if (!BCMetaPage()) { if (!self.publishing) [self stop]; }
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
    BCNativeVideoLog([NSString stringWithFormat:@"capture stop publishing=%d foreground=%d", self.publishing, self.foreground]);
    self.publishing = NO;
    bc_meta_sender_ended();
    BCMetaVideoEncoder *encoder = self.videoEncoder;
    self.videoEncoder = nil;
    encoder.onError = nil;
    [encoder close];
    [self.sessionListener cancel];
    self.sessionListener = nil;
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
    self.stream.onStateChanged = nil;
    // Session.stop cascades to the camera and stream. Do not concurrently
    // detach the child camera while its parent is ending the device session.
    // Retain all three until the terminal stopped state arrives.
    if (self.session) {
        self.retiringSession = self.session;
        self.retiringCamera = self.camera;
        self.retiringStream = self.stream;
    } else if (!self.retiringSession) {
        [self.camera stop];
    }
    [self.retiringSession stop];
    [self releaseRetiredSessionWhenStopped:self.retiringSession];
    if (self.retiringSession) self.nextSessionAttemptAt = CFAbsoluteTimeGetCurrent() + 3.0;
    self.stream = nil;
    self.camera = nil;
    self.session = nil;
    self.framePending = NO;
    BCMetaEmit(@{@"kind": @"stopped"});
}

- (void)releaseRetiredSessionWhenStopped:(MWDATDeviceSession *)session {
    if (!session || self.retiringSession != session) return;
    if (session.state == MWDATDeviceSessionStateStopped) {
        self.retiringStream = nil;
        self.retiringCamera = nil;
        self.retiringSession = nil;
        return;
    }
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC / 10),
                   dispatch_get_main_queue(), ^{ [self releaseRetiredSessionWhenStopped:session]; });
}

- (void)appActivated:(NSNotification *)notification {
    self.foreground = YES;
    [self.videoEncoder appForegroundChanged:YES];
    BCNativeVideoLog([NSString stringWithFormat:@"app foreground publishing=%d stream=%d", self.publishing, self.stream != nil]);
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

- (void)finishBackgroundCleanup {
    if (self.cleanupTask == UIBackgroundTaskInvalid) return;
    UIBackgroundTaskIdentifier task = self.cleanupTask;
    self.cleanupTask = UIBackgroundTaskInvalid;
    [[UIApplication sharedApplication] endBackgroundTask:task];
}

- (void)waitForBackgroundCleanup {
    if (self.cleanupTask == UIBackgroundTaskInvalid) return;
    if (!self.retiringSession || self.retiringSession.state == MWDATDeviceSessionStateStopped) {
        self.retiringStream = nil;
        self.retiringCamera = nil;
        self.retiringSession = nil;
        [self finishBackgroundCleanup];
        return;
    }
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC / 10),
                   dispatch_get_main_queue(), ^{ [self waitForBackgroundCleanup]; });
}

- (void)appTerminating:(NSNotification *)notification {
    [self stop];
}

- (void)appBackgrounded:(NSNotification *)notification {
    self.foreground = NO;
    [self.videoEncoder appForegroundChanged:NO];
    BCNativeVideoLog([NSString stringWithFormat:@"app background publishing=%d stream=%d", self.publishing, self.stream != nil]);
    // Calls transmit entirely natively. Only standalone previews stop here.
    if (self.publishing) return;
    // Permission redirects intentionally retain a session with no stream.
    if (!self.stream) return;
    self.backgroundStopped = YES;
    if (self.cleanupTask == UIBackgroundTaskInvalid) {
        self.cleanupTask = [[UIApplication sharedApplication]
            beginBackgroundTaskWithName:@"End glasses camera session" expirationHandler:^{
                [self finishBackgroundCleanup];
            }];
    }
    [self stop];
    [self waitForBackgroundCleanup];
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
    dispatch_async(dispatch_get_main_queue(), ^{ [[BCMetaCamera shared] reconnect]; });
}
void bc_meta_start(void) {
    dispatch_async(dispatch_get_main_queue(), ^{ [[BCMetaCamera shared] start]; });
}
void bc_meta_stop(void) {
    dispatch_async(dispatch_get_main_queue(), ^{ [[BCMetaCamera shared] stop]; });
}

void bc_meta_set_publishing(int value) {
    dispatch_async(dispatch_get_main_queue(), ^{ [BCMetaCamera shared].publishing = value != 0; });
}

void bc_meta_log(const char *message) {
    NSString *text = [NSString stringWithUTF8String:message];
    if ([text hasPrefix:@"sender frames="]) BCNativeVideoLog(text);
    else os_log(OS_LOG_DEFAULT, "BetterComms Meta native: %{public}s", message);
}
