#import <ReplayKit/ReplayKit.h>
#import <VideoToolbox/VideoToolbox.h>
#import <CoreImage/CoreImage.h>
#import <stdatomic.h>
#import "../video_encoder_recovery.h"

extern void bc_broadcast_connect(const char *path);
extern void bc_broadcast_stop(void);
extern void bc_broadcast_video(void *data, int size, long long captured_us);
extern int bc_broadcast_encoder_control(int *force);

@interface SampleHandler : RPBroadcastSampleHandler {
    VTCompressionSessionRef _encoder;
    // Landscape apps arrive sideways in a portrait buffer. These turn them
    // upright at the already scaled-down size, to stay inside the extension's
    // memory limit.
    VTPixelTransferSessionRef _scaler;
    VTPixelRotationSessionRef _rotator;
    CVPixelBufferRef _scaled;
    CVPixelBufferPoolRef _uprightPool;
    NSInteger _width, _height, _bitrate;
    BOOL _stopped;
    double _lastFrame;
    BCVideoEncoderRecovery _recovery;
    atomic_int _encodeError;
    atomic_bool _encoded;
}
- (void)endWithMessage:(NSString *)message;
- (void)encoded:(OSStatus)status sample:(CMSampleBufferRef)sample;
- (CVPixelBufferRef)copyUpright:(CVPixelBufferRef)pixel sample:(CMSampleBufferRef)sample width:(NSInteger)width height:(NSInteger)height CF_RETURNS_RETAINED;
- (void)releaseRotation;
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
    // The extension's own ID is the host's plus ".broadcast"; its App Group
    // is that ID with a "group." prefix (see broadcast_host.m).
    NSString *identifier=[@"group." stringByAppendingString:NSBundle.mainBundle.bundleIdentifier];
    NSURL *group=[NSFileManager.defaultManager containerURLForSecurityApplicationGroupIdentifier:identifier];
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
    if (at==length) {
        // The frame's own capture time, so viewers see the screen's real
        // cadence rather than a fixed 30 fps grid. Zero falls back to arrival.
        CMTime captured=CMSampleBufferGetPresentationTimeStamp(sample);
        long long micros=CMTIME_IS_NUMERIC(captured) ? (long long)(CMTimeGetSeconds(captured)*1e6) : 0;
        bc_broadcast_video(annex.mutableBytes,(int)annex.length,micros);
        atomic_store(&_encoded,true);
    }
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
        if (now<_recovery.retryAt) return;
        // Cap at 30 fps by capture time, with tolerance: frames from a 30 fps
        // screen arrive a few milliseconds early as often as late, and an
        // exact 1/30 s gate discarded every early one.
        CMTime stamp=CMSampleBufferGetPresentationTimeStamp(sample);
        double captured=CMTIME_IS_NUMERIC(stamp) ? CMTimeGetSeconds(stamp) : now;
        if (captured>=_lastFrame && captured-_lastFrame<1.0/30.0-0.005) return;
        int force=0; int bitrate=bc_broadcast_encoder_control(&force);
        if (bitrate<=0) return;
        CVPixelBufferRef source=CMSampleBufferGetImageBuffer(sample); if (!source) return;
        double w=CVPixelBufferGetWidth(source),h=CVPixelBufferGetHeight(source);
        double scale=MIN(1.0,1280.0/MAX(w,h));
        NSInteger width=MAX(2,((NSInteger)(w*scale)/2)*2),height=MAX(2,((NSInteger)(h*scale)/2)*2);
        CVPixelBufferRef pixel=[self copyUpright:source sample:sample width:width height:height];
        if (!pixel) return;
        if (pixel!=source) { width=CVPixelBufferGetWidth(pixel); height=CVPixelBufferGetHeight(pixel); }
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
                // Viewers ask for a keyframe when they need one (and get one as
                // they connect), so scheduled ones can be rare. One a second
                // spent a large share of the bitrate re-sending the whole
                // screen and pulsed text between sharp and soft.
                (id)kVTCompressionPropertyKey_MaxKeyFrameInterval:@120,
                (id)kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration:@4,
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
        if (!status) status=VTCompressionSessionEncodeFrame(_encoder,pixel,stamp,kCMTimeInvalid,
            (__bridge CFDictionaryRef)(force ? @{(id)kVTEncodeFrameOptionKey_ForceKeyFrame:@YES} : nil),NULL,NULL);
        CVPixelBufferRelease(pixel);
        _lastFrame=captured;
        if (status) atomic_store(&_encodeError,status);
    }
}
// Returns the frame the encoder should see, retained. ReplayKit always
// delivers the screen in the phone's portrait layout and tags how a landscape
// app is turned within it. Untagged and portrait frames pass through
// untouched; if anything here fails the frame is sent as it arrived, which is
// what every frame did before.
- (CVPixelBufferRef)copyUpright:(CVPixelBufferRef)pixel sample:(CMSampleBufferRef)sample width:(NSInteger)width height:(NSInteger)height {
    CFStringRef rotation=NULL;
    NSNumber *tag=(__bridge NSNumber *)CMGetAttachment(sample,(__bridge CFStringRef)RPVideoSampleOrientationKey,NULL);
    switch ([tag isKindOfClass:NSNumber.class] ? tag.unsignedIntValue : kCGImagePropertyOrientationUp) {
        case kCGImagePropertyOrientationLeft: rotation=kVTRotation_CW90; break;
        case kCGImagePropertyOrientationRight: rotation=kVTRotation_CCW90; break;
        case kCGImagePropertyOrientationDown: rotation=kVTRotation_180; break;
        default: [self releaseRotation]; return CVPixelBufferRetain(pixel);
    }
    BOOL quarter=rotation!=kVTRotation_180;
    size_t outWidth=quarter ? height : width, outHeight=quarter ? width : height;
    OSType format=CVPixelBufferGetPixelFormatType(pixel);
    NSDictionary *surface=@{(id)kCVPixelBufferIOSurfacePropertiesKey:@{}};
    if (_scaled && (CVPixelBufferGetWidth(_scaled)!=(size_t)width || CVPixelBufferGetHeight(_scaled)!=(size_t)height ||
                    CVPixelBufferGetPixelFormatType(_scaled)!=format)) [self releaseRotation];
    if (!_scaled && CVPixelBufferCreate(NULL,width,height,format,(__bridge CFDictionaryRef)surface,&_scaled)) return CVPixelBufferRetain(pixel);
    if (!_scaler && VTPixelTransferSessionCreate(NULL,&_scaler)) return CVPixelBufferRetain(pixel);
    if (!_rotator && VTPixelRotationSessionCreate(NULL,&_rotator)) return CVPixelBufferRetain(pixel);
    if (_uprightPool) {
        NSDictionary *current=(__bridge NSDictionary *)CVPixelBufferPoolGetPixelBufferAttributes(_uprightPool);
        if ([current[(id)kCVPixelBufferWidthKey] unsignedLongValue]!=outWidth) { CVPixelBufferPoolRelease(_uprightPool); _uprightPool=NULL; }
    }
    if (!_uprightPool) {
        NSDictionary *attributes=@{(id)kCVPixelBufferPixelFormatTypeKey:@(format),(id)kCVPixelBufferWidthKey:@(outWidth),
            (id)kCVPixelBufferHeightKey:@(outHeight),(id)kCVPixelBufferIOSurfacePropertiesKey:@{}};
        if (CVPixelBufferPoolCreate(NULL,NULL,(__bridge CFDictionaryRef)attributes,&_uprightPool)) return CVPixelBufferRetain(pixel);
    }
    // The encoder holds a frame briefly after this returns. A small pool lets
    // it, and the threshold keeps a stalled encoder from growing memory.
    CVPixelBufferRef upright=NULL;
    NSDictionary *limit=@{(id)kCVPixelBufferPoolAllocationThresholdKey:@3};
    if (CVPixelBufferPoolCreatePixelBufferWithAuxAttributes(NULL,_uprightPool,(__bridge CFDictionaryRef)limit,&upright) || !upright) return NULL;
    if (VTSessionSetProperty(_rotator,kVTPixelRotationPropertyKey_Rotation,rotation) ||
        VTPixelTransferSessionTransferImage(_scaler,pixel,_scaled) ||
        VTPixelRotationSessionRotateImage(_rotator,_scaled,upright)) {
        CVPixelBufferRelease(upright);
        return CVPixelBufferRetain(pixel);
    }
    return upright;
}
- (void)releaseRotation {
    if (_scaler) { VTPixelTransferSessionInvalidate(_scaler); CFRelease(_scaler); _scaler=NULL; }
    if (_rotator) { VTPixelRotationSessionInvalidate(_rotator); CFRelease(_rotator); _rotator=NULL; }
    if (_scaled) { CVPixelBufferRelease(_scaled); _scaled=NULL; }
    if (_uprightPool) { CVPixelBufferPoolRelease(_uprightPool); _uprightPool=NULL; }
}
- (void)broadcastPaused { /* ReplayKit supplies no frames while paused. */ }
- (void)broadcastResumed { @synchronized(self) { _recovery.retryAt=0; _recovery.resetRequired=true; } }
- (void)broadcastFinished {
    @synchronized(self) {
        if (_stopped) return;
        _stopped=YES;
        bc_broadcast_stop();
        if (_encoder) { VTCompressionSessionCompleteFrames(_encoder,kCMTimeInvalid); VTCompressionSessionInvalidate(_encoder); CFRelease(_encoder); _encoder=NULL; }
        [self releaseRotation];
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
