package com.musicflow.mobile

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Binder
import android.os.Build
import android.os.IBinder
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import androidx.core.app.NotificationCompat
import androidx.media.app.NotificationCompat as MediaNotificationCompat
import java.net.URL
import java.util.concurrent.Executors

class PlaybackService : Service() {

    companion object {
        private const val NOTIFICATION_ID = 1
        private const val ACTION_PLAY_PAUSE = "com.musicflow.mobile.PLAY_PAUSE"
        private const val ACTION_NEXT = "com.musicflow.mobile.NEXT"
        private const val ACTION_PREVIOUS = "com.musicflow.mobile.PREVIOUS"
        private const val ACTION_STOP = "com.musicflow.mobile.STOP"
    }

    private val binder = LocalBinder()
    private lateinit var mediaSession: MediaSessionCompat
    private val executor = Executors.newSingleThreadExecutor()

    private var isPlaying = false
    private var currentTitle = "MusicFlow"
    private var currentArtist = ""
    private var currentAlbum = ""
    private var currentArtwork: Bitmap? = null
    private var currentArtworkUrl = ""

    inner class LocalBinder : Binder() {
        fun getService(): PlaybackService = this@PlaybackService
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onCreate() {
        super.onCreate()
        setupMediaSession()
    }

    private fun setupMediaSession() {
        mediaSession = MediaSessionCompat(this, "MusicFlowSession").apply {
            setFlags(
                MediaSessionCompat.FLAG_HANDLES_MEDIA_BUTTONS or
                MediaSessionCompat.FLAG_HANDLES_TRANSPORT_CONTROLS
            )

            setCallback(object : MediaSessionCompat.Callback() {
                override fun onPlay() {
                    sendCommandToWebView("if(typeof togglePlayPause==='function')togglePlayPause();")
                }

                override fun onPause() {
                    sendCommandToWebView("if(typeof togglePlayPause==='function')togglePlayPause();")
                }

                override fun onSkipToNext() {
                    sendCommandToWebView("if(typeof playNext==='function')playNext();")
                }

                override fun onSkipToPrevious() {
                    sendCommandToWebView("if(typeof playPrev==='function')playPrev();")
                }

                override fun onStop() {
                    stopPlayback()
                }

                override fun onSeekTo(pos: Long) {
                    sendCommandToWebView(
                        "if(typeof audioPlayer!=='undefined'&&audioPlayer){audioPlayer.currentTime=${pos / 1000.0};}"
                    )
                }
            })

            isActive = true
        }
    }

    private fun sendCommandToWebView(js: String) {
        val intent = Intent("com.musicflow.mobile.WEBVIEW_COMMAND")
        intent.putExtra("js", js)
        sendBroadcast(intent)
    }

    fun startPlayback() {
        isPlaying = true

        try {
            val notification = buildNotification()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIFICATION_ID, notification, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
        } catch (_: Exception) {}

        updatePlaybackState()
        updateNotification()
    }

    fun pausePlayback() {
        isPlaying = false
        updatePlaybackState()
        updateNotification()
    }

    fun stopPlayback() {
        isPlaying = false
        mediaSession.isActive = false
        stopForeground(true)
        stopSelf()
    }

    fun updateMetadata(title: String, artist: String, album: String, artworkUrl: String) {
        currentTitle = title.ifEmpty { "MusicFlow" }
        currentArtist = artist
        currentAlbum = album

        val metaBuilder = MediaMetadataCompat.Builder()
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE, currentTitle)
            .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, currentArtist)
            .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, currentAlbum)

        if (artworkUrl.isNotEmpty() && artworkUrl != currentArtworkUrl) {
            currentArtworkUrl = artworkUrl
            executor.execute {
                try {
                    val url = URL(artworkUrl)
                    val bitmap = BitmapFactory.decodeStream(url.openStream())
                    currentArtwork = bitmap
                    metaBuilder.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, bitmap)
                    mediaSession.setMetadata(metaBuilder.build())
                    updateNotification()
                } catch (e: Exception) {
                    currentArtwork = null
                    mediaSession.setMetadata(metaBuilder.build())
                    updateNotification()
                }
            }
        } else {
            currentArtwork?.let {
                metaBuilder.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, it)
            }
            mediaSession.setMetadata(metaBuilder.build())
            updateNotification()
        }
    }

    private fun updatePlaybackState() {
        val state = if (isPlaying) PlaybackStateCompat.STATE_PLAYING else PlaybackStateCompat.STATE_PAUSED
        val actions = PlaybackStateCompat.ACTION_PLAY or
                PlaybackStateCompat.ACTION_PAUSE or
                PlaybackStateCompat.ACTION_PLAY_PAUSE or
                PlaybackStateCompat.ACTION_SKIP_TO_NEXT or
                PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS or
                PlaybackStateCompat.ACTION_STOP or
                PlaybackStateCompat.ACTION_SEEK_TO

        mediaSession.setPlaybackState(
            PlaybackStateCompat.Builder()
                .setState(state, PlaybackStateCompat.PLAYBACK_POSITION_UNKNOWN, 1.0f)
                .setActions(actions)
                .build()
        )
    }

    private fun updateNotification() {
        if (!isPlaying && currentTitle == "MusicFlow") return

        try {
            val notification = buildNotification()
            val manager = getSystemService(NOTIFICATION_SERVICE) as android.app.NotificationManager
            manager.notify(NOTIFICATION_ID, notification)
        } catch (_: Exception) {}
    }

    private fun buildNotification(): Notification {
        val contentIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val prevIntent = PendingIntent.getService(
            this, 1,
            Intent(this, PlaybackService::class.java).apply { action = ACTION_PREVIOUS },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val playPauseIntent = PendingIntent.getService(
            this, 2,
            Intent(this, PlaybackService::class.java).apply { action = ACTION_PLAY_PAUSE },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val nextIntent = PendingIntent.getService(
            this, 3,
            Intent(this, PlaybackService::class.java).apply { action = ACTION_NEXT },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val playPauseIcon = if (isPlaying) R.drawable.ic_pause else R.drawable.ic_play
        val playPauseTitle = if (isPlaying) "Pause" else "Play"

        val builder = NotificationCompat.Builder(this, MusicFlowApp.PLAYBACK_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(currentTitle)
            .setContentText(currentArtist.ifEmpty { "Streaming via MusicFlow" })
            .setSubText(currentAlbum.ifEmpty { null })
            .setContentIntent(contentIntent)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(isPlaying)
            .addAction(R.drawable.ic_previous, "Previous", prevIntent)
            .addAction(playPauseIcon, playPauseTitle, playPauseIntent)
            .addAction(R.drawable.ic_next, "Next", nextIntent)
            .setStyle(
                MediaNotificationCompat.MediaStyle()
                    .setMediaSession(mediaSession.sessionToken)
                    .setShowActionsInCompactView(0, 1, 2)
            )

        currentArtwork?.let {
            builder.setLargeIcon(it)
        }

        return builder.build()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_PLAY_PAUSE -> {
                sendCommandToWebView("if(typeof togglePlayPause==='function')togglePlayPause();")
            }
            ACTION_NEXT -> {
                sendCommandToWebView("if(typeof playNext==='function')playNext();")
            }
            ACTION_PREVIOUS -> {
                sendCommandToWebView("if(typeof playPrev==='function')playPrev();")
            }
            ACTION_STOP -> {
                stopPlayback()
            }
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        super.onDestroy()
        mediaSession.release()
        executor.shutdown()
    }
}
