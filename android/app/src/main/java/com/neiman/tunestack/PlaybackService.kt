package com.neiman.tunestack

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.media.app.NotificationCompat.MediaStyle
import android.support.v4.media.session.MediaSessionCompat

class PlaybackService : Service() {
    companion object {
        const val CHANNEL_ID = "melodock_playback_v2"
        const val NOTIFICATION_ID = 2401
        const val ACTION_UPDATE = "com.neiman.melodock.UPDATE_PLAYBACK"
        const val ACTION_STOP_SERVICE = "com.neiman.melodock.STOP_PLAYBACK"
        const val ACTION_COMMAND = "com.neiman.melodock.PLAYBACK_COMMAND"
    }

    private lateinit var mediaSession: MediaSessionCompat

    override fun onCreate() {
        super.onCreate()
        mediaSession = MediaSessionCompat(this, "MelodockPlayback").apply { isActive = true }
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Now playing", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Playback controls and current track"
                setShowBadge(false)
            }
        )
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP_SERVICE) {
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }
        val title = intent?.getStringExtra("title") ?: "Melodock"
        val artist = intent?.getStringExtra("artist") ?: "Unknown artist"
        val album = intent?.getStringExtra("album") ?: ""
        val playing = intent?.getBooleanExtra("playing", false) ?: false
        startForeground(NOTIFICATION_ID, buildNotification(title, artist, album, playing))
        return START_STICKY
    }

    private fun commandPendingIntent(command: String, requestCode: Int): PendingIntent {
        val intent = Intent(ACTION_COMMAND).setPackage(packageName).putExtra("command", command)
        return PendingIntent.getBroadcast(this, requestCode, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    private fun buildNotification(title: String, artist: String, album: String, playing: Boolean) =
        NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(artist)
            .setSubText(album)
            .setContentIntent(PendingIntent.getActivity(this, 10, packageManager.getLaunchIntentForPackage(packageName) ?: Intent(this, MainActivity::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
            .setDeleteIntent(commandPendingIntent("stop", 14))
            .addAction(android.R.drawable.ic_media_previous, "Previous", commandPendingIntent("previous", 11))
            .addAction(if (playing) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play, if (playing) "Pause" else "Play", commandPendingIntent(if (playing) "pause" else "play", 12))
            .addAction(android.R.drawable.ic_media_next, "Next", commandPendingIntent("next", 13))
            .setStyle(MediaStyle().setMediaSession(mediaSession.sessionToken).setShowActionsInCompactView(0, 1, 2))
            .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setOngoing(playing)
            .build()

    override fun onDestroy() { mediaSession.release(); super.onDestroy() }
    override fun onBind(intent: Intent?): IBinder? = null
}
