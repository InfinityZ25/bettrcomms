package com.wails.app

import android.app.*
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/** User-visible, correctly typed lifetime for native capture and call audio. */
class BetterCommsMediaService : Service() {
    private var currentTypes = 0
    private var lastStartId = 0
    private var wakeLock: PowerManager.WakeLock? = null
    override fun onBind(intent: Intent?) = null
    override fun onCreate() { super.onCreate(); running = this }
    override fun onStartCommand(intent: Intent?, flags: Int, id: Int): Int {
        // Multiple queued starts must use the latest desired state, including
        // cancellation before Android delivered the first start command.
        lastStartId = id
        running = this
        applyTypes(requestedTypes)
        return START_NOT_STICKY // Never resurrect capture after process death.
    }
    private fun applyTypes(types: Int) {
        if (types == 0) { finish(); return }
        if (types == currentTypes) return
        try {
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(NotificationChannel("call", "Active calls and sharing", NotificationManager.IMPORTANCE_LOW))
            val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
            val notification = NotificationCompat.Builder(this, "call")
                .setSmallIcon(android.R.drawable.presence_video_online).setContentTitle("BetterComms")
                .setContentText("Call or sharing is active — tap to return")
                .setOngoing(true).setContentIntent(open).setCategory(Notification.CATEGORY_CALL).build()
            if (Build.VERSION.SDK_INT >= 29) startForeground(1701, notification, types)
            else startForeground(1701, notification)
            if (wakeLock == null) wakeLock = getSystemService(PowerManager::class.java)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "BetterComms:active-media").apply { setReferenceCounted(false) }
            if (wakeLock?.isHeld == false) wakeLock?.acquire()
            currentTypes = types
            projectionReady = types and ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION != 0
        } catch (error: RuntimeException) {
            // Includes background-start/type permission restrictions on 12+.
            // Do not leave capture running without its required notification.
            requestedTypes = 0
            finish()
            onFailure?.invoke()
        }
    }
    private fun finish() {
        currentTypes = 0
        projectionReady = false
        releaseWakeLock()
        runCatching { stopForeground(STOP_FOREGROUND_REMOVE) }
        runCatching { stopSelf(lastStartId) }
        if (running === this) running = null
    }
    companion object {
        @Volatile var projectionReady = false
        // All service/lifecycle transitions run on Android's main looper.
        private var running: BetterCommsMediaService? = null
        private var requestedTypes = 0
        var onFailure: (() -> Unit)? = null
        fun update(context: Context, types: Int) {
            requestedTypes = types
            try {
                val service = running
                if (service != null) { service.applyTypes(types); return }
                val intent = Intent(context, BetterCommsMediaService::class.java)
                if (types == 0) { projectionReady = false; context.stopService(intent) }
                else ContextCompat.startForegroundService(context, intent)
            } catch (error: RuntimeException) {
                requestedTypes = 0
                projectionReady = false
                onFailure?.invoke()
            }
        }
    }
    private fun releaseWakeLock() {
        val lock = wakeLock; wakeLock = null
        runCatching { if (lock?.isHeld == true) lock.release() }
    }
    override fun onDestroy() {
        val unexpected = currentTypes != 0 && running === this
        if (running === this) { running = null; projectionReady = false }
        releaseWakeLock()
        super.onDestroy()
        if (unexpected) { requestedTypes = 0; onFailure?.invoke() }
    }
}
