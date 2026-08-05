package com.neiman.tunestack

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import androidx.core.content.ContextCompat
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback

@CapacitorPlugin(
    name = "PlaybackNotification",
    permissions = [Permission(alias = "notifications", strings = [Manifest.permission.POST_NOTIFICATIONS])]
)
class PlaybackNotificationPlugin : Plugin() {
    private val commandReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            notifyListeners("command", JSObject().put("command", intent?.getStringExtra("command") ?: return))
        }
    }

    override fun load() {
        ContextCompat.registerReceiver(context, commandReceiver, IntentFilter(PlaybackService.ACTION_COMMAND), ContextCompat.RECEIVER_NOT_EXPORTED)
    }

    override fun handleOnDestroy() {
        try { context.unregisterReceiver(commandReceiver) } catch (_: IllegalArgumentException) { }
        super.handleOnDestroy()
    }

    @PluginMethod
    fun requestPermission(call: PluginCall) {
        if (Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED) {
            call.resolve(JSObject().put("granted", true))
            return
        }
        requestPermissionForAlias("notifications", call, "permissionRequestResult")
    }

    @PermissionCallback
    private fun permissionRequestResult(call: PluginCall) {
        call.resolve(JSObject().put("granted", getPermissionState("notifications") == PermissionState.GRANTED))
    }

    @PluginMethod
    fun update(call: PluginCall) {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            call.resolve()
            return
        }
        val intent = Intent(context, PlaybackService::class.java).apply {
            action = PlaybackService.ACTION_UPDATE
            putExtra("title", call.getString("title", "Melodock"))
            putExtra("artist", call.getString("artist", "Unknown artist"))
            putExtra("album", call.getString("album", ""))
            putExtra("playing", call.getBoolean("playing", false) ?: false)
        }
        ContextCompat.startForegroundService(context, intent)
        call.resolve(JSObject())
    }

    @PluginMethod
    fun clear(call: PluginCall) {
        context.stopService(Intent(context, PlaybackService::class.java))
        call.resolve()
    }
}
