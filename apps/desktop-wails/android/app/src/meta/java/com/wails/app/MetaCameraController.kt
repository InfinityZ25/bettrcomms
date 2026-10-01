package com.wails.app

import androidx.activity.result.contract.ActivityResultContracts
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlin.coroutines.resume
import android.Manifest
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.util.Base64
import androidx.appcompat.app.AppCompatActivity
import com.meta.wearable.dat.camera.Camera
import com.meta.wearable.dat.camera.addCamera
import com.meta.wearable.dat.camera.types.StreamConfiguration
import com.meta.wearable.dat.camera.types.VideoFrame
import com.meta.wearable.dat.camera.types.VideoQuality
import com.meta.wearable.dat.camera.types.StreamError
import com.meta.wearable.dat.camera.types.StreamState
import com.meta.wearable.dat.core.Wearables
import com.meta.wearable.dat.core.selectors.AutoDeviceSelector
import com.meta.wearable.dat.core.session.DeviceSession
import com.meta.wearable.dat.core.session.DeviceSessionState
import com.meta.wearable.dat.core.types.Permission
import com.meta.wearable.dat.core.types.PermissionStatus
import com.meta.wearable.dat.core.types.RegistrationState
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.buffer
import kotlinx.coroutines.flow.map
import org.json.JSONObject

/** A single DAT lease shared by preview and publishing, with bounded startup. */
class MetaCameraController(private val host: BetterCommsAndroidHost, private val activity: AppCompatActivity) {
    private var permissionWaiter: CancellableContinuation<PermissionStatus>? = null
    private var permissionPending = false
    private val permissionMutex = Mutex()
    private val permissionLauncher = activity.registerForActivityResult(Wearables.RequestPermissionContract()) { result ->
        permissionWaiter?.let { if (it.isActive) it.resume(result.getOrDefault(PermissionStatus.Denied)) }
        permissionWaiter = null
        permissionPending = false
    }
    private suspend fun requestCameraPermission(): PermissionStatus = permissionMutex.withLock {
        check(!permissionPending) { "Finish the previous permission prompt in Meta AI before trying again." }
        suspendCancellableCoroutine { continuation ->
            permissionPending = true
            permissionWaiter = continuation
            continuation.invokeOnCancellation { permissionWaiter = null }
            permissionLauncher.launch(Permission.CAMERA)
        }
    }
    private var task: Job? = null
    private var session: DeviceSession? = null
    private var camera: Camera? = null
    @Volatile var publishing = false
    private fun event(kind: String, message: String? = null) {
        val data = JSONObject().put("kind", kind)
        if (message != null) data.put("message", message)
        host.emit("bc-meta-camera", data)
    }
    private suspend fun register() {
        check(host.requestPermissions(arrayOf(Manifest.permission.BLUETOOTH_CONNECT))) { "Bluetooth permission is required for glasses." }
        Wearables.initialize(activity).onFailure { error, _ -> throw IllegalStateException(error.description) }
        if (Wearables.registrationState.value != RegistrationState.REGISTERED) {
            event("connecting")
            Wearables.startRegistration(activity)
            withTimeout(5 * 60_000L) { Wearables.registrationState.first { it == RegistrationState.REGISTERED } }
        }
        event("registered")
    }
    fun connect() {
        if (task != null) return
        task = host.scope.launch(start = CoroutineStart.LAZY) {
            try { register() }
            catch (timeout: TimeoutCancellationException) { event("error", "Meta camera connection timed out. Check the glasses link in Meta AI, then try again.") }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { event("error", error.message ?: "Meta registration failed.") }
            finally { task = null }
        }
        task?.start()
    }
    fun start() {
        if (task != null) return
        task = host.scope.launch(start = CoroutineStart.LAZY) {
            try {
                register()
                val selector = AutoDeviceSelector()
                event("waitingForDevice")
                withTimeout(60_000) { selector.activeDeviceFlow().first { it != null } }
                Wearables.createSession(selector).onSuccess { session = it }
                    .onFailure { error, _ -> throw IllegalStateException(error.description) }
                val current = checkNotNull(session)
                current.start()
                withTimeout(45_000) { current.state.first { it == DeviceSessionState.STARTED || it == DeviceSessionState.STOPPED } }
                check(current.state.value == DeviceSessionState.STARTED) { "Glasses session ended before becoming ready." }
                val status = Wearables.checkPermissionStatus(Permission.CAMERA).getOrDefault(PermissionStatus.Denied)
                if (status != PermissionStatus.Granted) {
                    event("connecting")
                    check(withTimeout(2 * 60_000L) { requestCameraPermission() } == PermissionStatus.Granted) { "Meta camera permission was denied." }
                }
                event("starting")
                host.metaState(true)
                current.addCamera(StreamConfiguration(videoQuality = VideoQuality.HIGH, frameRate = 30, compressVideo = true))
                    .onSuccess { camera = it }.onFailure { error, _ -> throw IllegalStateException(error.description) }
                val stream = checkNotNull(camera).stream
                coroutineScope {
                    launch { current.errors.collect { error -> throw IllegalStateException(error.description) } }
                    launch { current.state.first { it == DeviceSessionState.STOPPED }; throw IllegalStateException("Glasses disconnected.") }
                    // Each retained item is a copied access unit. Never hold SDK
                    // buffers across suspension or queue seconds of stale video.
                    launch { stream.errorStream.collect { error ->
                        if (error != StreamError.STREAM_ERROR) throw IllegalStateException(error.description)
                    } }
                    val frames = launch(Dispatchers.Default) {
                        var decoder: GlassesDecoder? = null
                        try {
                            stream.videoStream.map { it.copy(buffer = java.nio.ByteBuffer.wrap(H264Encoder.copy(it.buffer))) }.buffer(8).collect { frame ->
                                if (decoder == null) decoder = GlassesDecoder(frame.width, frame.height)
                                decoder!!.frame(frame)
                            }
                        } finally { decoder?.close() }
                    }
                    stream.start().onFailure { error, _ -> throw IllegalStateException(error.description) }
                    withTimeout(45_000) { stream.state.first { it == StreamState.STREAMING } }
                    event("streaming")
                    stream.state.first { it == StreamState.STOPPED || it == StreamState.CLOSED }
                    frames.cancelAndJoin()
                    throw IllegalStateException("Glasses camera session ended.")
                }
            } catch (timeout: TimeoutCancellationException) { event("error", "Meta camera connection timed out. Check the glasses link in Meta AI, then try again.") }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { event("error", error.message ?: "Could not open the glasses camera link.") }
            finally {
                withContext(NonCancellable) {
                    try { camera?.stop() }
                    finally {
                        camera = null
                        try { session?.stop() }
                        finally {
                            session = null
                            publishing = false
                            host.metaState(false)
                            BetterCommsNative.stopped(0)
                            task = null
                            event("stopped")
                        }
                    }
                }
            }
        }
        task?.start()
    }
    fun stop() { task?.cancel() }

    // Decode the SDK's compressed HEVC to explicit Image planes, then encode
    // browser-compatible AVC. This avoids assuming a vendor's raw YUV layout.
    private inner class GlassesDecoder(private val width: Int, private val height: Int) : AutoCloseable {
        private val decoder = MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_VIDEO_HEVC)
        private var encoder: H264Encoder? = null
        private var previewAt = 0L
        init {
            try {
                val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_HEVC, width, height)
                format.setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Flexible)
                decoder.configure(format, null, null, 0)
                decoder.start()
            } catch (error: Exception) { decoder.release(); throw error }
        }
        fun frame(frame: VideoFrame) {
            check(frame.isCompressed) { "Unsupported glasses frame format." }
            val input = decoder.dequeueInputBuffer(10_000)
            check(input >= 0) { "Glasses decoder could not keep up. Restart video." }
            if (input >= 0) {
                val buffer = checkNotNull(decoder.getInputBuffer(input))
                val bytes = H264Encoder.copy(frame.buffer)
                check(bytes.size <= buffer.capacity()) { "Glasses frame exceeds decoder buffer." }
                buffer.clear(); buffer.put(bytes)
                decoder.queueInputBuffer(input, 0, bytes.size, frame.presentationTimeUs,
                    if (frame.isCodecConfig) MediaCodec.BUFFER_FLAG_CODEC_CONFIG else 0)
            }
            val info = MediaCodec.BufferInfo()
            while (true) {
                val output = decoder.dequeueOutputBuffer(info, 0)
                if (output == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) continue
                if (output < 0) break
                try {
                    checkNotNull(decoder.getOutputImage(output)) { "This phone's glasses decoder does not expose video frames." }.use { image ->
                        if (publishing) {
                            if (encoder == null) encoder = H264Encoder(0, image.width, image.height, false)
                            encoder!!.encode(image, info.presentationTimeUs)
                        }
                        val now = System.nanoTime() / 1_000_000
                        if (now - previewAt >= 125) {
                            previewAt = now
                            host.emit("bc-meta-camera", JSONObject().put("kind", "frame").put("width", image.width).put("height", image.height)
                                .put("jpeg", Base64.encodeToString(H264Encoder.preview(image), Base64.NO_WRAP)))
                        }
                    }
                } finally { decoder.releaseOutputBuffer(output, false) }
            }
        }
        override fun close() { encoder?.close(); runCatching { decoder.stop() }; decoder.release() }
    }
}
