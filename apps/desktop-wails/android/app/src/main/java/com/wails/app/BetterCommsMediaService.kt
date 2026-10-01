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
    private var wakeLock: PowerManager.WakeLock? = null
    override fun onBind(intent: Intent?) = null
    override fun onStartCommand(intent: Intent?, flags: Int, id: Int): Int {
        val types = intent?.getIntExtra("types", 0) ?: 0
        if (types == 0) { releaseWakeLock(); stopForeground(STOP_FOREGROUND_REMOVE); stopSelf(); return START_NOT_STICKY }
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
        projectionReady = types and ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION != 0
        return START_NOT_STICKY // Never resurrect a user's capture after process death.
    }
    companion object {
        @Volatile var projectionReady = false
        fun update(context: Context, types: Int) {
            val intent = Intent(context, BetterCommsMediaService::class.java).putExtra("types", types)
            if (types == 0) { projectionReady = false; context.stopService(intent) } else ContextCompat.startForegroundService(context, intent)
        }
    }
    private fun releaseWakeLock() { wakeLock?.let { if (it.isHeld) it.release() }; wakeLock = null }
    override fun onDestroy() { projectionReady = false; releaseWakeLock(); super.onDestroy() }
}
