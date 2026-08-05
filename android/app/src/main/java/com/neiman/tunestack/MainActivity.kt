package com.neiman.tunestack

import android.os.Bundle
import com.getcapacitor.BridgeActivity

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(PlaybackNotificationPlugin::class.java)
        super.onCreate(savedInstanceState)

        // Require a deliberate tap in Tunestack before audio can start.
        bridge.webView.settings.mediaPlaybackRequiresUserGesture = true
    }
}
