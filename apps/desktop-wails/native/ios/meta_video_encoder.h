#import <Foundation/Foundation.h>
#import <CoreMedia/CoreMedia.h>
#import <UIKit/UIKit.h>
@interface BCMetaVideoEncoder : NSObject
// A serialized native decode/encode path. The image is for foreground preview only.
- (UIImage *)process:(CMSampleBufferRef)sample publish:(BOOL)publish preview:(BOOL)preview;
- (void)configureBitrate:(NSInteger)bitrate forceKeyframe:(BOOL)force;
- (void)close;
@property (nonatomic, copy) void (^onError)(NSString *message);
@end
