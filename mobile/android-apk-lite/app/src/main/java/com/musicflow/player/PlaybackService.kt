package com.musicflow.player

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
        private const val ACTION_PLAY_PAUSE = "com.musicflow.player.PLAY_PAUSE"
        private const val ACTION_NEXT = "com.musicflow.player.NEXT"
        private const val ACTION_PREVIOUS = "com.musicflow.player.PREVIOUS"
        private const val ACTION_STOP = "com.musicflow.player.STOP"
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
        val intent = Intent("com.musicflow.player.WEBVIEW_COMMAND")
        intent.putExtra("js", js)
        sendBroadcast(intent)
    }

    fun startPlayback() {
        isPlaying = true

        // Start foreground service
        try {
            val notification = buildNotification()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIFICATION_ID, notification, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
        } catch (e: Exception) {
            // Foreground service start can fail on some devices
        }

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

        // Fetch artwork in background
        if (artworkUrl.isNotEmpty() && artworkUrl != currentArtworkUrl) {
            currentArtworkUrl = artworkUrl
            executor.execute {
                try {
                    val url = if (artworkUrl.startsWith("//")) "https:$artworkUrl"
                              else if (artworkUrl.startsWith("/")) {
                                  val prefs = getSharedPreferences("musicflow_prefs", android.content.Context.MODE_PRIVATE)
                                  val base = prefs.getString("server_url", "https://musicwalahnar.com") ?: "https://musicwalahnar.com"
                                  "$base$artworkUrl"
                              }
                              else artworkUrl
                    val inputStream = URL(url).openStream()
                    val bitmap = BitmapFactory.decodeStream(inputStream)
                    inputStream.close()
                    if (bitmap != null) {
                        currentArtwork = bitmap
                        updateMediaSessionMetadata()
                        updateNotification()
                    }
                } catch (e: Exception) {
                    // Failed to load artwork, continue without it
                }
            }
        }

        updateMediaSessionMetadata()
        updateNotification()
    }

    private fun updateMediaSessionMetadata() {
        val builder = MediaMetadataCompat.Builder()
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE, currentTitle)
            .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, currentArtist)
            .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, currentAlbum)
            .putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_TITLE, currentTitle)
            .putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_SUBTITLE, currentArtist)

        currentArtwork?.let {
            builder.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, it)
            builder.putBitmap(MediaMetadataCompat.METADATA_KEY_ART, it)
        }

        mediaSession.setMetadata(builder.build())
    }

    private fun updatePlaybackState() {
        val state = if (isPlaying) {
            PlaybackStateCompat.STATE_PLAYING
        } else {
            PlaybackStateCompat.STATE_PAUSED
        }

        val playbackState = PlaybackStateCompat.Builder()
            .setActions(
                PlaybackStateCompat.ACTION_PLAY or
                PlaybackStateCompat.ACTION_PAUSE or
                PlaybackStateCompat.ACTION_PLAY_PAUSE or
                PlaybackStateCompat.ACTION_SKIP_TO_NEXT or
                PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS or
                PlaybackStateCompat.ACTION_STOP or
                PlaybackStateCompat.ACTION_SEEK_TO
            )
            .setState(state, PlaybackStateCompat.PLAYBACK_POSITION_UNKNOWN, 1.0f)
            .build()

        mediaSession.setPlaybackState(playbackState)
    }

    private fun buildNotification(): Notification {
        val launchIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pendingLaunch = PendingIntent.getActivity(
            this, 0, launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // Action intents
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
        val stopIntent = PendingIntent.getService(
            this, 4,
            Intent(this, PlaybackService::class.java).apply { action = ACTION_STOP },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val playPauseIcon = if (isPlaying) R.drawable.ic_pause else R.drawable.ic_play
        val playPauseLabel = if (isPlaying) "Pause" else "Play"

        val builder = NotificationCompat.Builder(this, MusicFlowApp.CHANNEL_PLAYBACK)
            .setContentTitle(currentTitle)
            .setContentText(currentArtist)
            .setSubText(currentAlbum)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentIntent(pendingLaunch)
            .setDeleteIntent(stopIntent)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(isPlaying)
            .setShowWhen(false)
            .addAction(R.drawable.ic_previous, "Previous", prevIntent)
            .addAction(playPauseIcon, playPauseLabel, playPauseIntent)
            .addAction(R.drawable.ic_next, "Next", nextIntent)
            .setStyle(
                MediaNotificationCompat.MediaStyle()
                    .setMediaSession(mediaSession.sessionToken)
                    .setShowActionsInCompactView(0, 1, 2)
                    .setShowCancelButton(true)
                    .setCancelButtonIntent(stopIntent)
            )
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_TRANSPORT)

        currentArtwork?.let {
            builder.setLargeIcon(it)
        }

        return builder.build()
    }

    private fun updateNotification() {
        try {
            val notification = buildNotification()
            val manager = getSystemService(NOTIFICATION_SERVICE) as android.app.NotificationManager
            manager.notify(NOTIFICATION_ID, notification)
        } catch (e: Exception) {
            // Notification update can fail if permissions were revoked
        }
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
        return START_STICKY
    }

    override fun onDestroy() {
        super.onDestroy()
        mediaSession.release()
        executor.shutdown()
    }
}
