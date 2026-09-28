#import <UIKit/UIKit.h>
#import <ReplayKit/ReplayKit.h>
#import <CoreImage/CoreImage.h>
#import "webview_window_ios.h"
#import "application_ios_delegate.h"

static WailsViewController *BCScreenPage(void) {
    UIViewController *controller = appDelegate.window.rootViewController;
    if (![controller isKindOfClass:[WailsViewController class]]) return nil;
    WailsViewController *page = (WailsViewController *)controller;
    NSURL *url = page.webView.URL;
    if (![url.scheme isEqualToString:@"wails"] ||
        ![url.host isEqualToString:@"localhost"]) return nil;
    return page;
}

static void BCScreenEmitWithCompletion(NSDictionary *detail, void (^completion)(void)) {
    WailsViewController *page = BCScreenPage();
    if (!page) { if (completion) completion(); return; }
    NSData *data = [NSJSONSerialization dataWithJSONObject:detail options:0 error:nil];
    if (!data) { if (completion) completion(); return; }
    NSString *json = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    NSString *script = [NSString stringWithFormat:
        @"window.dispatchEvent(new CustomEvent('bc-ios-app-screen',{detail:%@}));", json];
    [page.webView evaluateJavaScript:script completionHandler:^(__unused id result, __unused NSError *error) {
        if (completion) completion();
    }];
}

static void BCScreenEmit(NSDictionary *detail) {
    BCScreenEmitWithCompletion(detail, nil);
}

@interface BCIOSAppScreen : NSObject
@property (atomic, assign) BOOL capturing;
@property (atomic, assign) BOOL framePending;
@property (atomic, assign) CFAbsoluteTime lastFrame;
@property (atomic, assign) NSUInteger generation;
+ (instancetype)shared;
- (void)start;
- (void)stop;
@end

@implementation BCIOSAppScreen
+ (instancetype)shared {
    static BCIOSAppScreen *instance;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        instance = [BCIOSAppScreen new];
        [[NSNotificationCenter defaultCenter] addObserver:instance
            selector:@selector(backgrounded:)
            name:UIApplicationDidEnterBackgroundNotification object:nil];
    });
    return instance;
}

- (void)start {
    if (self.capturing) return;
    RPScreenRecorder *recorder = [RPScreenRecorder sharedRecorder];
    if (!recorder.available) {
        BCScreenEmit(@{@"kind": @"error", @"message": @"iPhone screen capture is unavailable right now."});
        return;
    }
    self.capturing = YES;
    NSUInteger generation = ++self.generation;
    BCScreenEmit(@{@"kind": @"starting"});
    [recorder startCaptureWithHandler:^(CMSampleBufferRef sample, RPSampleBufferType type, NSError *error) {
        if (error) {
            dispatch_async(dispatch_get_main_queue(), ^{
                if (self.generation != generation) return;
                BCScreenEmit(@{@"kind": @"error", @"message": error.localizedDescription});
                [self stop];
            });
            return;
        }
        if (type != RPSampleBufferTypeVideo || !self.capturing || self.generation != generation) return;
        [self publishFrame:sample generation:generation];
    } completionHandler:^(NSError *error) {
        dispatch_async(dispatch_get_main_queue(), ^{
            if (self.generation != generation) return;
            if (error) {
                BCScreenEmit(@{@"kind": @"error", @"message": error.localizedDescription});
                [self stop];
            } else {
                BCScreenEmit(@{@"kind": @"capturing"});
            }
        });
    }];
}

- (void)publishFrame:(CMSampleBufferRef)sample generation:(NSUInteger)generation {
    @synchronized (self) {
        CFAbsoluteTime now = CFAbsoluteTimeGetCurrent();
        if (self.framePending || now - self.lastFrame < 1.0 / 8.0) return;
        self.framePending = YES;
        self.lastFrame = now;
    }
    CVImageBufferRef buffer = CMSampleBufferGetImageBuffer(sample);
    if (!buffer) {
        self.framePending = NO;
        return;
    }
    static CIContext *context;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ context = [CIContext contextWithOptions:nil]; });
    CIImage *image = [CIImage imageWithCVPixelBuffer:buffer];
    CGRect bounds = image.extent;
    CGFloat scale = MIN(1.0, 720.0 / MAX(bounds.size.width, bounds.size.height));
    CIImage *scaled = [image imageByApplyingTransform:CGAffineTransformMakeScale(scale, scale)];
    CGImageRef cgImage = [context createCGImage:scaled fromRect:scaled.extent];
    NSData *jpeg = cgImage ? UIImageJPEGRepresentation([UIImage imageWithCGImage:cgImage], 0.6) : nil;
    if (cgImage) CGImageRelease(cgImage);
    if (!jpeg) {
        self.framePending = NO;
        return;
    }
    NSString *base64 = [jpeg base64EncodedStringWithOptions:0];
    NSNumber *width = @((NSInteger)scaled.extent.size.width);
    NSNumber *height = @((NSInteger)scaled.extent.size.height);
    dispatch_async(dispatch_get_main_queue(), ^{
        if (self.capturing && self.generation == generation) {
            if (!BCScreenPage()) [self stop];
            else {
                BCScreenEmitWithCompletion(@{@"kind": @"frame", @"jpeg": base64,
                                              @"width": width, @"height": height}, ^{
                    self.framePending = NO;
                });
                return;
            }
        }
        self.framePending = NO;
    });
}

- (void)stop {
    if (!self.capturing) return;
    self.capturing = NO;
    self.generation++;
    self.framePending = NO;
    [[RPScreenRecorder sharedRecorder] stopCaptureWithHandler:nil];
    BCScreenEmit(@{@"kind": @"stopped"});
}

- (void)backgrounded:(NSNotification *)notification {
    // The in-app recorder cannot follow the user into other applications.
    [self stop];
}
@end

void bc_ios_screen_start(void) {
    dispatch_async(dispatch_get_main_queue(), ^{ [[BCIOSAppScreen shared] start]; });
}

void bc_ios_screen_stop(void) {
    dispatch_async(dispatch_get_main_queue(), ^{ [[BCIOSAppScreen shared] stop]; });
}
