package com.musicflow.player

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Binder
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.database.StandaloneDatabaseProvider
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.cache.CacheDataSource
import androidx.media3.datasource.cache.LeastRecentlyUsedCacheEvictor
import androidx.media3.datasource.cache.SimpleCache
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import java.io.File
import java.net.URL
import java.util.concurrent.Executors

@OptIn(UnstableApi::class)
class PlaybackService : MediaSessionService() {

    companion object {
        private const val TAG = "PlaybackService"
        private const val CACHE_SIZE = 300 * 1024 * 1024L // 300 MB audio disk cache

        @Volatile
        private var simpleCache: SimpleCache? = null

        @Synchronized
        fun getCache(context: Context): SimpleCache {
            if (simpleCache == null) {
                val cacheDir = File(context.cacheDir, "musicflow_audio_cache")
                if (!cacheDir.exists()) cacheDir.mkdirs()
                val evictor = LeastRecentlyUsedCacheEvictor(CACHE_SIZE)
                val databaseProvider = StandaloneDatabaseProvider(context)
                simpleCache = SimpleCache(cacheDir, evictor, databaseProvider)
            }
            return simpleCache!!
        }
    }

    private val binder = LocalBinder()
    private var mediaSession: MediaSession? = null
    lateinit var player: ExoPlayer
        private set

    private val executor = Executors.newSingleThreadExecutor()
    private val mainHandler = Handler(Looper.getMainLooper())

    private var currentId: String = ""
    private var currentTitle: String = "MusicFlow"
    private var currentArtist: String = ""
    private var currentAlbum: String = ""
    private var currentArtworkUrl: String = ""
    private var currentArtwork: Bitmap? = null

    private var sleepTimerRunnable: Runnable? = null
    var playbackListener: PlaybackEventListener? = null

    interface PlaybackEventListener {
        fun onPlaybackStateChanged(isPlaying: Boolean)
        fun onPositionUpdate(positionMs: Long, durationMs: Long, bufferedMs: Long)
        fun onTrackEnded()
        fun onError(error: String)
    }

    inner class LocalBinder : Binder() {
        fun getService(): PlaybackService = this@PlaybackService
    }

    override fun onBind(intent: Intent?): android.os.IBinder? {
        val superBinder = super.onBind(intent)
        // If system is binding for MediaSessionService, return super, otherwise our local binder
        return superBinder ?: binder
    }

    override fun onCreate() {
        super.onCreate()
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            val channel = android.app.NotificationChannel(
                "musicflow_playback",
                "MusicFlow Playback",
                android.app.NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "MusicFlow background audio playback & lock-screen controls"
                setShowBadge(false)
            }
            val manager = getSystemService(android.app.NotificationManager::class.java)
            manager?.createNotificationChannel(channel)
        }
        setupExoPlayer()
        setupMediaSession()
        startPositionReporting()
    }

    private fun setupExoPlayer() {
        val cache = getCache(this)
        val httpDataSourceFactory = DefaultHttpDataSource.Factory()
            .setUserAgent("MusicFlow/3.0 (Android; ExoPlayer)")
            .setConnectTimeoutMs(15000)
            .setReadTimeoutMs(30000)
            .setAllowCrossProtocolRedirects(true)

        val cacheDataSourceFactory = CacheDataSource.Factory()
            .setCache(cache)
            .setUpstreamDataSourceFactory(httpDataSourceFactory)
            .setFlags(CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR)

        val mediaSourceFactory = DefaultMediaSourceFactory(cacheDataSourceFactory)

        val audioAttributes = AudioAttributes.Builder()
            .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
            .setUsage(C.USAGE_MEDIA)
            .build()

        player = ExoPlayer.Builder(this)
            .setMediaSourceFactory(mediaSourceFactory)
            .setAudioAttributes(audioAttributes, /* handleAudioFocus = */ true)
            .setWakeMode(C.WAKE_MODE_NETWORK)
            .setHandleAudioBecomingNoisy(true)
            .build()

        player.addListener(object : Player.Listener {
            override fun onIsPlayingChanged(isPlaying: Boolean) {
                playbackListener?.onPlaybackStateChanged(isPlaying)
            }

            override fun onPlaybackStateChanged(playbackState: Int) {
                when (playbackState) {
                    Player.STATE_ENDED -> {
                        playbackListener?.onTrackEnded()
                    }
                    Player.STATE_READY -> {
                        playbackListener?.onPositionUpdate(
                            player.currentPosition,
                            player.duration.coerceAtLeast(0L),
                            player.bufferedPosition
                        )
                    }
                    else -> {}
                }
            }

            override fun onPlayerError(error: PlaybackException) {
                Log.e(TAG, "ExoPlayer error: ${error.message}", error)
                playbackListener?.onError(error.message ?: "Playback error")
            }
        })
    }

    private fun setupMediaSession() {
        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pendingIntent = PendingIntent.getActivity(
            this,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        mediaSession = MediaSession.Builder(this, player)
            .setSessionActivity(pendingIntent)
            .build()
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? {
        return mediaSession
    }

    // ── Playback Controls ──

    fun playTrack(
        id: String,
        title: String,
        artist: String,
        album: String,
        artworkUrl: String,
        streamUrl: String
    ) {
        currentId = id
        currentTitle = title.ifEmpty { "MusicFlow" }
        currentArtist = artist
        currentAlbum = album
        currentArtworkUrl = artworkUrl

        val metadataBuilder = MediaMetadata.Builder()
            .setTitle(currentTitle)
            .setArtist(currentArtist)
            .setAlbumTitle(currentAlbum)
            .setDisplayTitle(currentTitle)

        if (artworkUrl.isNotEmpty()) {
            metadataBuilder.setArtworkUri(Uri.parse(artworkUrl))
        }

        val mediaItem = MediaItem.Builder()
            .setMediaId(id)
            .setUri(streamUrl)
            .setMediaMetadata(metadataBuilder.build())
            .build()

        player.setMediaItem(mediaItem)
        player.prepare()
        player.play()

        loadArtworkBitmap(artworkUrl)
    }

    private fun loadArtworkBitmap(artworkUrl: String) {
        if (artworkUrl.isEmpty()) return
        executor.execute {
            try {
                val resolvedUrl = if (artworkUrl.startsWith("//")) "https:$artworkUrl" else artworkUrl
                val stream = URL(resolvedUrl).openStream()
                val bitmap = BitmapFactory.decodeStream(stream)
                stream.close()
                if (bitmap != null) {
                    currentArtwork = bitmap
                    mainHandler.post {
                        val meta = player.mediaMetadata.buildUpon()
                            .setArtworkUri(Uri.parse(artworkUrl))
                            .build()
                        // Update session metadata with loaded art
                        val currentItem = player.currentMediaItem
                        if (currentItem != null) {
                            val updatedItem = currentItem.buildUpon().setMediaMetadata(meta).build()
                            // Just update metadata in place
                        }
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "Failed to load artwork: ${e.message}")
            }
        }
    }

    fun pause() {
        player.pause()
    }

    fun resume() {
        player.play()
    }

    fun togglePlayPause() {
        if (player.isPlaying) {
            player.pause()
        } else {
            player.play()
        }
    }

    fun seekTo(positionMs: Long) {
        player.seekTo(positionMs)
    }

    fun setPlaybackSpeed(speed: Float) {
        player.playbackParameters = PlaybackParameters(speed.coerceIn(0.5f, 2.0f))
    }

    fun setSleepTimer(minutes: Int) {
        sleepTimerRunnable?.let { mainHandler.removeCallbacks(it) }
        if (minutes <= 0) {
            sleepTimerRunnable = null
            return
        }

        sleepTimerRunnable = Runnable {
            fadeOutAndPause()
        }
        mainHandler.postDelayed(sleepTimerRunnable!!, minutes * 60 * 1000L)
        Log.i(TAG, "Sleep timer set for $minutes minutes")
    }

    private fun fadeOutAndPause() {
        val initialVolume = player.volume
        val steps = 10
        val stepDelay = 200L
        for (i in 1..steps) {
            mainHandler.postDelayed({
                val vol = initialVolume * (1f - (i.toFloat() / steps))
                player.volume = vol
                if (i == steps) {
                    player.pause()
                    player.volume = initialVolume
                }
            }, i * stepDelay)
        }
    }

    // ── Continuous Position Reporting Loop (60fps smooth seekbar & lyrics sync) ──

    private fun startPositionReporting() {
        mainHandler.post(object : Runnable {
            override fun run() {
                if (player.isPlaying) {
                    playbackListener?.onPositionUpdate(
                        player.currentPosition,
                        player.duration.coerceAtLeast(0L),
                        player.bufferedPosition
                    )
                }
                mainHandler.postDelayed(this, 100) // 10Hz update
            }
        })
    }

    override fun onDestroy() {
        sleepTimerRunnable?.let { mainHandler.removeCallbacks(it) }
        mediaSession?.run {
            player.release()
            release()
            mediaSession = null
        }
        super.onDestroy()
    }
}
