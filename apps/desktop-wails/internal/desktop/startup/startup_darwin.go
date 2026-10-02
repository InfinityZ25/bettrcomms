//go:build darwin && !ios && cgo

package startup

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Foundation -framework ServiceManagement
#import <Foundation/Foundation.h>
#import <ServiceManagement/ServiceManagement.h>
static int startupStatus(void) {
    @autoreleasepool {
        NSBundle *bundle = [NSBundle mainBundle];
        if (![bundle.bundleIdentifier isEqualToString:@"com.bettrcomms.wails"] || ![bundle.bundlePath hasSuffix:@".app"]) return -1;
        return (int)[SMAppService mainAppService].status;
    }
}
static int startupSet(int enabled) {
    @autoreleasepool {
        if (startupStatus() < 0) return 0;
        NSError *error = nil;
        BOOL success = enabled ? [[SMAppService mainAppService] registerAndReturnError:&error] : [[SMAppService mainAppService] unregisterAndReturnError:&error];
        return success;
    }
}
*/
import "C"

import "errors"

func status(_ string) (Status, error) {
	value := int(C.startupStatus())
	if value < 0 {
		return Status{Detail: "Move the installed BetterComms.app to Applications to configure launch at login."}, nil
	}
	result := Status{Available: true, Enabled: value == 1, ApprovalRequired: value == 2}
	if result.ApprovalRequired {
		result.Detail = "Approve BetterComms in macOS System Settings → General → Login Items."
	}
	if value == 3 {
		result.Detail = "macOS could not find the installed login item."
	}
	return result, nil
}
func set(executable string, enabled bool) (Status, error) {
	current, err := status(executable)
	if err != nil || !current.Available {
		return current, errors.New("Launch at login requires the installed app bundle")
	}
	if current.Enabled == enabled && !current.ApprovalRequired {
		return current, nil
	}
	flag := 0
	if enabled {
		flag = 1
	}
	if C.startupSet(C.int(flag)) == 0 {
		return current, errors.New("macOS could not change launch at login. Check Login Items in System Settings.")
	}
	return status(executable)
}
