package com.musicflow.player.data.local.dao

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import com.musicflow.player.data.local.entity.ListeningEventEntity
import kotlinx.coroutines.flow.Flow

data class ArtistPlayCount(val artist: String, val plays: Int, val totalSec: Long)
data class SongPlayCount(val songId: String, val title: String, val artist: String, val thumbnail: String, val plays: Int)
data class DayPlaySummary(val dayKey: String, val totalSeconds: Long, val trackCount: Int)

@Dao
interface ListeningStatsDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertEvent(event: ListeningEventEntity)

    @Query("SELECT * FROM listening_events ORDER BY timestamp DESC LIMIT 100")
    fun getRecentEventsFlow(): Flow<List<ListeningEventEntity>>

    @Query("SELECT * FROM listening_events WHERE dayKey = :dayKey ORDER BY timestamp DESC")
    suspend fun getEventsForDay(dayKey: String): List<ListeningEventEntity>

    @Query("""
        SELECT artist, COUNT(*) as plays, SUM(listenedSec) as totalSec
        FROM listening_events
        GROUP BY artist
        ORDER BY plays DESC
        LIMIT 10
    """)
    fun getTopArtistsFlow(): Flow<List<ArtistPlayCount>>

    @Query("""
        SELECT songId, title, artist, thumbnail, COUNT(*) as plays
        FROM listening_events
        GROUP BY songId
        ORDER BY plays DESC
        LIMIT 10
    """)
    fun getTopSongsFlow(): Flow<List<SongPlayCount>>

    @Query("""
        SELECT dayKey, SUM(listenedSec) as totalSeconds, COUNT(*) as trackCount
        FROM listening_events
        GROUP BY dayKey
        ORDER BY dayKey DESC
        LIMIT 30
    """)
    fun getDailySummariesFlow(): Flow<List<DayPlaySummary>>

    @Query("SELECT COUNT(DISTINCT dayKey) FROM listening_events")
    suspend fun getTotalActiveDays(): Int

    @Query("SELECT SUM(listenedSec) FROM listening_events")
    suspend fun getTotalListenedSeconds(): Long?
}

