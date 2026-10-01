package com.wails.app

import android.app.Activity
import android.content.Intent
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Handler
import android.os.Looper
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import kotlinx.coroutines.*
import org.json.JSONObject

/** Full-device/app capture using a fresh Android consent token for every start. */
class AndroidScreenCapture(private val host: BetterCommsAndroidHost, private val activity: AppCompatActivity) {
    private val manager = activity.getSystemService(MediaProjectionManager::class.java)
    private var session: String? = null
    private var pending: String? = null
    private var projection: MediaProjection? = null
    private var display: VirtualDisplay? = null
    private var worker: Job? = null
    private var callback: MediaProjection.Callback? = null
    private val consent = activity.registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val expected = pending
        pending = null
        if (expected == null || session != expected) return@registerForActivityResult
        if (result.resultCode != Activity.RESULT_OK || result.data == null) { stop(); return@registerForActivityResult }
        host.scope.launch {
            try {
                // Wait until the service has actually entered foreground before
                // getMediaProjection; Android 14 enforces this ordering.
                BetterCommsMediaService.projectionReady = false
                host.screenState(true)
                withTimeout(5_000) { while (!BetterCommsMediaService.projectionReady) delay(25) }
                if (session != expected) return@launch
                val capture = checkNotNull(manager.getMediaProjection(result.resultCode, checkNotNull(result.data)))
                projection = capture
                val listener = object : MediaProjection.Callback() {
                    override fun onStop() { stop(expected) }
                }
                callback = listener
                capture.registerCallback(listener, Handler(Looper.getMainLooper()))
                worker = host.scope.launch(Dispatchers.Default) {
                    var encoder: H264Encoder? = null
                    try {
                        encoder = H264Encoder(1, 720, 1280, true, expected)
                        withContext(Dispatchers.Main) {
                            if (session != expected) throw CancellationException()
                            display = capture.createVirtualDisplay("BetterComms share", 720, 1280,
                                activity.resources.displayMetrics.densityDpi, DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                                encoder.surface, null, null)
                        }
                        while (isActive) { encoder.drain(); delay(5) }
                    } catch (cancelled: CancellationException) { throw cancelled }
                    catch (error: Exception) { withContext(Dispatchers.Main) { stop(expected, error.message ?: "Screen encoder stopped.") } }
                    finally { encoder?.close() }
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { stop(expected, error.message ?: "Could not start screen capture.") }
        }
    }
    fun start(id: String) {
        // Android owns the outstanding picker. A cancelled result must not be
        // mistaken for consent for a newer session.
        if (pending != null) {
            BetterCommsNative.screenStopped(id)
            host.emit("bc-android-screen-ended", JSONObject().put("sessionId", id)
                .put("reason", "Close the previous screen-sharing prompt before trying again."))
            return
        }
        if (session != null) return
        session = id
        pending = id
        try { consent.launch(manager.createScreenCaptureIntent()) }
        catch (error: Exception) { stop(id, "Android could not open screen-sharing consent.") }
    }
    fun reportState() {} // The token-gated active-session query reconciles resume/reload.
    fun stop(expected: String? = null, reason: String = "Screen sharing ended.") {
        val id = session ?: return
        if (expected != null && expected != id) return
        session = null
        worker?.cancel(); worker = null
        display?.release(); display = null
        val capture = projection; projection = null
        callback?.let { capture?.unregisterCallback(it) }; callback = null
        capture?.stop()
        host.screenState(false)
        BetterCommsNative.screenStopped(id)
        host.emit("bc-android-screen-ended", JSONObject().put("sessionId", id).put("reason", reason))
    }
}
