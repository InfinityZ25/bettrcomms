//go:build ios

#import <AVFoundation/AVFoundation.h>

int bc_call_audio_start(void) {
    AVAudioSession *audio = [AVAudioSession sharedInstance];
    NSError *error = nil;
    BOOL configured = [audio setCategory:AVAudioSessionCategoryPlayAndRecord
        mode:AVAudioSessionModeVoiceChat
        options:AVAudioSessionCategoryOptionAllowBluetooth |
                AVAudioSessionCategoryOptionDefaultToSpeaker
        error:&error];
    if (configured) configured = [audio setActive:YES error:&error];
    if (!configured) NSLog(@"[BetterComms] Call audio session failed: %@", error);
    return configured ? 1 : 0;
}

void bc_call_audio_stop(void) {
    NSError *error = nil;
    [[AVAudioSession sharedInstance] setActive:NO
        withOptions:AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation
        error:&error];
    if (error) NSLog(@"[BetterComms] Call audio deactivation failed: %@", error);
}
