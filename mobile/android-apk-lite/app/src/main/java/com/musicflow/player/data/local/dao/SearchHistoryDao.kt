package com.musicflow.player.data.local.dao

import androidx.room.*
import com.musicflow.player.data.local.entity.SearchHistoryEntity
import kotlinx.coroutines.flow.Flow

@Dao
interface SearchHistoryDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertQuery(entry: SearchHistoryEntity)

    @Query("SELECT * FROM search_history ORDER BY timestamp DESC LIMIT 20")
    fun getRecentSearchesFlow(): Flow<List<SearchHistoryEntity>>

    @Delete
    suspend fun deleteQuery(entry: SearchHistoryEntity)

    @Query("DELETE FROM search_history")
    suspend fun clearAll()
}

