package com.musicflow.player.data.local.entity

import androidx.room.Entity
import androidx.room.PrimaryKey
import com.musicflow.player.data.model.Playlist

@Entity(tableName = "playlists")
data class PlaylistEntity(
    @PrimaryKey val id: String,
    val name: String,
    val description: String = "",
    val coverUrl: String = "",
    val createdAt: Long = System.currentTimeMillis()
) {
    fun toPlaylist(songCount: Int = 0): Playlist = Playlist(
        id = id,
        name = name,
        description = description,
        coverUrl = coverUrl,
        songCount = songCount,
        createdAt = createdAt
    )
}

