//go:build ios

#import <AVFoundation/AVFoundation.h>

static NSString *bc_ports(NSArray<AVAudioSessionPortDescription *> *ports) {
    NSMutableArray<NSString *> *names = [NSMutableArray arrayWithCapacity:ports.count];
    for (AVAudioSessionPortDescription *port in ports)
        [names addObject:[NSString stringWithFormat:@"%@:%@", port.portType, port.portName]];
    return [names componentsJoinedByString:@", "];
}

static void bc_log_route(NSString *reason) {
    AVAudioSession *audio = [AVAudioSession sharedInstance];
    NSLog(@"[BetterComms] audio route %@ input=[%@] output=[%@] preferredInput=%@",
          reason, bc_ports(audio.currentRoute.inputs), bc_ports(audio.currentRoute.outputs),
          audio.preferredInput ? [NSString stringWithFormat:@"%@:%@", audio.preferredInput.portType, audio.preferredInput.portName] : @"none");
}

static id bc_route_observer;

int bc_call_audio_start(int preferBuiltInMic) {
    AVAudioSession *audio = [AVAudioSession sharedInstance];
    NSError *error = nil;
    AVAudioSessionCategoryOptions options = AVAudioSessionCategoryOptionDefaultToSpeaker;
    if (preferBuiltInMic)
        options |= AVAudioSessionCategoryOptionAllowBluetoothA2DP;
    else
        options |= AVAudioSessionCategoryOptionAllowBluetoothHFP;

    BOOL configured = [audio setCategory:AVAudioSessionCategoryPlayAndRecord
        mode:AVAudioSessionModeVoiceChat options:options error:&error];
    if (configured) configured = [audio setActive:YES error:&error];

    if (configured && preferBuiltInMic) {
        AVAudioSessionPortDescription *builtIn = nil;
        for (AVAudioSessionPortDescription *input in audio.availableInputs) {
            if ([input.portType isEqualToString:AVAudioSessionPortBuiltInMic]) {
                builtIn = input;
                break;
            }
        }
        if (builtIn) configured = [audio setPreferredInput:builtIn error:&error];
        else NSLog(@"[BetterComms] Built-in microphone was requested but is not available");
    } else if (configured) {
        configured = [audio setPreferredInput:nil error:&error];
    }

    if (configured && !bc_route_observer) {
        bc_route_observer = [[NSNotificationCenter defaultCenter]
            addObserverForName:AVAudioSessionRouteChangeNotification object:audio
            queue:[NSOperationQueue mainQueue] usingBlock:^(NSNotification *note) {
                NSNumber *reason = note.userInfo[AVAudioSessionRouteChangeReasonKey];
                bc_log_route([NSString stringWithFormat:@"changed reason=%@", reason ?: @"unknown"]);
            }];
    }
    if (!configured) NSLog(@"[BetterComms] Call audio session failed: %@", error);
    else bc_log_route(preferBuiltInMic ? @"started meta-camera policy" : @"started call policy");
    return configured ? 1 : 0;
}

void bc_call_audio_stop(void) {
    AVAudioSession *audio = [AVAudioSession sharedInstance];
    if (bc_route_observer) {
        [[NSNotificationCenter defaultCenter] removeObserver:bc_route_observer];
        bc_route_observer = nil;
    }
    NSError *error = nil;
    [audio setPreferredInput:nil error:nil];
    [audio setActive:NO withOptions:AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation error:&error];
    if (error) NSLog(@"[BetterComms] Call audio deactivation failed: %@", error);
}
