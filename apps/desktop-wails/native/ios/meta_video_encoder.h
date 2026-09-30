#import <Foundation/Foundation.h>
#import <CoreMedia/CoreMedia.h>
#import <UIKit/UIKit.h>
// Fixed media counters and status only; never credentials, SDP or frame data.
void BCNativeVideoLog(NSString *message);
@interface BCMetaVideoEncoder : NSObject
// A serialized native decode/encode path. The image is for foreground preview only.
- (UIImage *)process:(CMSampleBufferRef)sample publish:(BOOL)publish preview:(BOOL)preview;
- (void)configureBitrate:(NSInteger)bitrate forceKeyframe:(BOOL)force;
- (void)appForegroundChanged:(BOOL)foreground;
- (void)close;
@property (nonatomic, copy) void (^onError)(NSString *message);
@end
