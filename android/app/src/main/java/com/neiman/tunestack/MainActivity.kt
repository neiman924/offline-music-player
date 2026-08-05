package com.neiman.tunestack

import android.os.Bundle
import com.getcapacitor.BridgeActivity
import com.getcapacitor.Plugin

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(PlaybackNotificationPlugin::class.java)
        val shazamPluginClassName = if (BuildConfig.SHAZAMKIT_AVAILABLE) {
            "com.neiman.tunestack.ShazamIdentifierNativePlugin"
        } else {
            "com.neiman.tunestack.ShazamIdentifierUnavailablePlugin"
        }
        val shazamPluginClass = Class.forName(shazamPluginClassName).asSubclass(Plugin::class.java)
        registerPlugin(shazamPluginClass)
        super.onCreate(savedInstanceState)

        // Require a deliberate tap in Tunestack before audio can start.
        bridge.webView.settings.mediaPlaybackRequiresUserGesture = true
    }
}
