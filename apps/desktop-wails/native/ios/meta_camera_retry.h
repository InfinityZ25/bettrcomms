#import <Foundation/Foundation.h>

// DAT's Objective-C API bridges its Swift errors to NSError. Match the pinned
// SDK's localized resource keys, not English text or guessed enum numbers.
static inline BOOL BCMetaSessionErrorCanRetry(NSError *error, NSBundle *sdkBundle) {
    // Observed on DAT 1.0's Objective-C start-and-wait bridge: code 1 means
    // stopped before readiness. Retry only this exact domain/code combination.
    if ([error.domain isEqualToString:@"MWDATDeviceSession"] && error.code == 1) return YES;
    if (![error.domain isEqualToString:@"MWDATCore.DeviceSessionError"]) return NO;
    for (NSString *key in @[@"dat_error_session_no_eligible_device",
                            @"dat_error_session_device_disconnected",
                            @"dat_error_session_ended_by_device"]) {
        NSString *message = [sdkBundle localizedStringForKey:key value:key table:@"CoreErrors"];
        if (![message isEqualToString:key] && [error.localizedDescription isEqualToString:message])
            return YES;
    }
    return NO;
}
