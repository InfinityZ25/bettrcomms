//go:build ios

#import <AVFoundation/AVFoundation.h>

static NSString *bc_route_ports(NSArray<AVAudioSessionPortDescription *> *ports) {
    NSMutableArray<NSString *> *values = [NSMutableArray array];
    for (AVAudioSessionPortDescription *port in ports)
        [values addObject:[NSString stringWithFormat:@"%@:%@", port.portType, port.portName]];
    return [values componentsJoinedByString:@", "];
}

static void bc_log_audio_route(NSString *reason) {
    AVAudioSession *audio = [AVAudioSession sharedInstance];
    NSLog(@"[BetterComms] audio route %@ input=[%@] output=[%@] sampleRate=%.0f channels(in=%ld,out=%ld)",
          reason, bc_route_ports(audio.currentRoute.inputs), bc_route_ports(audio.currentRoute.outputs),
          audio.sampleRate, (long)audio.inputNumberOfChannels, (long)audio.outputNumberOfChannels);
}

static id bc_route_observer;

int bc_call_audio_start(void) {
    AVAudioSession *audio = [AVAudioSession sharedInstance];
    NSError *error = nil;
    BOOL configured = [audio setCategory:AVAudioSessionCategoryPlayAndRecord
        mode:AVAudioSessionModeVoiceChat
        options:AVAudioSessionCategoryOptionAllowBluetooth |
                AVAudioSessionCategoryOptionDefaultToSpeaker
        error:&error];
    if (configured) configured = [audio setActive:YES error:&error];
    if (configured && !bc_route_observer) {
        bc_route_observer = [[NSNotificationCenter defaultCenter]
            addObserverForName:AVAudioSessionRouteChangeNotification object:audio
            queue:[NSOperationQueue mainQueue] usingBlock:^(NSNotification *note) {
                bc_log_audio_route([NSString stringWithFormat:@"changed reason=%@", note.userInfo[AVAudioSessionRouteChangeReasonKey] ?: @"unknown"]);
            }];
        bc_log_audio_route(@"started");
    }
    if (!configured) NSLog(@"[BetterComms] Call audio session failed: %@", error);
    return configured ? 1 : 0;
}

void bc_call_audio_stop(void) {
    if (bc_route_observer) {
        [[NSNotificationCenter defaultCenter] removeObserver:bc_route_observer];
        bc_route_observer = nil;
    }
    NSError *error = nil;
    [[AVAudioSession sharedInstance] setActive:NO
        withOptions:AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation
        error:&error];
    if (error) NSLog(@"[BetterComms] Call audio deactivation failed: %@", error);
}
