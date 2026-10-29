package com.musicflow.player.data.model

data class LyricLine(
    val timestampMs: Long,
    val text: String
)

data class Lyrics(
    val songId: String,
    val isSynced: Boolean = false,
    val lines: List<LyricLine> = emptyList(),
    val plainLyrics: String = ""
)

