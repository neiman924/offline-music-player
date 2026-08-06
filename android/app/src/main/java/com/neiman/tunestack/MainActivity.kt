package com.neiman.tunestack
import android.os.Bundle
import com.getcapacitor.BridgeActivity
class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(PlaybackNotificationPlugin::class.java)
        registerPlugin(AppEditionPlugin::class.java)
        registerPlugin(LocalFolderPlugin::class.java)
        super.onCreate(savedInstanceState)
        bridge.webView.settings.mediaPlaybackRequiresUserGesture = true
    }
}
