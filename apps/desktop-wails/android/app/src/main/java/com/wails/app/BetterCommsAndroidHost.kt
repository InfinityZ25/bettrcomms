package com.wails.app

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.graphics.Color
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.view.View
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceResponse
import android.webkit.WebView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.activity.OnBackPressedCallback
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject
import java.io.ByteArrayInputStream
import kotlin.coroutines.resume

/** Android policy and lifecycle; media pixels never go through a JS interface. */
class BetterCommsAndroidHost(private val activity: AppCompatActivity) {
    private val handler = Handler(Looper.getMainLooper())
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var webView: WebView? = null
    private var destroyed = false
    private val permissionMutex = Mutex()
    private var permissionWaiter: CancellableContinuation<Boolean>? = null
    private var permissionPending = false
    private val permissions = activity.registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
        permissionWaiter?.let { if (it.isActive) it.resume(result.values.all { value -> value }) }
        permissionWaiter = null
        permissionPending = false
    }
    private val audio = activity.getSystemService(AudioManager::class.java)
    private var audioFocus: AudioFocusRequest? = null
    private var previousAudioMode: Int? = null
    private var callActive = false
    private var metaActive = false
    private var screenActive = false
    private val meta = MetaCameraController(this, activity)
    private val screen = AndroidScreenCapture(this, activity)

    init {
        BetterCommsNative.attach(this, activity.filesDir.absolutePath)
        activity.onBackPressedDispatcher.addCallback(activity, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() { back() }
        })
    }

    fun configure(view: WebView, bridge: WailsBridge) {
        webView = view
        view.overScrollMode = View.OVER_SCROLL_NEVER
        view.setBackgroundColor(Color.rgb(28, 25, 23))
        view.settings.setSupportZoom(false)
        view.settings.builtInZoomControls = false
        view.settings.displayZoomControls = false
        view.settings.allowFileAccess = false
        view.settings.allowContentAccess = false
        view.settings.javaScriptCanOpenWindowsAutomatically = false
        view.settings.setSupportMultipleWindows(false)
        view.webChromeClient = object : WebChromeClient() {
            private val cancelled = mutableSetOf<PermissionRequest>()
            override fun onPermissionRequest(request: PermissionRequest) {
                if (!TrustedPage.packaged(request.origin.toString()) || request.resources.any {
                    it != PermissionRequest.RESOURCE_AUDIO_CAPTURE && it != PermissionRequest.RESOURCE_VIDEO_CAPTURE
                }) { request.deny(); return }
                scope.launch {
                    val needed = request.resources.map {
                        if (it == PermissionRequest.RESOURCE_AUDIO_CAPTURE) Manifest.permission.RECORD_AUDIO else Manifest.permission.CAMERA
                    }.toTypedArray()
                    val allowed = requestPermissions(needed)
                    if (cancelled.remove(request)) return@launch
                    if (allowed && !destroyed && TrustedPage.packaged(view.url ?: "")) {
                        request.grant(request.resources)
                        updateService()
                    } else request.deny()
                }
            }
            override fun onPermissionRequestCanceled(request: PermissionRequest) { cancelled.add(request) }
        }
        // Android owns system-bar/keyboard insets. The WebView viewport already
        // excludes them, so CSS env() must not reserve a second copy.
        WindowCompat.setDecorFitsSystemWindows(activity.window, false)
        WindowCompat.getInsetsController(activity.window, view).apply {
            isAppearanceLightStatusBars = false
            isAppearanceLightNavigationBars = false
        }
        val container = activity.findViewById<View>(R.id.main_container)
        container.setBackgroundColor(Color.rgb(28, 25, 23))
        ViewCompat.setOnApplyWindowInsetsListener(container) { target, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime())
            target.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, keyboard.bottom))
            insets
        }
        ViewCompat.requestApplyInsets(container)
    }
    fun onPageFinished() { screen.reportState() }
    fun allowResource(uri: Uri): Boolean = TrustedPage.resource(uri.toString())
    fun blockedResponse() = WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", emptyMap(), ByteArrayInputStream(byteArrayOf()))
    fun navigate(uri: Uri, mainFrame: Boolean): Boolean {
        if (TrustedPage.packaged(uri.toString())) return false
        if (mainFrame && uri.scheme == "https") {
            runCatching { activity.startActivity(Intent(Intent.ACTION_VIEW, uri)) }
        }
        return true
    }
    suspend fun requestPermissions(values: Array<String>): Boolean = permissionMutex.withLock {
        val missing = values.filter { ContextCompat.checkSelfPermission(activity, it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isEmpty()) return@withLock true
        // A cancelled coroutine does not dismiss Android's permission dialog.
        // Never let its eventual result authorize a newer request.
        if (permissionPending) return@withLock false
        suspendCancellableCoroutine { continuation ->
            permissionPending = true
            permissionWaiter = continuation
            continuation.invokeOnCancellation { permissionWaiter = null }
            permissions.launch(missing.toTypedArray())
        }
    }
    // JNI calls this from Go threads. UI-affecting actions are serialized here.
    fun command(value: String): String {
        if (destroyed) return "Android host has stopped"
        if (value == "meta:available") return if (BuildConfig.META_CAMERA_SUPPORTED) "" else "Meta SDK is not included in this build"
        handler.post {
            if (destroyed) return@post
            when {
                value == "meta:connect" -> meta.connect()
                value == "meta:start" -> meta.start()
                value == "meta:stop" -> meta.stop()
                value == "meta:publishing" -> meta.publishing = true
                value == "meta:preview" -> meta.publishing = false
                value == "audio:start" -> startAudio()
                value == "audio:stop" -> stopAudio()
                value.startsWith("screen:start:") -> screen.start(value.removePrefix("screen:start:"))
                value.startsWith("screen:stop:") -> screen.stop(value.removePrefix("screen:stop:"))
            }
        }
        return ""
    }
    fun emit(name: String, detail: JSONObject) {
        val script = "window.dispatchEvent(new CustomEvent(${JSONObject.quote(name)}, {detail:$detail}));"
        handler.post { webView?.let { if (!destroyed && TrustedPage.packaged(it.url ?: "")) it.evaluateJavascript(script, null) } }
    }
    fun metaState(active: Boolean) { metaActive = active; updateService() }
    fun screenState(active: Boolean) { screenActive = active; updateService() }
    private fun updateService() {
        if (destroyed) return
        var types = 0
        if (metaActive) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
        if (screenActive) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
        if (callActive && ContextCompat.checkSelfPermission(activity, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED)
            types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        BetterCommsMediaService.update(activity, types)
    }
    private fun startAudio() {
        if (callActive) return
        callActive = true
        previousAudioMode = audio.mode
        audio.mode = AudioManager.MODE_IN_COMMUNICATION
        val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
            .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            .setOnAudioFocusChangeListener { /* The OS may duck playback for higher priority calls. */ }.build()
        audioFocus = request
        audio.requestAudioFocus(request)
        updateService()
    }
    private fun stopAudio() {
        callActive = false
        audioFocus?.let { audio.abandonAudioFocusRequest(it) }
        audioFocus = null
        previousAudioMode?.let { audio.mode = it }
        previousAudioMode = null
        updateService()
    }
    fun back() {
        val view = webView
        if (view?.canGoBack() == true) view.goBack() else activity.moveTaskToBack(true)
    }
    fun destroy() {
        if (destroyed) return
        meta.stop()
        screen.stop()
        stopAudio()
        destroyed = true
        scope.cancel()
        BetterCommsMediaService.update(activity, 0)
        BetterCommsNative.detach()
        webView = null
    }
}
