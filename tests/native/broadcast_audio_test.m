#import <AVFoundation/AVFoundation.h>
#import "BroadcastAudio.h"
#import <opus/opus.h>
static int packets=0;static double energy=0;static OpusDecoder *decoder;
void bc_broadcast_audio(void *data,int size,long long pts) {
 float pcm[960*2];int n=opus_decode_float(decoder,data,size,pcm,960,0);
 if(n!=960) abort();for(int i=0;i<n*2;i++)energy+=pcm[i]*pcm[i];packets++;
}
int main() { @autoreleasepool {
 int error;decoder=opus_decoder_create(48000,2,&error);BCBroadcastAudio *audio=[BCBroadcastAudio new];
 for(int sampleRateIndex=0;sampleRateIndex<2;sampleRateIndex++) {
 int rate=sampleRateIndex?44100:48000;int count=rate/50;
 AudioStreamBasicDescription asbd={.mSampleRate=rate,.mFormatID=kAudioFormatLinearPCM,.mFormatFlags=kAudioFormatFlagsNativeFloatPacked,.mBytesPerPacket=8,.mFramesPerPacket=1,.mBytesPerFrame=8,.mChannelsPerFrame=2,.mBitsPerChannel=32};
 CMAudioFormatDescriptionRef format=NULL;CMAudioFormatDescriptionCreate(NULL,&asbd,0,NULL,0,NULL,NULL,&format);
 for(int frame=0;frame<50;frame++) {
 CMBlockBufferRef block=NULL;CMBlockBufferCreateWithMemoryBlock(NULL,NULL,count*8,NULL,NULL,0,count*8,0,&block);
 float pcm[count*2];for(int i=0;i<count;i++) pcm[i*2]=pcm[i*2+1]=0.25*sin(2*M_PI*440*(i+frame*count)/rate);
 CMBlockBufferReplaceDataBytes(pcm,block,0,sizeof(pcm));
 CMSampleTimingInfo timing={CMTimeMake(1,rate),CMTimeMake((sampleRateIndex*50+frame)*count,rate),kCMTimeInvalid};
 CMSampleBufferRef sample=NULL;CMSampleBufferCreateReady(NULL,block,format,count,1,&timing,0,NULL,&sample);
 if(![audio process:sample]) { fprintf(stderr,"conversion failed at %d/%d\n",rate,frame);return 1; }
 CFRelease(sample);CFRelease(block);
 }
 CFRelease(format);
 }
 [audio reset];opus_decoder_destroy(decoder);
 printf("Decoded %d Opus packets, RMS %.3f\n",packets,sqrt(energy/(packets*960*2)));
 return packets>=95 && energy>1?0:1;
} }
