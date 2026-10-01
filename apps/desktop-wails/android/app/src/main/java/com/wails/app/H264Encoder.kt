package com.wails.app

import android.graphics.ImageFormat
import android.graphics.Rect
import android.graphics.YuvImage
import android.media.Image
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.os.Bundle
import android.view.Surface
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer

/** Bounded, synchronous codec worker. Its owner calls it on a media thread. */
class H264Encoder(private val source: Int, val width: Int, val height: Int, surfaceInput: Boolean, private val sessionId: String = "") : AutoCloseable {
    private val codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
    private var parameters = byteArrayOf()
    private var bitrate = 3_000_000
    private var lastControl = 0L
    private var lastFrame = Long.MIN_VALUE
    val surface: Surface?

    init {
        try {
            val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height)
            format.setInteger(MediaFormat.KEY_COLOR_FORMAT, if (surfaceInput) MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface else MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Flexible)
            format.setInteger(MediaFormat.KEY_BIT_RATE, bitrate)
            format.setInteger(MediaFormat.KEY_FRAME_RATE, 30)
            format.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
            format.setInteger(MediaFormat.KEY_PROFILE, MediaCodecInfo.CodecProfileLevel.AVCProfileBaseline)
            format.setInteger(MediaFormat.KEY_MAX_B_FRAMES, 0)
            // A virtual display sends nothing while the screen is static, so a
            // late viewer or a keyframe request would get no frame to use.
            if (surfaceInput) format.setLong(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, 100_000L)
            codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            surface = if (surfaceInput) codec.createInputSurface() else null
            codec.start()
        } catch (error: Exception) { codec.release(); throw error }
    }
    fun encode(image: Image, micros: Long) {
        if (lastFrame != Long.MIN_VALUE && micros - lastFrame < 33_333) return
        require(image.width == width && image.height == height) { "Glasses changed video dimensions; restart video." }
        val input = codec.dequeueInputBuffer(0)
        if (input < 0) { drain(); return } // Drop instead of accumulating latency.
        val target = codec.getInputImage(input) ?: throw IllegalStateException("H.264 encoder has no YUV input")
        for (plane in 0..2) {
            val src = image.planes[plane]
            val dst = target.planes[plane]
            val w = if (plane == 0) width else width / 2
            val h = if (plane == 0) height else height / 2
            for (row in 0 until h) for (col in 0 until w) {
                dst.buffer.put(row * dst.rowStride + col * dst.pixelStride,
                    src.buffer.get(src.buffer.position() + row * src.rowStride + col * src.pixelStride))
            }
        }
        codec.queueInputBuffer(input, 0, width * height * 3 / 2, micros, 0)
        lastFrame = micros
        drain()
    }
    fun drain() {
        val now = System.nanoTime() / 1_000_000
        if (now - lastControl > 500) {
            val control = BetterCommsNative.encoderControl(source)
            val target = (control and 0xffffffffL).toInt().coerceIn(1_000_000, 8_000_000)
            val settings = Bundle()
            if (target != bitrate) { settings.putInt(MediaCodec.PARAMETER_KEY_VIDEO_BITRATE, target); bitrate = target }
            if ((control ushr 32) != 0L) settings.putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0)
            if (!settings.isEmpty) codec.setParameters(settings)
            lastControl = now
        }
        val info = MediaCodec.BufferInfo()
        while (true) {
            val index = codec.dequeueOutputBuffer(info, 0)
            if (index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                val format = codec.outputFormat
                parameters = listOf("csd-0", "csd-1").mapNotNull { format.getByteBuffer(it) }
                    .fold(byteArrayOf()) { bytes, data -> bytes + AnnexB.normalize(copy(data)) }
                continue
            }
            if (index < 0) return
            try {
                if (info.size <= 0 || info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) continue
                val buffer = codec.getOutputBuffer(index) ?: continue
                buffer.position(info.offset); buffer.limit(info.offset + info.size)
                var bytes = AnnexB.normalize(copy(buffer))
                if (info.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME != 0) bytes = parameters + bytes
                BetterCommsNative.encoded(source, sessionId, bytes, info.presentationTimeUs)
            } finally { codec.releaseOutputBuffer(index, false) }
        }
    }
    override fun close() {
        runCatching { codec.stop() }
        codec.release()
        surface?.release()
    }
    companion object {
        fun copy(buffer: ByteBuffer): ByteArray = ByteArray(buffer.remaining()).also { buffer.duplicate().get(it) }
        fun preview(image: Image): ByteArray {
            val w = image.width; val h = image.height
            val bytes = ByteArray(w * h * 3 / 2)
            for (plane in 0..2) {
                val src = image.planes[plane]
                val pw = if (plane == 0) w else w / 2
                val ph = if (plane == 0) h else h / 2
                for (row in 0 until ph) for (col in 0 until pw) {
                    val out = if (plane == 0) row * w + col else w * h + row * w + col * 2 + if (plane == 1) 1 else 0
                    bytes[out] = src.buffer.get(src.buffer.position() + row * src.rowStride + col * src.pixelStride)
                }
            }
            return ByteArrayOutputStream().use { output ->
                YuvImage(bytes, ImageFormat.NV21, w, h, null).compressToJpeg(Rect(0, 0, w, h), 60, output)
                output.toByteArray()
            }
        }
    }
}
