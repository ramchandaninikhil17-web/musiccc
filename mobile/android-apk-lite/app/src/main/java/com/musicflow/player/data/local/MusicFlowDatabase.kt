package com.musicflow.player.data.local

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import com.musicflow.player.data.local.dao.ListeningStatsDao
import com.musicflow.player.data.local.dao.PlaylistDao
import com.musicflow.player.data.local.dao.SearchHistoryDao
import com.musicflow.player.data.local.dao.SongDao
import com.musicflow.player.data.local.entity.ListeningEventEntity
import com.musicflow.player.data.local.entity.PlaylistEntity
import com.musicflow.player.data.local.entity.PlaylistSongCrossRef
import com.musicflow.player.data.local.entity.SearchHistoryEntity
import com.musicflow.player.data.local.entity.SongEntity

@Database(
    entities = [
        SongEntity::class,
        PlaylistEntity::class,
        PlaylistSongCrossRef::class,
        ListeningEventEntity::class,
        SearchHistoryEntity::class
    ],
    version = 1,
    exportSchema = false
)
abstract class MusicFlowDatabase : RoomDatabase() {
    abstract fun songDao(): SongDao
    abstract fun playlistDao(): PlaylistDao
    abstract fun listeningStatsDao(): ListeningStatsDao
    abstract fun searchHistoryDao(): SearchHistoryDao

    companion object {
        @Volatile
        private var INSTANCE: MusicFlowDatabase? = null

        fun getInstance(context: Context): MusicFlowDatabase {
            return INSTANCE ?: synchronized(this) {
                val instance = Room.databaseBuilder(
                    context.applicationContext,
                    MusicFlowDatabase::class.java,
                    "musicflow_native.db"
                )
                    .fallbackToDestructiveMigration()
                    .build()
                INSTANCE = instance
                instance
            }
        }
    }
}

