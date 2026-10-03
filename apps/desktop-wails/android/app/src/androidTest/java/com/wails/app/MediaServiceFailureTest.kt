package com.wails.app

import android.content.ComponentName
import android.content.ContextWrapper
import android.content.Intent
import android.content.pm.ServiceInfo
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test

class MediaServiceFailureTest {
    @Test fun rejectedBackgroundServiceStartReportsFailureInsteadOfCrashing() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = object : ContextWrapper(instrumentation.targetContext) {
            override fun startForegroundService(service: Intent): ComponentName? {
                throw SecurityException("Test-only background restriction")
            }
        }
        instrumentation.runOnMainSync {
            val previous = BetterCommsMediaService.onFailure
            var failures = 0
            try {
                BetterCommsMediaService.onFailure = { failures++ }
                BetterCommsMediaService.projectionReady = true
                BetterCommsMediaService.update(context, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
                assertEquals(1, failures)
                assertFalse(BetterCommsMediaService.projectionReady)
                // Rejection must not poison the next attempt either.
                BetterCommsMediaService.update(context, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
                assertEquals(2, failures)
            } finally { BetterCommsMediaService.onFailure = previous }
        }
    }
}
