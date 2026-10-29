package com.musicflow.player.data.local.dao

import androidx.room.*
import com.musicflow.player.data.local.entity.SongEntity
import kotlinx.coroutines.flow.Flow

@Dao
interface SongDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertOrUpdate(song: SongEntity)

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertOrIgnore(song: SongEntity)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertAll(songs: List<SongEntity>)

    @Query("SELECT * FROM songs WHERE id = :id")
    suspend fun getSongById(id: String): SongEntity?

    @Query("SELECT * FROM songs WHERE isFavorite = 1 ORDER BY favoriteAt DESC")
    fun getFavoriteSongsFlow(): Flow<List<SongEntity>>

    @Query("SELECT * FROM songs WHERE isDownloaded = 1 ORDER BY dateAdded DESC")
    fun getDownloadedSongsFlow(): Flow<List<SongEntity>>

    @Query("SELECT * FROM songs WHERE isLocal = 1 ORDER BY title ASC")
    fun getLocalSongsFlow(): Flow<List<SongEntity>>

    @Query("SELECT * FROM songs WHERE playCount > 0 ORDER BY lastPlayedAt DESC LIMIT 50")
    fun getRecentlyPlayedFlow(): Flow<List<SongEntity>>

    @Query("UPDATE songs SET isFavorite = :isFav, favoriteAt = :time WHERE id = :id")
    suspend fun updateFavorite(id: String, isFav: Boolean, time: Long = System.currentTimeMillis())

    @Query("UPDATE songs SET playCount = playCount + 1, lastPlayedAt = :time WHERE id = :id")
    suspend fun recordPlay(id: String, time: Long = System.currentTimeMillis())

    @Query("UPDATE songs SET isDownloaded = :downloaded, localFilePath = :filePath WHERE id = :id")
    suspend fun updateDownloadStatus(id: String, downloaded: Boolean, filePath: String?)

    @Delete
    suspend fun delete(song: SongEntity)

    @Query("DELETE FROM songs WHERE isLocal = 1")
    suspend fun clearLocalSongs()
}

