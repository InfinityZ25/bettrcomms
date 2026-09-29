#import <Foundation/Foundation.h>
#import "meta_camera_retry.h"

@interface TestSDKBundle : NSBundle
@property(nonatomic, copy) NSDictionary<NSString *, NSString *> *messages;
@end
@implementation TestSDKBundle
- (NSString *)localizedStringForKey:(NSString *)key value:(NSString *)value table:(NSString *)table {
    NSCAssert([table isEqualToString:@"CoreErrors"], @"Use the SDK's error table");
    return self.messages[key] ?: value;
}
@end

static NSError *SessionError(NSString *message) {
    return [NSError errorWithDomain:@"MWDATCore.DeviceSessionError" code:1
                          userInfo:@{NSLocalizedDescriptionKey: message}];
}

int main(void) {
    @autoreleasepool {
        TestSDKBundle *bundle = [TestSDKBundle new];
        for (NSString *message in @[@"No eligible device available", @"No hay ningún dispositivo apto disponible"]) {
            bundle.messages = @{@"dat_error_session_no_eligible_device": message};
            NSCAssert(BCMetaSessionErrorCanRetry(SessionError(message), bundle),
                      @"Transient session errors must retry in either language");
        }
        bundle.messages = @{@"dat_error_session_device_disconnected": @"Device disconnected",
                            @"dat_error_session_ended_by_device": @"Session ended by device"};
        NSCAssert(BCMetaSessionErrorCanRetry(SessionError(@"Device disconnected"), bundle), @"Reconnect");
        NSCAssert(!BCMetaSessionErrorCanRetry(SessionError(@"Device thermal state is critical"), bundle), @"Stop for thermal errors");
        NSCAssert(!BCMetaSessionErrorCanRetry(SessionError(@"dat_error_session_no_eligible_device"), bundle), @"Missing localization must not match a key");
        NSCAssert(!BCMetaSessionErrorCanRetry([NSError errorWithDomain:@"AnotherDomain" code:1
            userInfo:@{NSLocalizedDescriptionKey: @"Device disconnected"}], bundle), @"Do not classify unrelated errors");
        puts("Meta session retry policy passed (localized, transient, terminal and unrelated errors).");
    }
}
