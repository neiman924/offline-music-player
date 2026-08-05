package com.neiman.tunestack

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

@CapacitorPlugin(name = "ShazamIdentifier")
class ShazamIdentifierUnavailablePlugin : Plugin() {
    @PluginMethod
    fun getStatus(call: PluginCall) {
        call.resolve(JSObject().apply {
            put("available", false)
            put("configured", false)
            put("platform", "android")
            put(
                "message",
                "Native Shazam identification is not included in this APK. The player and saved metadata continue to work normally.",
            )
        })
    }

    @PluginMethod
    fun identify(call: PluginCall) {
        call.reject("Native Shazam identification is not configured in this APK.")
    }
}
