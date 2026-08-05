package com.neiman.tunestack
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
@CapacitorPlugin(name = "AppEdition")
class AppEditionPlugin : Plugin() {
    @PluginMethod fun getEdition(call: PluginCall) {
        call.resolve(JSObject().put("edition", if (BuildConfig.PRO_EDITION) "pro" else "free"))
    }
}
