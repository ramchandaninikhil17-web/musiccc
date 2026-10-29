package com.musicflow.player.data.repository

import android.content.Context
import androidx.work.Data
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import com.google.gson.Gson
import com.google.gson.JsonObject
import com.musicflow.player.data.local.MusicFlowDatabase
import com.musicflow.player.data.local.entity.ListeningEventEntity
import com.musicflow.player.data.local.entity.PlaylistEntity
import com.musicflow.player.data.local.entity.PlaylistSongCrossRef
import com.musicflow.player.data.local.entity.SearchHistoryEntity
import com.musicflow.player.data.local.entity.SongEntity
import com.musicflow.player.data.model.Playlist
import com.musicflow.player.data.model.Song
import com.musicflow.player.data.remote.YouTubeExtractor
import com.musicflow.player.data.worker.DownloadWorker
import com.musicflow.player.engine.QueryCleaner
import com.musicflow.player.engine.SuggestionEngine
import com.musicflow.player.engine.SuggestionItem
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.withContext
import java.util.UUID
import java.util.regex.Pattern

class MusicRepository(private val context: Context) {
    private val db = MusicFlowDatabase.getInstance(context)
    private val songDao = db.songDao()
    private val playlistDao = db.playlistDao()
    private val statsDao = db.listeningStatsDao()
    private val searchHistoryDao = db.searchHistoryDao()
    private val localMediaRepo = LocalMediaRepository(context)
    private val gson = Gson()

    // -------------------------------------------------------------
    // SEARCH & SUGGESTIONS
    // -------------------------------------------------------------
    suspend fun search(query: String, autoClean: Boolean = true): List<Song> = withContext(Dispatchers.IO) {
        val trimmed = query.trim()
        if (trimmed.isBlank()) return@withContext emptyList()

        // Record query in search history
        searchHistoryDao.insertQuery(SearchHistoryEntity(trimmed))

        // Check if query is YouTube URL or direct 11-char Video ID
        val directId = extractYouTubeId(trimmed)
        if (directId != null) {
            val song = resolveSongById(directId)
            if (song != null) return@withContext listOf(song)
        }

        // Apply QueryCleaner for typo fixing
        val effectiveQuery = if (autoClean) QueryCleaner.clean(trimmed) else trimmed
        YouTubeExtractor.search(effectiveQuery)
    }

    suspend fun getSuggestions(query: String): List<SuggestionItem> = withContext(Dispatchers.IO) {
        val trimmed = query.trim()
        if (trimmed.isBlank()) return@withContext emptyList()

        val historyQueries = searchHistoryDao.getRecentSearchesFlow().first().map { it.query }
        val favorites = songDao.getFavoriteSongsFlow().first().map { it.toSong() }
        val recent = songDao.getRecentlyPlayedFlow().first().map { it.toSong() }
        val remote = YouTubeExtractor.getSuggestions(trimmed)

        SuggestionEngine.rankSuggestions(trimmed, historyQueries, favorites, recent, remote)
    }

    suspend fun resolveSongById(videoId: String): Song? = withContext(Dispatchers.IO) {
        val cached = songDao.getSongById(videoId)
        if (cached != null) return@withContext cached.toSong()

        val results = YouTubeExtractor.search(videoId)
        results.find { it.id == videoId } ?: results.firstOrNull()
    }

    // -------------------------------------------------------------
    // PLAYLISTS
    // -------------------------------------------------------------
    fun getPlaylistsFlow(): Flow<List<Playlist>> {
        return playlistDao.getAllPlaylistsFlow().map { list ->
            list.map { entity ->
                val count = playlistDao.getSongCount(entity.id)
                entity.toPlaylist(count)
            }
        }
    }

    fun getPlaylistSongsFlow(playlistId: String): Flow<List<Song>> {
        return playlistDao.getSongsForPlaylistFlow(playlistId).map { list ->
            list.map { it.toSong() }
        }
    }

    suspend fun createPlaylist(name: String, description: String = ""): String = withContext(Dispatchers.IO) {
        val id = UUID.randomUUID().toString()
        playlistDao.insertPlaylist(
            PlaylistEntity(id = id, name = name, description = description)
        )
        id
    }

    suspend fun addSongToPlaylist(playlistId: String, song: Song) = withContext(Dispatchers.IO) {
        songDao.insertOrIgnore(SongEntity.fromSong(song))
        val count = playlistDao.getSongCount(playlistId)
        playlistDao.insertSongToPlaylist(
            PlaylistSongCrossRef(playlistId = playlistId, songId = song.id, orderIndex = count)
        )
    }

    suspend fun removeSongFromPlaylist(playlistId: String, songId: String) = withContext(Dispatchers.IO) {
        playlistDao.removeSong(playlistId, songId)
    }

    suspend fun deletePlaylist(playlistId: String) = withContext(Dispatchers.IO) {
        val p = playlistDao.getPlaylistById(playlistId)
        if (p != null) {
            playlistDao.clearPlaylistSongs(playlistId)
            playlistDao.deletePlaylist(p)
        }
    }

    // -------------------------------------------------------------
    // FAVORITES & HISTORY
    // -------------------------------------------------------------
    fun getFavoriteSongsFlow(): Flow<List<Song>> = songDao.getFavoriteSongsFlow().map { l -> l.map { it.toSong() } }
    fun getRecentlyPlayedFlow(): Flow<List<Song>> = songDao.getRecentlyPlayedFlow().map { l -> l.map { it.toSong() } }
    fun getDownloadedSongsFlow(): Flow<List<Song>> = songDao.getDownloadedSongsFlow().map { l -> l.map { it.toSong() } }
    fun getLocalSongsFlow(): Flow<List<Song>> = songDao.getLocalSongsFlow().map { l -> l.map { it.toSong() } }

    suspend fun toggleFavorite(song: Song): Boolean = withContext(Dispatchers.IO) {
        val existing = songDao.getSongById(song.id)
        val newFav = !(existing?.isFavorite ?: false)
        if (existing != null) {
            songDao.updateFavorite(song.id, newFav)
        } else {
            songDao.insertOrUpdate(SongEntity.fromSong(song, isFav = true))
        }
        newFav
    }

    suspend fun recordListeningEvent(song: Song, listenedSec: Long) = withContext(Dispatchers.IO) {
        songDao.insertOrIgnore(SongEntity.fromSong(song))
        songDao.recordPlay(song.id)
        statsDao.insertEvent(
            ListeningEventEntity(
                songId = song.id,
                title = song.title,
                artist = song.artist,
                thumbnail = song.thumbnail,
                listenedSec = listenedSec,
                durationSec = song.duration
            )
        )
    }

    // -------------------------------------------------------------
    // LOCAL FILES & DOWNLOADS
    // -------------------------------------------------------------
    suspend fun scanLocalMedia() = withContext(Dispatchers.IO) {
        val localSongs = localMediaRepo.scanLocalAudioFiles()
        songDao.clearLocalSongs()
        songDao.insertAll(localSongs.map { SongEntity.fromSong(it) })
    }

    fun startDownload(song: Song, format: String = "audio", quality: String = "192") {
        val data = Data.Builder()
            .putString(DownloadWorker.KEY_SONG_ID, song.id)
            .putString(DownloadWorker.KEY_TITLE, song.title)
            .putString(DownloadWorker.KEY_ARTIST, song.artist)
            .putString(DownloadWorker.KEY_FORMAT, format)
            .putString(DownloadWorker.KEY_QUALITY, quality)
            .putString(DownloadWorker.KEY_THUMB, song.thumbnail)
            .putLong(DownloadWorker.KEY_DURATION, song.duration)
            .build()

        val request = OneTimeWorkRequestBuilder<DownloadWorker>()
            .setInputData(data)
            .addTag("download_${song.id}")
            .build()

        WorkManager.getInstance(context).enqueue(request)
    }

    // -------------------------------------------------------------
    // BATCH IMPORT & BACKUP / RESTORE
    // -------------------------------------------------------------
    suspend fun batchImport(lines: List<String>, targetPlaylistName: String): Int = withContext(Dispatchers.IO) {
        val playlistId = createPlaylist(targetPlaylistName, "Batch imported on native MusicFlow")
        var imported = 0
        lines.filter { it.isNotBlank() }.forEach { line ->
            val results = search(line.trim(), autoClean = true)
            if (results.isNotEmpty()) {
                addSongToPlaylist(playlistId, results.first())
                imported++
            }
        }
        imported
    }

    suspend fun exportDataAsJson(): String = withContext(Dispatchers.IO) {
        val playlists = playlistDao.getAllPlaylistsFlow().first()
        val favorites = songDao.getFavoriteSongsFlow().first()
        val history = statsDao.getRecentEventsFlow().first()

        val root = JsonObject()
        root.addProperty("version", "3.5.0-HyperFlow")
        root.addProperty("exportedAt", System.currentTimeMillis())
        root.add("playlists", gson.toJsonTree(playlists))
        root.add("favorites", gson.toJsonTree(favorites))
        root.add("history", gson.toJsonTree(history))

        gson.toJson(root)
    }

    suspend fun importDataFromJson(jsonStr: String): Boolean = withContext(Dispatchers.IO) {
        try {
            val root = gson.fromJson(jsonStr, JsonObject::class.java)
            val favArr = root.getAsJsonArray("favorites")
            favArr?.forEach { elem ->
                val s = gson.fromJson(elem, SongEntity::class.java)
                songDao.insertOrUpdate(s)
            }
            val playArr = root.getAsJsonArray("playlists")
            playArr?.forEach { elem ->
                val p = gson.fromJson(elem, PlaylistEntity::class.java)
                playlistDao.insertPlaylist(p)
            }
            true
        } catch (_: Exception) {
            false
        }
    }

    private fun extractYouTubeId(urlOrId: String): String? {
        val trimmed = urlOrId.trim()
        if (trimmed.length == 11 && Pattern.compile("^[a-zA-Z0-9_-]{11}$").matcher(trimmed).matches()) {
            return trimmed
        }
        val p = Pattern.compile("(?:youtu\\.be/|youtube\\.com/(?:embed/|v/|watch\\?v=|watch\\?.+&v=))([a-zA-Z0-9_-]{11})")
        val m = p.matcher(trimmed)
        return if (m.find()) m.group(1) else null
    }
}

