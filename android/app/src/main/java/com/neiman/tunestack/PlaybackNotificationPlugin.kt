package com.neiman.tunestack

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import com.getcapacitor.PluginMethod

@CapacitorPlugin(
    name = "PlaybackNotification",
    permissions = [Permission(alias = "notifications", strings = [Manifest.permission.POST_NOTIFICATIONS])]
)
class PlaybackNotificationPlugin : Plugin() {
    private val channelId = "tunestack_playback"
    private val notificationId = 2401

    @PluginMethod
    fun update(call: PluginCall) {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "notificationPermissionResult")
            return
        }
        show(call)
    }

    @PermissionCallback
    private fun notificationPermissionResult(call: PluginCall) {
        if (getPermissionState("notifications") == PermissionState.GRANTED) show(call) else call.resolve()
    }

    private fun show(call: PluginCall) {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26) {
            manager.createNotificationChannel(NotificationChannel(channelId, "Now playing", NotificationManager.IMPORTANCE_LOW))
        }
        val launchIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)
            ?: Intent(context, MainActivity::class.java)
        val pendingIntent = PendingIntent.getActivity(context, 0, launchIntent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val playing = call.getBoolean("playing", false) ?: false
        val notification = NotificationCompat.Builder(context, channelId)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(call.getString("title", "TuneStack"))
            .setContentText(call.getString("artist", "Unknown artist"))
            .setSubText(call.getString("album", ""))
            .setContentIntent(pendingIntent)
            .setOngoing(playing)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .build()
        NotificationManagerCompat.from(context).notify(notificationId, notification)
        call.resolve(JSObject())
    }

    @PluginMethod
    fun clear(call: PluginCall) {
        NotificationManagerCompat.from(context).cancel(notificationId)
        call.resolve()
    }
}
