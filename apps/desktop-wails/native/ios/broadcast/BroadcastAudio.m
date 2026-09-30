#import "BroadcastAudio.h"
#import <opus/opus.h>
extern void bc_broadcast_audio(void *data, int size, long long pts);

@implementation BCBroadcastAudio {
    AVAudioConverter *_converter;
    AVAudioFormat *_inputFormat;
    OpusEncoder *_opus;
    float _pending[960*2];
    unsigned _frames;
    double _nextPTS;
}
- (void)reset {
    _converter=nil; _inputFormat=nil; _frames=0;
    if (_opus) { opus_encoder_destroy(_opus); _opus=NULL; }
}
- (void)dealloc { [self reset]; }
- (BOOL)process:(CMSampleBufferRef)sample {
    const AudioStreamBasicDescription *asbd=CMAudioFormatDescriptionGetStreamBasicDescription(CMSampleBufferGetFormatDescription(sample));
    CMItemCount frames=CMSampleBufferGetNumSamples(sample);
    double pts=CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sample));
    if (!asbd || asbd->mFormatID!=kAudioFormatLinearPCM || frames<=0 || frames>8192 || !isfinite(pts)) return NO;
    AVAudioFormat *format=[[AVAudioFormat alloc] initWithStreamDescription:asbd];
    if (!format) return NO;
    if (!_converter || ![_inputFormat isEqual:format]) {
        [self reset]; _inputFormat=format;
        AVAudioFormat *output=[[AVAudioFormat alloc] initWithCommonFormat:AVAudioPCMFormatFloat32 sampleRate:48000 channels:2 interleaved:YES];
        _converter=[[AVAudioConverter alloc] initFromFormat:format toFormat:output];
        int error=0; _opus=opus_encoder_create(48000,2,OPUS_APPLICATION_AUDIO,&error);
        if (!_converter || !_opus || error!=OPUS_OK) { [self reset]; return NO; }
        opus_encoder_ctl(_opus,OPUS_SET_BITRATE(128000));
        opus_encoder_ctl(_opus,OPUS_SET_COMPLEXITY(5));
        opus_encoder_ctl(_opus,OPUS_SET_INBAND_FEC(1));
        opus_encoder_ctl(_opus,OPUS_SET_PACKET_LOSS_PERC(5));
        _nextPTS=pts;
    }
    // A paused broadcast or a changed source must not replay an old partial
    // packet, nor compress a genuine gap out of the media timeline.
    if (fabs(pts-(_nextPTS+(double)_frames/48000))>0.1) { _frames=0; _nextPTS=pts; }
    AVAudioPCMBuffer *input=[[AVAudioPCMBuffer alloc] initWithPCMFormat:format frameCapacity:(AVAudioFrameCount)frames];
    if (!input) return NO;
    input.frameLength=(AVAudioFrameCount)frames;
    size_t listSize=0;
    CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sample,&listSize,NULL,0,NULL,NULL,0,NULL);
    if (!listSize || listSize>4096) return NO;
    AudioBufferList *list=malloc(listSize); CMBlockBufferRef retained=NULL;
    OSStatus status=CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sample,NULL,list,listSize,NULL,NULL,kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,&retained);
    AudioBufferList *target=input.mutableAudioBufferList;
    BOOL valid=!status && list->mNumberBuffers==target->mNumberBuffers;
    if (valid) for (UInt32 i=0;i<list->mNumberBuffers;i++) {
        if (!list->mBuffers[i].mData || list->mBuffers[i].mDataByteSize!=target->mBuffers[i].mDataByteSize) { valid=NO; break; }
        memcpy(target->mBuffers[i].mData,list->mBuffers[i].mData,list->mBuffers[i].mDataByteSize);
    }
    if (retained) CFRelease(retained); free(list);
    if (!valid) return NO;
    AVAudioFrameCount capacity=(AVAudioFrameCount)ceil((double)frames*48000/format.sampleRate)+128;
    if (capacity>16384) return NO;
    AVAudioPCMBuffer *output=[[AVAudioPCMBuffer alloc] initWithPCMFormat:_converter.outputFormat frameCapacity:capacity];
    __block BOOL supplied=NO; NSError *error=nil;
    AVAudioConverterOutputStatus result=[_converter convertToBuffer:output error:&error withInputFromBlock:^AVAudioBuffer *(AVAudioPacketCount count, AVAudioConverterInputStatus *inputStatus) {
        if (supplied) { *inputStatus=AVAudioConverterInputStatus_NoDataNow; return nil; }
        supplied=YES; *inputStatus=AVAudioConverterInputStatus_HaveData; return input;
    }];
    if (result==AVAudioConverterOutputStatus_Error || error) return NO;
    const float *data=output.audioBufferList->mBuffers[0].mData;
    unsigned at=0;
    while (at<output.frameLength) {
        unsigned count=MIN(960-_frames,output.frameLength-at);
        memcpy(_pending+_frames*2,data+at*2,count*2*sizeof(float));
        at+=count; _frames+=count;
        if (_frames==960) {
            unsigned char packet[1275];
            int size=opus_encode_float(_opus,_pending,960,packet,sizeof(packet));
            if (size<0) return NO;
            bc_broadcast_audio(packet,size,(long long)llround(_nextPTS*1e9));
            _frames=0; _nextPTS+=0.02;
        }
    }
    return YES;
}
@end
