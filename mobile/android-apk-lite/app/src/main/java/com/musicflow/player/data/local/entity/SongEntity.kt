package com.musicflow.player.data.local.entity

import androidx.room.Entity
import androidx.room.PrimaryKey
import com.musicflow.player.data.model.Song

@Entity(tableName = "songs")
data class SongEntity(
    @PrimaryKey val id: String,
    val title: String,
    val artist: String = "Unknown Artist",
    val duration: Long = 0L,
    val thumbnail: String = "",
    val streamUrl: String = "",
    val isLocal: Boolean = false,
    val localUri: String? = null,
    val isDownloaded: Boolean = false,
    val localFilePath: String? = null,
    val isFavorite: Boolean = false,
    val favoriteAt: Long = 0L,
    val playCount: Int = 0,
    val lastPlayedAt: Long = 0L,
    val dateAdded: Long = System.currentTimeMillis()
) {
    fun toSong(): Song = Song(
        id = id,
        title = title,
        artist = artist,
        duration = duration,
        thumbnail = thumbnail,
        streamUrl = streamUrl,
        isLocal = isLocal,
        localUri = localUri,
        isDownloaded = isDownloaded,
        localFilePath = localFilePath,
        isFavorite = isFavorite,
        dateAdded = dateAdded
    )

    companion object {
        fun fromSong(song: Song, isFav: Boolean = song.isFavorite): SongEntity = SongEntity(
            id = song.id,
            title = song.title,
            artist = song.artist,
            duration = song.duration,
            thumbnail = song.thumbnail,
            streamUrl = song.streamUrl,
            isLocal = song.isLocal,
            localUri = song.localUri,
            isDownloaded = song.isDownloaded,
            localFilePath = song.localFilePath,
            isFavorite = isFav,
            favoriteAt = if (isFav) System.currentTimeMillis() else 0L,
            dateAdded = song.dateAdded
        )
    }
}

