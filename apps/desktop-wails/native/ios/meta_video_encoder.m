#import "meta_video_encoder.h"
#import <VideoToolbox/VideoToolbox.h>
#import <CoreImage/CoreImage.h>
#import <os/log.h>
extern void bc_meta_video_encoded(void *data, int size);

@interface BCMetaVideoEncoder () {
    VTDecompressionSessionRef _decoder;
    CMFormatDescriptionRef _format;
    VTCompressionSessionRef _encoder;
    BOOL _closed;
    CFAbsoluteTime _statsStarted;
    NSUInteger _frames;
    BOOL _reportedError;
    BOOL _awaitingKeyframe;
    NSUInteger _decodeFailures;
}
@property (nonatomic, strong) CIContext *previewContext;
@end

static void BCEncoded(void *ref, void *source, OSStatus status, VTEncodeInfoFlags flags, CMSampleBufferRef sample) {
    BCMetaVideoEncoder *owner = (__bridge BCMetaVideoEncoder *)ref;
    if (status || !sample) {
        if (status && owner.onError) owner.onError([NSString stringWithFormat:@"Native glasses video encoding failed (%d).", (int)status]);
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
    if (at==size) bc_meta_video_encoded(annex.mutableBytes,(int)annex.length);
}
@implementation BCMetaVideoEncoder
- (void)fail:(OSStatus)status stage:(NSString *)stage {
    if (_reportedError) return;
    _reportedError=YES;
    if (self.onError) self.onError([NSString stringWithFormat:@"Native glasses video %@ failed (%d).",stage,(int)status]);
}
- (UIImage *)process:(CMSampleBufferRef)sample publish:(BOOL)publish preview:(BOOL)preview {
    @synchronized(self) {
        // HEVC delta frames depend on earlier frames. Throttle only preview rendering,
        // never decoding; skipping input here corrupts the next preview/keyframe chain.
        if (_closed) return nil;
        CMFormatDescriptionRef format=CMSampleBufferGetFormatDescription(sample);
        if (!format) return nil;
        CFAbsoluteTime now=CFAbsoluteTimeGetCurrent();
        if (!_statsStarted) _statsStarted=now;
        _frames++;
        if (now-_statsStarted>=5) {
            CMVideoDimensions size=CMVideoFormatDescriptionGetDimensions(CMSampleBufferGetFormatDescription(sample));
            os_log(OS_LOG_DEFAULT, "BetterComms Meta native: input=%dx%d fps=%.1f publishing=%d preview=%d", size.width,size.height,_frames/(now-_statsStarted),publish,preview);
            _statsStarted=now; _frames=0;
        }
        if (!_decoder || !_format || !CMFormatDescriptionEqual(format,_format)) {
            if (_decoder) { VTDecompressionSessionInvalidate(_decoder); CFRelease(_decoder); _decoder=NULL; }
            if (_format) CFRelease(_format);
            _format=(CMFormatDescriptionRef)CFRetain(format);
            _awaitingKeyframe=YES;
            NSDictionary *attributes=@{(id)kCVPixelBufferPixelFormatTypeKey:@(kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)};
            // Software decoding avoids the hardware decoder being invalidated
            // when iOS backgrounds the app. No UI/GPU work in the sending path.
            NSDictionary *spec=@{(id)kVTVideoDecoderSpecification_EnableHardwareAcceleratedVideoDecoder:@NO};
            OSStatus status=VTDecompressionSessionCreate(NULL,format,(__bridge CFDictionaryRef)spec,
                (__bridge CFDictionaryRef)attributes,NULL,&_decoder);
            if (status) { [self fail:status stage:@"decoder setup"]; return nil; }
        }
        CFArrayRef attachments=CMSampleBufferGetSampleAttachmentsArray(sample,false);
        BOOL sync=YES;
        if (attachments && CFArrayGetCount(attachments)) {
            CFDictionaryRef attributes=CFArrayGetValueAtIndex(attachments,0);
            sync=CFDictionaryGetValue(attributes,kCMSampleAttachmentKey_NotSync)!=kCFBooleanTrue;
        }
        if (_awaitingKeyframe && !sync) return nil;
        __block CVPixelBufferRef pixel=NULL;
        OSStatus status=VTDecompressionSessionDecodeFrameWithOutputHandler(_decoder,sample,0,NULL,
            ^(OSStatus result, VTDecodeInfoFlags flags, CVImageBufferRef image, CMTime pts, CMTime duration) {
                if (!result && image) pixel=CVPixelBufferRetain(image);
            });
        if (status || !pixel) {
            _awaitingKeyframe=YES;
            if (++_decodeFailures>=5 && status) [self fail:status stage:@"decode"];
            return nil;
        }
        _awaitingKeyframe=NO; _decodeFailures=0;
        if (publish) {
            if (!_encoder) {
                status=VTCompressionSessionCreate(NULL,(int)CVPixelBufferGetWidth(pixel),(int)CVPixelBufferGetHeight(pixel),
                    kCMVideoCodecType_H264,NULL,NULL,NULL,BCEncoded,(__bridge void *)self,&_encoder);
                if (!status) {
                    NSDictionary *settings=@{(id)kVTCompressionPropertyKey_RealTime:@YES,
                        (id)kVTCompressionPropertyKey_AllowFrameReordering:@NO,
                        (id)kVTCompressionPropertyKey_ProfileLevel:(id)kVTProfileLevel_H264_Baseline_3_1,
                        (id)kVTCompressionPropertyKey_AverageBitRate:@3000000,
                        (id)kVTCompressionPropertyKey_ExpectedFrameRate:@30,
                        (id)kVTCompressionPropertyKey_MaxKeyFrameInterval:@30};
                    status=VTSessionSetProperties(_encoder,(__bridge CFDictionaryRef)settings);
                    if (!status) status=VTCompressionSessionPrepareToEncodeFrames(_encoder);
                }
                if (status) [self fail:status stage:@"encoder setup"];
            }
            if (_encoder && !status) {
                status=VTCompressionSessionEncodeFrame(_encoder,pixel,CMSampleBufferGetPresentationTimeStamp(sample),
                    kCMTimeInvalid,NULL,NULL,NULL);
                if (status) [self fail:status stage:@"encode"];
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
