#import <ReplayKit/ReplayKit.h>
#import <VideoToolbox/VideoToolbox.h>
#import <CoreImage/CoreImage.h>
#import <stdatomic.h>
#import "../video_encoder_recovery.h"

extern void bc_broadcast_connect(const char *path);
extern void bc_broadcast_stop(void);
extern void bc_broadcast_video(void *data, int size);
extern int bc_broadcast_encoder_control(int *force);

@interface SampleHandler : RPBroadcastSampleHandler {
    VTCompressionSessionRef _encoder;
    NSInteger _width, _height, _bitrate;
    BOOL _stopped;
    double _lastFrame;
    BCVideoEncoderRecovery _recovery;
    atomic_int _encodeError;
    atomic_bool _encoded;
}
- (void)endWithMessage:(NSString *)message;
- (void)encoded:(OSStatus)status sample:(CMSampleBufferRef)sample;
@end
static __weak SampleHandler *currentHandler;

void bc_broadcast_ended(void) {
    dispatch_async(dispatch_get_main_queue(), ^{
        [currentHandler endWithMessage:@"Screen sharing ended. Return to BetterComms to start another share."];
    });
}

static void encoded(void *ref, void *source, OSStatus status, VTEncodeInfoFlags flags, CMSampleBufferRef sample) {
    [(__bridge SampleHandler *)ref encoded:status sample:sample];
}

@implementation SampleHandler
- (void)broadcastStartedWithSetupInfo:(NSDictionary<NSString *,NSObject *> *)setupInfo {
    currentHandler=self;
    atomic_init(&_encodeError,0); atomic_init(&_encoded,false);
    NSURL *group=[NSFileManager.defaultManager containerURLForSecurityApplicationGroupIdentifier:@"group.com.bettrcomms.ios.broadcast"];
    if (!group) { [self endWithMessage:@"Screen sharing needs the BetterComms broadcast provisioning profile."]; return; }
    bc_broadcast_connect([[group URLByAppendingPathComponent:@"broadcast.json"].path fileSystemRepresentation]);
}
- (void)encoded:(OSStatus)status sample:(CMSampleBufferRef)sample {
    if (status) { atomic_store(&_encodeError,status); return; }
    if (!sample) return;
    // VideoToolbox's callback thread has no pool of its own. Without one, each
    // frame's buffers wait for an unrelated drain in a ~50 MB extension.
    @autoreleasepool { [self forward:sample]; }
}
- (void)forward:(CMSampleBufferRef)sample {
    CMBlockBufferRef block=CMSampleBufferGetDataBuffer(sample);
    size_t length=block ? CMBlockBufferGetDataLength(block) : 0;
    if (!length || length>2*1024*1024) return;
    // Read the encoder's buffer in place when it is contiguous (the usual
    // case) instead of copying every frame first.
    char *pointer=NULL; size_t contiguous=0;
    NSMutableData *copy=nil;
    const uint8_t *bytes=NULL;
    if (CMBlockBufferGetDataPointer(block,0,&contiguous,NULL,&pointer)==kCMBlockBufferNoErr && contiguous==length) {
        bytes=(const uint8_t *)pointer;
    } else {
        copy=[NSMutableData dataWithLength:length];
        if (CMBlockBufferCopyDataBytes(block,0,length,copy.mutableBytes)) return;
        bytes=copy.bytes;
    }
    NSMutableData *annex=[NSMutableData dataWithCapacity:length+128];
    const uint8_t prefix[]={0,0,0,1};
    CMFormatDescriptionRef format=CMSampleBufferGetFormatDescription(sample);
    size_t count=0; int lengthSize=0;
    if (CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format,0,NULL,NULL,&count,&lengthSize)) return;
    if (lengthSize<1 || lengthSize>4) return;
    for (size_t i=0;i<count;i++) {
        const uint8_t *bytes=NULL; size_t size=0;
        if (!CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format,i,&bytes,&size,NULL,NULL)) {
            [annex appendBytes:prefix length:4]; [annex appendBytes:bytes length:size];
        }
    }
    size_t at=0;
    while (at+(size_t)lengthSize<=length) {
        uint32_t n=0; for (int j=0;j<lengthSize;j++) n=(n<<8)|bytes[at++];
        if (!n || n>length-at) return;
        [annex appendBytes:prefix length:4]; [annex appendBytes:bytes+at length:n]; at+=n;
    }
    if (at==length) { bc_broadcast_video(annex.mutableBytes,(int)annex.length); atomic_store(&_encoded,true); }
}
- (void)processSampleBuffer:(CMSampleBufferRef)sample withType:(RPSampleBufferType)type {
    // The existing call owns its microphone. Never broadcast that microphone
    // a second time or silently mix it into screen video.
    if (type!=RPSampleBufferTypeVideo) return;
    @synchronized(self) {
        if (_stopped) return;
        double now=NSProcessInfo.processInfo.systemUptime;
        OSStatus status=atomic_exchange(&_encodeError,0);
        if (status) {
            if (!BCVideoEncoderCanRecover(status)) { [self endWithMessage:@"Screen video encoding failed."]; return; }
            BCVideoEncoderScheduleRetry(&_recovery,now);
        } else if (atomic_exchange(&_encoded,false) && !_recovery.resetRequired) BCVideoEncoderRecovered(&_recovery);
        if (now<_recovery.retryAt || now-_lastFrame<1.0/30.0) return;
        int force=0; int bitrate=bc_broadcast_encoder_control(&force);
        if (bitrate<=0) return;
        CVPixelBufferRef pixel=CMSampleBufferGetImageBuffer(sample); if (!pixel) return;
        double w=CVPixelBufferGetWidth(pixel),h=CVPixelBufferGetHeight(pixel);
        double scale=MIN(1.0,1280.0/MAX(w,h));
        NSInteger width=MAX(2,((NSInteger)(w*scale)/2)*2),height=MAX(2,((NSInteger)(h*scale)/2)*2);
        if (_encoder && (_recovery.resetRequired || width!=_width || height!=_height)) {
            // Drain first so a late error from this encoder cannot land on the next.
            VTCompressionSessionCompleteFrames(_encoder,kCMTimeInvalid);
            VTCompressionSessionInvalidate(_encoder); CFRelease(_encoder); _encoder=NULL;
            atomic_store(&_encodeError,0);
        }
        if (!_encoder) {
            _recovery.resetRequired=false; _width=width; _height=height;
            status=VTCompressionSessionCreate(NULL,(int)width,(int)height,kCMVideoCodecType_H264,NULL,NULL,NULL,encoded,(__bridge void *)self,&_encoder);
            if (!status) status=VTSessionSetProperties(_encoder,(__bridge CFDictionaryRef)@{
                (id)kVTCompressionPropertyKey_RealTime:@YES,
                (id)kVTCompressionPropertyKey_AllowFrameReordering:@NO,
                (id)kVTCompressionPropertyKey_ProfileLevel:(id)kVTProfileLevel_H264_Baseline_3_1,
                (id)kVTCompressionPropertyKey_MaxKeyFrameInterval:@30,
                (id)kVTCompressionPropertyKey_ExpectedFrameRate:@30});
            if (!status) status=VTCompressionSessionPrepareToEncodeFrames(_encoder);
            _bitrate=0; force=1;
        }
        if (!status && _bitrate!=bitrate) {
            OSStatus rate=VTSessionSetProperties(_encoder,(__bridge CFDictionaryRef)@{
                (id)kVTCompressionPropertyKey_AverageBitRate:@(bitrate),
                (id)kVTCompressionPropertyKey_DataRateLimits:@[@(bitrate*5/32),@1]});
            if (!rate) _bitrate=bitrate;
        }
        if (!status) status=VTCompressionSessionEncodeFrame(_encoder,pixel,CMSampleBufferGetPresentationTimeStamp(sample),kCMTimeInvalid,
            (__bridge CFDictionaryRef)(force ? @{(id)kVTEncodeFrameOptionKey_ForceKeyFrame:@YES} : nil),NULL,NULL);
        _lastFrame=now;
        if (status) atomic_store(&_encodeError,status);
    }
}
- (void)broadcastPaused { /* ReplayKit supplies no frames while paused. */ }
- (void)broadcastResumed { @synchronized(self) { _recovery.retryAt=0; _recovery.resetRequired=true; } }
- (void)broadcastFinished {
    @synchronized(self) {
        if (_stopped) return;
        _stopped=YES;
        bc_broadcast_stop();
        if (_encoder) { VTCompressionSessionCompleteFrames(_encoder,kCMTimeInvalid); VTCompressionSessionInvalidate(_encoder); CFRelease(_encoder); _encoder=NULL; }
    }
}
- (void)endWithMessage:(NSString *)message {
    @synchronized(self) {
        if (_stopped) return;
        [self broadcastFinished];
        [self finishBroadcastWithError:[NSError errorWithDomain:@"BetterCommsBroadcast" code:1 userInfo:@{NSLocalizedDescriptionKey:message}]];
    }
}
@end
