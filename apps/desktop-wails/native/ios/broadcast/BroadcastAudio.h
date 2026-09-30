#import <AVFoundation/AVFoundation.h>
@interface BCBroadcastAudio : NSObject
- (BOOL)process:(CMSampleBufferRef)sample;
- (void)reset;
@end
