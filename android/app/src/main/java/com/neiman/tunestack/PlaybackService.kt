package com.neiman.tunestack

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import androidx.core.app.NotificationCompat
import androidx.media.app.NotificationCompat.MediaStyle

class PlaybackService : Service() {
    companion object {
        const val CHANNEL_ID = "melodock_playback_v3"
        const val NOTIFICATION_ID = 2401
        const val ACTION_UPDATE = "com.neiman.melodock.UPDATE_PLAYBACK"
        const val ACTION_STOP_SERVICE = "com.neiman.melodock.STOP_PLAYBACK"
        const val ACTION_COMMAND = "com.neiman.melodock.PLAYBACK_COMMAND"

        private const val SUPPORTED_ACTIONS =
            PlaybackStateCompat.ACTION_PLAY or
            PlaybackStateCompat.ACTION_PAUSE or
            PlaybackStateCompat.ACTION_PLAY_PAUSE or
            PlaybackStateCompat.ACTION_SKIP_TO_NEXT or
            PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS or
            PlaybackStateCompat.ACTION_STOP
    }

    private lateinit var mediaSession: MediaSessionCompat
    private var title = "Melodock"
    private var artist = "Unknown artist"
    private var album = ""
    private var playing = false
    private var hasTrack = false

    override fun onCreate() {
        super.onCreate()
        mediaSession = MediaSessionCompat(this, "MelodockPlayback").apply {
            setFlags(
                MediaSessionCompat.FLAG_HANDLES_MEDIA_BUTTONS or
                    MediaSessionCompat.FLAG_HANDLES_TRANSPORT_CONTROLS
            )
            setCallback(object : MediaSessionCompat.Callback() {
                override fun onPlay() {
                    if (hasTrack) dispatchCommand("play")
                }

                override fun onPause() = dispatchCommand("pause")
                override fun onStop() = dispatchCommand("stop")
                override fun onSkipToNext() = dispatchCommand("next")
                override fun onSkipToPrevious() = dispatchCommand("previous")
            })
            isActive = true
        }
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Now playing", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Playback controls and current track"
                setShowBadge(false)
                lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
            }
        )
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP_SERVICE) {
            stopPlaybackService()
            return START_NOT_STICKY
        }

        if (intent?.action == ACTION_UPDATE) {
            title = intent.getStringExtra("title") ?: "Melodock"
            artist = intent.getStringExtra("artist") ?: "Unknown artist"
            album = intent.getStringExtra("album") ?: ""
            playing = intent.getBooleanExtra("playing", false)
            hasTrack = true
        }

        updateMediaSession()
        startForeground(NOTIFICATION_ID, buildNotification())
        return START_STICKY
    }

    private fun updateMediaSession() {
        mediaSession.setMetadata(
            MediaMetadataCompat.Builder()
                .putString(MediaMetadataCompat.METADATA_KEY_TITLE, title)
                .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, artist)
                .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, album)
                .build()
        )
        val state = if (playing) PlaybackStateCompat.STATE_PLAYING else PlaybackStateCompat.STATE_PAUSED
        mediaSession.setPlaybackState(
            PlaybackStateCompat.Builder()
                .setActions(SUPPORTED_ACTIONS)
                .setState(state, PlaybackStateCompat.PLAYBACK_POSITION_UNKNOWN, if (playing) 1f else 0f)
                .build()
        )
        mediaSession.isActive = true
    }

    private fun dispatchCommand(command: String) {
        sendBroadcast(
            Intent(ACTION_COMMAND)
                .setPackage(packageName)
                .putExtra("command", command)
        )
    }

    private fun commandPendingIntent(command: String, requestCode: Int): PendingIntent {
        val intent = Intent(ACTION_COMMAND).setPackage(packageName).putExtra("command", command)
        return PendingIntent.getBroadcast(
            this,
            requestCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    private fun buildNotification() =
        NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(artist)
            .setSubText(album)
            .setContentIntent(
                PendingIntent.getActivity(
                    this,
                    10,
                    packageManager.getLaunchIntentForPackage(packageName)
                        ?: Intent(this, MainActivity::class.java),
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )
            )
            .setDeleteIntent(commandPendingIntent("stop", 14))
            .addAction(android.R.drawable.ic_media_previous, "Previous", commandPendingIntent("previous", 11))
            .addAction(
                if (playing) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play,
                if (playing) "Pause" else "Play",
                commandPendingIntent(if (playing) "pause" else "play", 12)
            )
            .addAction(android.R.drawable.ic_media_next, "Next", commandPendingIntent("next", 13))
            .setStyle(
                MediaStyle()
                    .setMediaSession(mediaSession.sessionToken)
                    .setShowActionsInCompactView(0, 1, 2)
            )
            .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setOngoing(playing)
            .build()

    private fun stopPlaybackService() {
        mediaSession.isActive = false
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        mediaSession.isActive = false
        mediaSession.release()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
