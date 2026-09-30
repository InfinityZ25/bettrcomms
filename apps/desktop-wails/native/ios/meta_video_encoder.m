#import "meta_video_encoder.h"
#import <VideoToolbox/VideoToolbox.h>
#import <CoreImage/CoreImage.h>
#import <os/log.h>
#import "video_encoder_recovery.h"
#include <stdatomic.h>
#include <fcntl.h>
#include <unistd.h>
extern void bc_meta_video_encoded(void *data, int size);

void BCNativeVideoLog(NSString *message) {
    os_log(OS_LOG_DEFAULT, "BetterComms Meta native: %{public}@", message);
    static dispatch_queue_t queue;
    static dispatch_semaphore_t pending;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        queue = dispatch_queue_create("com.bettrcomms.media-diagnostics", DISPATCH_QUEUE_SERIAL);
        pending = dispatch_semaphore_create(32);
    });
    // Diagnostics must never block capture or grow an unbounded task queue.
    if (dispatch_semaphore_wait(pending, DISPATCH_TIME_NOW)) return;
    NSString *line = [NSString stringWithFormat:@"%.3f %@\n", NSProcessInfo.processInfo.systemUptime,
        [message substringToIndex:MIN(message.length, 512)]];
    dispatch_async(queue, ^{
        @autoreleasepool {
            NSString *directory = [NSSearchPathForDirectoriesInDomains(NSCachesDirectory, NSUserDomainMask, YES).firstObject
                stringByAppendingPathComponent:@"NativeMedia"];
            NSFileManager *files = NSFileManager.defaultManager;
            [files createDirectoryAtPath:directory withIntermediateDirectories:YES attributes:
                @{NSFileProtectionKey: NSFileProtectionCompleteUntilFirstUserAuthentication} error:nil];
            NSString *path = [directory stringByAppendingPathComponent:@"video.log"];
            if ([[files attributesOfItemAtPath:path error:nil] fileSize] >= 256 * 1024) {
                NSString *previous = [directory stringByAppendingPathComponent:@"video.previous.log"];
                [files removeItemAtPath:previous error:nil];
                [files moveItemAtPath:path toPath:previous error:nil];
            }
            int file = open(path.fileSystemRepresentation, O_WRONLY | O_CREAT | O_APPEND, 0600);
            if (file >= 0) {
                NSData *data = [line dataUsingEncoding:NSUTF8StringEncoding];
                (void)write(file, data.bytes, data.length);
                close(file);
            }
        }
        dispatch_semaphore_signal(pending);
    });
}

@interface BCMetaVideoEncoder () {
    VTDecompressionSessionRef _decoder;
    CMFormatDescriptionRef _format;
    VTCompressionSessionRef _encoder;
    BOOL _closed;
    NSInteger _targetBitrate;
    NSInteger _configuredBitrate;
    CFAbsoluteTime _nextRateAttempt;
    BOOL _forceKeyframe;
    CFAbsoluteTime _statsStarted;
    NSUInteger _frames;
    BOOL _reportedError;
    BOOL _awaitingKeyframe;
    NSUInteger _decodeFailures;
    BCVideoEncoderRecovery _recovery;
    BCVideoEncoderRecovery _decoderRecovery;
    atomic_int _callbackError;
    atomic_ulong _encodedFrames;
    unsigned long _lastEncodedFrames;
    unsigned long _statsEncodedFrames;
    BOOL _foreground;
}
- (void)encodedFrame;
- (void)encoderCallbackFailed:(OSStatus)status;
- (void)compressionFailed:(OSStatus)status stage:(NSString *)stage now:(double)now;
- (void)decompressionFailed:(OSStatus)status stage:(NSString *)stage now:(double)now;

@property (nonatomic, strong) CIContext *previewContext;
@end

static void BCEncoded(void *ref, void *source, OSStatus status, VTEncodeInfoFlags flags, CMSampleBufferRef sample) {
    BCMetaVideoEncoder *owner = (__bridge BCMetaVideoEncoder *)ref;
    if (status || !sample) {
        if (status) [owner encoderCallbackFailed:status];
        return;
    }
    CMBlockBufferRef block = CMSampleBufferGetDataBuffer(sample);
    if (!block) return;
    size_t size = CMBlockBufferGetDataLength(block);
    if (!size || size > 16*1024*1024) return;
    NSMutableData *avcc = [NSMutableData dataWithLength:size];
    if (CMBlockBufferCopyDataBytes(block, 0, size, avcc.mutableBytes)) return;
    NSMutableData *annex = [NSMutableData data];
    const uint8_t prefix[] = {0,0,0,1};
    CMFormatDescriptionRef format = CMSampleBufferGetFormatDescription(sample);
    int lengthSize=0;
    size_t parameterCount=0;
    if (CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format,0,NULL,NULL,&parameterCount,&lengthSize)) return;
    for (size_t i=0;i<parameterCount;i++) {
        const uint8_t *data=NULL; size_t length=0;
        if (!CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format,i,&data,&length,NULL,NULL)) {
            [annex appendBytes:prefix length:4]; [annex appendBytes:data length:length];
        }
    }
    if (lengthSize < 1 || lengthSize > 4) return;
    const uint8_t *bytes=avcc.bytes;
    size_t at=0;
    while (at+(size_t)lengthSize<=size) {
        uint32_t n=0;
        for (int j=0;j<lengthSize;j++) n=(n<<8)|bytes[at++];
        if (!n || n>size-at) return;
        [annex appendBytes:prefix length:4]; [annex appendBytes:bytes+at length:n]; at+=n;
    }
    if (at==size) {
        bc_meta_video_encoded(annex.mutableBytes,(int)annex.length);
        [owner encodedFrame];
    }
}
@implementation BCMetaVideoEncoder
- (instancetype)init {
    if ((self = [super init])) {
        atomic_init(&_callbackError, 0);
        atomic_init(&_encodedFrames, 0);
        _foreground = YES;
    }
    return self;
}
- (void)encodedFrame { atomic_fetch_add(&_encodedFrames, 1); }
- (void)encoderCallbackFailed:(OSStatus)status {
    // VT callbacks may run while close/invalidate waits for outstanding work.
    // Do not acquire the capture lock or tear the encoder down on this queue.
    BCNativeVideoLog([NSString stringWithFormat:@"encoder callback status=%d", (int)status]);
    atomic_store(&_callbackError, status);
}
- (void)appForegroundChanged:(BOOL)foreground {
    @synchronized(self) {
        _foreground = foreground;
        if (foreground) {
            _recovery.retryAt = 0;
            _decoderRecovery.retryAt = 0;
            _forceKeyframe = YES;
        }
    }
}
- (void)compressionFailed:(OSStatus)status stage:(NSString *)stage now:(double)now {
    if (!BCVideoEncoderCanRecover(status)) { [self fail:status stage:stage]; return; }
    double delay = BCVideoEncoderScheduleRetry(&_recovery, now);
    _forceKeyframe = YES;
    BCNativeVideoLog([NSString stringWithFormat:@"encoder recovery stage=%@ status=%d foreground=%d retryIn=%.1f", stage, (int)status, _foreground, delay]);
}
- (void)configureBitrate:(NSInteger)bitrate forceKeyframe:(BOOL)force {
    @synchronized(self) {
        if (_closed) return;
        if (bitrate > 0) _targetBitrate = MAX(1000000, MIN(8000000, bitrate));
        _forceKeyframe = _forceKeyframe || force;
    }
}
- (void)decompressionFailed:(OSStatus)status stage:(NSString *)stage now:(double)now {
    if (!BCVideoDecoderCanRecover(status)) { [self fail:status stage:stage]; return; }
    double delay = BCVideoEncoderScheduleRetry(&_decoderRecovery, now);
    _awaitingKeyframe = YES;
    _forceKeyframe = YES;
    BCNativeVideoLog([NSString stringWithFormat:@"decoder recovery stage=%@ status=%d foreground=%d retryIn=%.1f", stage, (int)status, _foreground, delay]);
}
- (NSDictionary *)rateSettings {
    NSInteger bitrate = _targetBitrate ?: 3000000;
    return @{(id)kVTCompressionPropertyKey_AverageBitRate:@(bitrate),
        // Hard cap over one second, in bytes. Keep encoder and RTP pacing aligned.
        (id)kVTCompressionPropertyKey_DataRateLimits:@[@(bitrate * 5 / 32), @1]};
}
- (void)fail:(OSStatus)status stage:(NSString *)stage {
    if (_reportedError) return;
    _reportedError=YES;
    BCNativeVideoLog([NSString stringWithFormat:@"fatal video stage=%@ status=%d foreground=%d", stage, (int)status, _foreground]);
    if (self.onError) self.onError([NSString stringWithFormat:@"Native glasses video %@ failed (%d).",stage,(int)status]);
}
- (UIImage *)process:(CMSampleBufferRef)sample publish:(BOOL)publish preview:(BOOL)preview {
    @synchronized(self) {
        // HEVC delta frames depend on earlier frames. Throttle only preview rendering,
        // never decoding; skipping input here corrupts the next preview/keyframe chain.
        if (_closed) return nil;
        CMFormatDescriptionRef format=CMSampleBufferGetFormatDescription(sample);
        if (!format) return nil;
        double now = NSProcessInfo.processInfo.systemUptime;
        OSStatus callbackError = atomic_exchange(&_callbackError, 0);
        unsigned long encoded = atomic_load(&_encodedFrames);
        if (callbackError) [self compressionFailed:callbackError stage:@"encode callback" now:now];
        else if (encoded > _lastEncodedFrames && !_recovery.resetRequired) {
            if (_recovery.failures) BCNativeVideoLog([NSString stringWithFormat:@"encoder recovered foreground=%d", _foreground]);
            BCVideoEncoderRecovered(&_recovery);
        }
        _lastEncodedFrames = encoded;
        if (!_statsStarted) _statsStarted=now;
        _frames++;
        if (now-_statsStarted>=5) {
            CMVideoDimensions size=CMVideoFormatDescriptionGetDimensions(CMSampleBufferGetFormatDescription(sample));
            BCNativeVideoLog([NSString stringWithFormat:@"input=%dx%d fps=%.1f outputFps=%.1f publishing=%d preview=%d foreground=%d", size.width,size.height,_frames/(now-_statsStarted),(encoded-_statsEncodedFrames)/(now-_statsStarted),publish,preview,_foreground]);
            _statsEncodedFrames=encoded;
            _statsStarted=now; _frames=0;
        }
        if (now < _decoderRecovery.retryAt) return nil;
        if (_decoderRecovery.resetRequired || !_decoder || !_format || !CMFormatDescriptionEqual(format,_format)) {
            if (_decoder) { VTDecompressionSessionInvalidate(_decoder); CFRelease(_decoder); _decoder=NULL; }
            if (_format) CFRelease(_format);
            _format=(CMFormatDescriptionRef)CFRetain(format);
            _awaitingKeyframe=YES;
            _decoderRecovery.resetRequired = false;
            NSDictionary *attributes=@{(id)kCVPixelBufferPixelFormatTypeKey:@(kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)};
            // Request software decoding; iOS can still invalidate a session
            // on backgrounding, so its lifetime must be recoverable too.
            NSDictionary *spec=@{(id)kVTVideoDecoderSpecification_EnableHardwareAcceleratedVideoDecoder:@NO};
            OSStatus status=VTDecompressionSessionCreate(NULL,format,(__bridge CFDictionaryRef)spec,
                (__bridge CFDictionaryRef)attributes,NULL,&_decoder);
            if (status) {
                [self decompressionFailed:status stage:@"decoder setup" now:now];
                return nil;
            }
            CFTypeRef hardware = NULL;
            VTSessionCopyProperty(_decoder,kVTDecompressionPropertyKey_UsingHardwareAcceleratedVideoDecoder,NULL,&hardware);
            BCNativeVideoLog([NSString stringWithFormat:@"decoder created hardware=%d foreground=%d", hardware == kCFBooleanTrue, _foreground]);
            if (hardware) CFRelease(hardware);
        }
        CFArrayRef attachments=CMSampleBufferGetSampleAttachmentsArray(sample,false);
        BOOL sync=YES;
        if (attachments && CFArrayGetCount(attachments)) {
            CFDictionaryRef attributes=CFArrayGetValueAtIndex(attachments,0);
            sync=CFDictionaryGetValue(attributes,kCMSampleAttachmentKey_NotSync)!=kCFBooleanTrue;
        }
        if (_awaitingKeyframe && !sync) return nil;
        __block CVPixelBufferRef pixel=NULL;
        __block OSStatus callbackStatus = noErr;
        OSStatus status=VTDecompressionSessionDecodeFrameWithOutputHandler(_decoder,sample,0,NULL,
            ^(OSStatus result, VTDecodeInfoFlags flags, CVImageBufferRef image, CMTime pts, CMTime duration) {
                callbackStatus = result;
                if (!result && image) pixel=CVPixelBufferRetain(image);
            });
        if (!status) status = callbackStatus;
        if (status || !pixel) {
            if (pixel) CVPixelBufferRelease(pixel);
            _awaitingKeyframe=YES;
            if (BCVideoDecoderCanRecover(status)) [self decompressionFailed:status stage:@"decode" now:now];
            else if (++_decodeFailures>=5 && status) [self fail:status stage:@"decode"];
            return nil;
        }
        if (_decoderRecovery.failures) BCNativeVideoLog([NSString stringWithFormat:@"decoder recovered foreground=%d", _foreground]);
        BCVideoEncoderRecovered(&_decoderRecovery);
        _awaitingKeyframe=NO; _decodeFailures=0;
        if (publish && now >= _recovery.retryAt && !_reportedError) {
            if (_recovery.resetRequired) {
                // Drain the retired encoder first: invalidation alone does not
                // guarantee its callbacks have run, and a late error from it
                // would otherwise tear down the replacement.
                if (_encoder) { VTCompressionSessionCompleteFrames(_encoder,kCMTimeInvalid); VTCompressionSessionInvalidate(_encoder); CFRelease(_encoder); _encoder=NULL; }
                atomic_store(&_callbackError, 0);
                _recovery.resetRequired = false;
            }
            if (!_encoder) {
                status=VTCompressionSessionCreate(NULL,(int)CVPixelBufferGetWidth(pixel),(int)CVPixelBufferGetHeight(pixel),
                    kCMVideoCodecType_H264,NULL,NULL,NULL,BCEncoded,(__bridge void *)self,&_encoder);
                if (!status) {
                    NSMutableDictionary *settings=[@{(id)kVTCompressionPropertyKey_RealTime:@YES,
                        (id)kVTCompressionPropertyKey_AllowFrameReordering:@NO,
                        (id)kVTCompressionPropertyKey_ProfileLevel:(id)kVTProfileLevel_H264_Baseline_3_1,
                        (id)kVTCompressionPropertyKey_ExpectedFrameRate:@30,
                        (id)kVTCompressionPropertyKey_MaxKeyFrameInterval:@30} mutableCopy];
                    [settings addEntriesFromDictionary:[self rateSettings]];
                    status=VTSessionSetProperties(_encoder,(__bridge CFDictionaryRef)settings);
                    if (!status) {
                        _configuredBitrate = _targetBitrate ?: 3000000;
                        status=VTCompressionSessionPrepareToEncodeFrames(_encoder);
                    }
                }
                if (status) [self compressionFailed:status stage:@"encoder setup" now:now];
                else {
                    CFTypeRef hardware = NULL;
                    if (@available(iOS 17.4, *)) {
                        VTSessionCopyProperty(_encoder,kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder,NULL,&hardware);
                    }
                    BCNativeVideoLog([NSString stringWithFormat:@"encoder created hardware=%d foreground=%d", hardware == kCFBooleanTrue, _foreground]);
                    if (hardware) CFRelease(hardware);
                }
            }
            if (_encoder && !status) {
                NSInteger bitrate = _targetBitrate ?: 3000000;
                if (bitrate != _configuredBitrate && now >= _nextRateAttempt) {
                    OSStatus rateStatus=VTSessionSetProperties(_encoder,(__bridge CFDictionaryRef)[self rateSettings]);
                    if (!rateStatus) {
                        _configuredBitrate=bitrate;
                    } else {
                        // Rate tuning is optional. Restore both properties if a
                        // partial update failed and keep encoding the current
                        // camera session. Avoid retrying every incoming frame.
                        _nextRateAttempt=now+5;
                        NSInteger requested=_targetBitrate;
                        _targetBitrate=_configuredBitrate;
                        VTSessionSetProperties(_encoder,(__bridge CFDictionaryRef)[self rateSettings]);
                        _targetBitrate=requested;
                        os_log(OS_LOG_DEFAULT, "BetterComms Meta native: bitrate update rejected (%d); retaining last rate", (int)rateStatus);
                    }
                }
                if (!status) {
                    NSDictionary *options = _forceKeyframe ? @{(id)kVTEncodeFrameOptionKey_ForceKeyFrame:@YES} : nil;
                    status=VTCompressionSessionEncodeFrame(_encoder,pixel,CMSampleBufferGetPresentationTimeStamp(sample),
                        kCMTimeInvalid,(__bridge CFDictionaryRef)options,NULL,NULL);
                    if (!status) _forceKeyframe=NO;
                }
                if (status) [self compressionFailed:status stage:@"encode" now:now];
            }
        }
        UIImage *result=nil;
        if (preview) {
            if (!self.previewContext) self.previewContext=[CIContext contextWithOptions:nil];
            CIImage *image=[[CIImage imageWithCVPixelBuffer:pixel] imageByApplyingTransform:CGAffineTransformMakeScale(0.5,0.5)];
            CGImageRef cg=[self.previewContext createCGImage:image fromRect:image.extent];
            if (cg) { result=[UIImage imageWithCGImage:cg]; CGImageRelease(cg); }
        }
        CVPixelBufferRelease(pixel);
        return result;
    }
}
- (void)close {
    @synchronized(self) {
        _closed=YES;
        if (_encoder) { VTCompressionSessionCompleteFrames(_encoder,kCMTimeInvalid); VTCompressionSessionInvalidate(_encoder); CFRelease(_encoder); _encoder=NULL; }
        if (_decoder) { VTDecompressionSessionInvalidate(_decoder); CFRelease(_decoder); _decoder=NULL; }
        if (_format) { CFRelease(_format); _format=NULL; }
        self.previewContext=nil;
    }
}
- (void)dealloc { [self close]; }
@end
