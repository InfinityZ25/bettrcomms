package com.wails.app

import androidx.appcompat.app.AppCompatActivity
import org.json.JSONObject

// Older phones can run conversations/calls without loading a higher-API SDK.
class MetaCameraController(private val host: BetterCommsAndroidHost, activity: AppCompatActivity) {
    var publishing = false
    fun connect() = unavailable()
    fun start() = unavailable()
    fun stop() {}
    private fun unavailable() = host.emit("bc-meta-camera", JSONObject().put("kind", "error")
        .put("message", "Glasses video requires the Meta APK and Android 12 or later."))
}
