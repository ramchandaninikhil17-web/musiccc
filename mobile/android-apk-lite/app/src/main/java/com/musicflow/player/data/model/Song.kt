package com.musicflow.player.data.model

import java.io.Serializable

data class Song(
    val id: String,
    val title: String,
    val artist: String = "Unknown Artist",
    val duration: Long = 0L, // in seconds
    val thumbnail: String = "",
    val streamUrl: String = "",
    val isLocal: Boolean = false,
    val localUri: String? = null,
    val isDownloaded: Boolean = false,
    val localFilePath: String? = null,
    val isFavorite: Boolean = false,
    val dateAdded: Long = System.currentTimeMillis()
) : Serializable {
    val formattedDuration: String
        get() {
            if (duration <= 0) return "--:--"
            val m = duration / 60
            val s = duration % 60
            return "%d:%02d".format(m, s)
        }
}

