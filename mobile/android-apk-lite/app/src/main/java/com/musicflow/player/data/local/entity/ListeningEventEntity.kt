package com.musicflow.player.data.local.entity

import androidx.room.Entity
import androidx.room.PrimaryKey
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Entity(tableName = "listening_events")
data class ListeningEventEntity(
    @PrimaryKey(autoGenerate = true) val eventId: Long = 0L,
    val songId: String,
    val title: String,
    val artist: String,
    val thumbnail: String,
    val listenedSec: Long = 0L,
    val durationSec: Long = 0L,
    val timestamp: Long = System.currentTimeMillis(),
    val dayKey: String = SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date(System.currentTimeMillis()))
)

