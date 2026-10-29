package com.musicflow.player.playback

import android.content.ComponentName
import android.content.Context
import android.net.Uri
import android.util.Log
import androidx.annotation.OptIn
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.MoreExecutors
import com.musicflow.player.data.model.Lyrics
import com.musicflow.player.data.model.Song
import com.musicflow.player.data.remote.LRCLibClient
import com.musicflow.player.data.remote.YouTubeExtractor
import com.musicflow.player.data.repository.MusicRepository
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

@OptIn(UnstableApi::class)
class PlaybackManager private constructor(private val context: Context) {
    private val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())
    private var controllerFuture: ListenableFuture<MediaController>? = null
    var mediaController: MediaController? = null
        private set

    private val repository = MusicRepository(context)

    // Reactive playback states
    private val _currentSong = MutableStateFlow<Song?>(null)
    val currentSong: StateFlow<Song?> = _currentSong.asStateFlow()

    private val _isPlaying = MutableStateFlow(false)
    val isPlaying: StateFlow<Boolean> = _isPlaying.asStateFlow()

    private val _currentPositionMs = MutableStateFlow(0L)
    val currentPositionMs: StateFlow<Long> = _currentPositionMs.asStateFlow()

    private val _durationMs = MutableStateFlow(0L)
    val durationMs: StateFlow<Long> = _durationMs.asStateFlow()

    private val _queue = MutableStateFlow<List<Song>>(emptyList())
    val queue: StateFlow<List<Song>> = _queue.asStateFlow()

    private val _isShuffle = MutableStateFlow(false)
    val isShuffle: StateFlow<Boolean> = _isShuffle.asStateFlow()

    private val _repeatMode = MutableStateFlow(Player.REPEAT_MODE_OFF)
    val repeatMode: StateFlow<Int> = _repeatMode.asStateFlow()

    private val _lyrics = MutableStateFlow<Lyrics?>(null)
    val lyrics: StateFlow<Lyrics?> = _lyrics.asStateFlow()

    private val _activeLyricIndex = MutableStateFlow(-1)
    val activeLyricIndex: StateFlow<Int> = _activeLyricIndex.asStateFlow()

    var crossfadeSeconds: Int = 0

    val sleepTimerManager = SleepTimerManager {
        pause()
    }

    private var progressJob: Job? = null
    private var prefetchJob: Job? = null
    private var hasPrefetchedForCurrentSong = false

    companion object {
        @Volatile
        private var INSTANCE: PlaybackManager? = null

        fun getInstance(context: Context): PlaybackManager {
            return INSTANCE ?: synchronized(this) {
                INSTANCE ?: PlaybackManager(context.applicationContext).also { INSTANCE = it }
            }
        }
    }

    init {
        connectToService()
    }

    private fun connectToService() {
        val sessionToken = SessionToken(context, ComponentName(context, PlaybackService::class.java))
        controllerFuture = MediaController.Builder(context, sessionToken).buildAsync()
        controllerFuture?.addListener({
            try {
                mediaController = controllerFuture?.get()
                setupPlayerListener()
            } catch (e: Exception) {
                Log.e("PlaybackManager", "Failed to connect to MediaSession: ${e.message}")
            }
        }, MoreExecutors.directExecutor())
    }

    private fun setupPlayerListener() {
        mediaController?.addListener(object : Player.Listener {
            override fun onIsPlayingChanged(isPlaying: Boolean) {
                _isPlaying.value = isPlaying
                if (isPlaying) startProgressLoop() else stopProgressLoop()
            }

            override fun onPlaybackStateChanged(playbackState: Int) {
                if (playbackState == Player.STATE_ENDED) {
                    sleepTimerManager.onTrackFinished()
                    skipToNext()
                }
            }

            override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
                updateCurrentSongFromMediaItem(mediaItem)
            }
        })
    }

    private fun updateCurrentSongFromMediaItem(mediaItem: MediaItem?) {
        if (mediaItem == null) return
        val id = mediaItem.mediaId
        val song = _queue.value.find { it.id == id } ?: _currentSong.value
        if (song != null) {
            _currentSong.value = song
            hasPrefetchedForCurrentSong = false
            loadLyrics(song)
        }
    }

    fun playSong(song: Song, newQueue: List<Song> = listOf(song)) {
        val index = newQueue.indexOfFirst { it.id == song.id }.coerceAtLeast(0)
        _queue.value = newQueue
        _currentSong.value = song
        hasPrefetchedForCurrentSong = false

        loadLyrics(song)

        scope.launch {
            val resolvedSong = ensureStreamUrl(song)
            val controller = mediaController ?: return@launch

            val mediaItem = buildMediaItem(resolvedSong)
            controller.setMediaItem(mediaItem)
            controller.prepare()
            controller.play()

            // Pre-resolve next track
            preloadNextTracks()
        }
    }

    private suspend fun ensureStreamUrl(song: Song): Song {
        if (song.isLocal || song.isDownloaded || song.streamUrl.isNotBlank()) {
            return song
        }
        val url = YouTubeExtractor.getStreamUrl(song.id) ?: ""
        return song.copy(streamUrl = url)
    }

    private fun buildMediaItem(song: Song): MediaItem {
        val uri = when {
            song.isDownloaded && song.localFilePath != null -> Uri.fromFile(java.io.File(song.localFilePath))
            song.isLocal && song.localUri != null -> Uri.parse(song.localUri)
            else -> Uri.parse(song.streamUrl)
        }

        val metadata = MediaMetadata.Builder()
            .setTitle(song.title)
            .setArtist(song.artist)
            .setArtworkUri(if (song.thumbnail.isNotBlank()) Uri.parse(song.thumbnail) else null)
            .build()

        return MediaItem.Builder()
            .setMediaId(song.id)
            .setUri(uri)
            .setMediaMetadata(metadata)
            .build()
    }

    fun togglePlayPause() {
        val controller = mediaController ?: return
        if (controller.isPlaying) controller.pause() else controller.play()
    }

    fun pause() { mediaController?.pause() }
    fun resume() { mediaController?.play() }

    fun seekTo(positionMs: Long) {
        mediaController?.seekTo(positionMs)
        _currentPositionMs.value = positionMs
    }

    fun skipToNext() {
        val q = _queue.value
        val cur = _currentSong.value ?: return
        val curIdx = q.indexOfFirst { it.id == cur.id }

        if (curIdx in 0 until q.size - 1) {
            playSong(q[curIdx + 1], q)
        } else if (_repeatMode.value == Player.REPEAT_MODE_ALL && q.isNotEmpty()) {
            playSong(q[0], q)
        } else {
            // Queue ended: trigger Smart Auto-Queue Radio!
            scope.launch {
                val related = YouTubeExtractor.getRelatedTracks(cur.id)
                if (related.isNotEmpty()) {
                    val extendedQueue = q + related
                    _queue.value = extendedQueue
                    playSong(related.first(), extendedQueue)
                }
            }
        }
    }

    fun skipToPrevious() {
        val q = _queue.value
        val cur = _currentSong.value ?: return
        val curIdx = q.indexOfFirst { it.id == cur.id }
        if (curIdx > 0) {
            playSong(q[curIdx - 1], q)
        } else {
            seekTo(0L)
        }
    }

    fun toggleShuffle() {
        _isShuffle.value = !_isShuffle.value
        if (_isShuffle.value) {
            val cur = _currentSong.value
            val shuffled = _queue.value.shuffled().toMutableList()
            if (cur != null) {
                shuffled.remove(cur)
                shuffled.add(0, cur)
            }
            _queue.value = shuffled
        }
    }

    fun toggleRepeat() {
        val next = when (_repeatMode.value) {
            Player.REPEAT_MODE_OFF -> Player.REPEAT_MODE_ALL
            Player.REPEAT_MODE_ALL -> Player.REPEAT_MODE_ONE
            else -> Player.REPEAT_MODE_OFF
        }
        _repeatMode.value = next
        mediaController?.repeatMode = next
    }

    fun addToQueue(song: Song) {
        _queue.value = _queue.value + song
        if (_currentSong.value == null) {
            playSong(song, _queue.value)
        }
    }

    fun playNext(song: Song) {
        val q = _queue.value.toMutableList()
        val cur = _currentSong.value
        val curIdx = if (cur != null) q.indexOfFirst { it.id == cur.id } else -1
        if (curIdx >= 0) {
            q.add(curIdx + 1, song)
        } else {
            q.add(0, song)
        }
        _queue.value = q
    }

    fun removeFromQueue(index: Int) {
        val q = _queue.value.toMutableList()
        if (index in q.indices) {
            q.removeAt(index)
            _queue.value = q
        }
    }

    fun reorderQueue(from: Int, to: Int) {
        val q = _queue.value.toMutableList()
        if (from in q.indices && to in q.indices) {
            val item = q.removeAt(from)
            q.add(to, item)
            _queue.value = q
        }
    }

    private fun preloadNextTracks() {
        prefetchJob?.cancel()
        prefetchJob = scope.launch(Dispatchers.IO) {
            val q = _queue.value
            val cur = _currentSong.value ?: return@launch
            val curIdx = q.indexOfFirst { it.id == cur.id }
            if (curIdx >= 0) {
                val next1 = q.getOrNull(curIdx + 1)
                val next2 = q.getOrNull(curIdx + 2)
                if (next1 != null && !next1.isLocal && !next1.isDownloaded) {
                    YouTubeExtractor.getStreamUrl(next1.id)
                }
                if (next2 != null && !next2.isLocal && !next2.isDownloaded) {
                    YouTubeExtractor.getStreamUrl(next2.id)
                }
            }
        }
    }

    private fun loadLyrics(song: Song) {
        _lyrics.value = null
        _activeLyricIndex.value = -1
        scope.launch {
            val res = LRCLibClient.fetchLyrics(song.id, song.title, song.artist, song.duration)
            if (_currentSong.value?.id == song.id) {
                _lyrics.value = res
            }
        }
    }

    private fun startProgressLoop() {
        progressJob?.cancel()
        progressJob = scope.launch {
            while (isActive) {
                val controller = mediaController
                if (controller != null && controller.isPlaying) {
                    val pos = controller.currentPosition
                    val dur = controller.duration.coerceAtLeast(0L)
                    _currentPositionMs.value = pos
                    _durationMs.value = dur

                    // Update synced lyrics active line
                    updateActiveLyric(pos)

                    // Predictive prefetch at 60% progress
                    if (dur > 0 && pos.toFloat() / dur >= 0.6f && !hasPrefetchedForCurrentSong) {
                        hasPrefetchedForCurrentSong = true
                        preloadNextTracks()
                    }
                }
                delay(200L)
            }
        }
    }

    private fun updateActiveLyric(currentPosMs: Long) {
        val lyr = _lyrics.value ?: return
        if (!lyr.isSynced || lyr.lines.isEmpty()) return

        var activeIdx = -1
        for (i in lyr.lines.indices) {
            if (currentPosMs >= lyr.lines[i].timestampMs) {
                activeIdx = i
            } else {
                break
            }
        }
        _activeLyricIndex.value = activeIdx
    }

    private fun stopProgressLoop() {
        progressJob?.cancel()
        progressJob = null
    }
}

