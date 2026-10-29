package com.musicflow.player.data.worker

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import android.os.Environment
import androidx.core.app.NotificationCompat
import androidx.work.CoroutineWorker
import androidx.work.ForegroundInfo
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import com.musicflow.player.data.local.MusicFlowDatabase
import com.musicflow.player.data.local.entity.SongEntity
import com.musicflow.player.data.remote.YouTubeExtractor
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.TimeUnit

class DownloadWorker(
    private val context: Context,
    workerParams: WorkerParameters
) : CoroutineWorker(context, workerParams) {

    private val notificationManager =
        context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    companion object {
        const val CHANNEL_ID = "musicflow_downloads"
        const val KEY_SONG_ID = "song_id"
        const val KEY_TITLE = "title"
        const val KEY_ARTIST = "artist"
        const val KEY_FORMAT = "format"
        const val KEY_QUALITY = "quality"
        const val KEY_THUMB = "thumbnail"
        const val KEY_DURATION = "duration"
    }

    override suspend fun doWork(): Result {
        val songId = inputData.getString(KEY_SONG_ID) ?: return Result.failure()
        val title = inputData.getString(KEY_TITLE) ?: "Track"
        val artist = inputData.getString(KEY_ARTIST) ?: "Artist"
        val format = inputData.getString(KEY_FORMAT) ?: "audio"
        val quality = inputData.getString(KEY_QUALITY) ?: "192"
        val thumb = inputData.getString(KEY_THUMB) ?: ""
        val duration = inputData.getLong(KEY_DURATION, 0L)

        createNotificationChannel()
        val notifId = songId.hashCode()

        setForeground(createForegroundInfo(notifId, title, 0))

        val streamUrl = YouTubeExtractor.getStreamUrl(songId, quality) ?: return Result.retry()

        val isVideo = format == "video"
        val ext = if (isVideo) "mp4" else "mp3"
        val safeName = "${title.replace(Regex("[^a-zA-Z0-9.-]"), "_")}_$songId.$ext"

        val dir = if (isVideo) {
            context.getExternalFilesDir(Environment.DIRECTORY_MOVIES) ?: context.filesDir
        } else {
            context.getExternalFilesDir(Environment.DIRECTORY_MUSIC) ?: context.filesDir
        }

        val targetFile = File(dir, safeName)

        val client = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .build()

        return try {
            val req = Request.Builder().url(streamUrl).build()
            client.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) return Result.retry()
                val body = resp.body ?: return Result.retry()
                val totalBytes = body.contentLength()

                body.byteStream().use { input ->
                    FileOutputStream(targetFile).use { output ->
                        val buffer = ByteArray(8 * 1024)
                        var bytesRead: Int
                        var downloadedBytes = 0L
                        var lastProgressUpdate = System.currentTimeMillis()

                        while (input.read(buffer).also { bytesRead = it } != -1) {
                            output.write(buffer, 0, bytesRead)
                            downloadedBytes += bytesRead

                            val now = System.currentTimeMillis()
                            if (totalBytes > 0 && now - lastProgressUpdate > 500) {
                                lastProgressUpdate = now
                                val progress = ((downloadedBytes * 100) / totalBytes).toInt()
                                setProgress(workDataOf("progress" to progress))
                                notificationManager.notify(
                                    notifId,
                                    buildNotification(title, progress).build()
                                )
                            }
                        }
                    }
                }
            }

            // Save download state in Room Database
            val db = MusicFlowDatabase.getInstance(context)
            val existing = db.songDao().getSongById(songId)
            val entity = existing?.copy(
                isDownloaded = true,
                localFilePath = targetFile.absolutePath
            ) ?: SongEntity(
                id = songId,
                title = title,
                artist = artist,
                duration = duration,
                thumbnail = thumb,
                isDownloaded = true,
                localFilePath = targetFile.absolutePath
            )
            db.songDao().insertOrUpdate(entity)

            // Final notification
            val completeNotif = NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setContentTitle("Download Complete")
                .setContentText("$title ($artist)")
                .setAutoCancel(true)
                .build()
            notificationManager.notify(notifId, completeNotif)

            Result.success()
        } catch (e: Exception) {
            Result.retry()
        }
    }

    private fun createForegroundInfo(id: Int, title: String, progress: Int): ForegroundInfo {
        return ForegroundInfo(id, buildNotification(title, progress).build())
    }

    private fun buildNotification(title: String, progress: Int): NotificationCompat.Builder {
        return NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle("Downloading $title")
            .setContentText("$progress%")
            .setProgress(100, progress, progress == 0)
            .setOngoing(true)
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Media Downloads",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Shows progress for music and video downloads"
            }
            notificationManager.createNotificationChannel(channel)
        }
    }
}

