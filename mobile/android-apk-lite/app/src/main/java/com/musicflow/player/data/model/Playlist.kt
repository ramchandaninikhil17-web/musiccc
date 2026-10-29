package com.musicflow.player.data.model

import java.io.Serializable

data class Playlist(
    val id: String,
    val name: String,
    val description: String = "",
    val coverUrl: String = "",
    val songCount: Int = 0,
    val createdAt: Long = System.currentTimeMillis(),
    val songs: List<Song> = emptyList()
) : Serializable

