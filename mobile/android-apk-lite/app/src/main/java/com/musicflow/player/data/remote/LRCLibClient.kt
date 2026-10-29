package com.musicflow.player.data.remote

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.musicflow.player.data.model.LyricLine
import com.musicflow.player.data.model.Lyrics
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit
import java.util.regex.Pattern

object LRCLibClient {
    private val client = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(8, TimeUnit.SECONDS)
        .build()

    private val gson = Gson()
    private val lrcPattern = Pattern.compile("\\[(\\d{2}):(\\d{2})\\.(\\d{2,3})\\](.*)")

    suspend fun fetchLyrics(songId: String, title: String, artist: String, durationSec: Long): Lyrics? = withContext(Dispatchers.IO) {
        val cleanTitle = cleanSearchTerm(title)
        val cleanArtist = cleanSearchTerm(artist)

        // 1. Try exact match by title and artist
        try {
            val url = "https://lrclib.net/api/get?track_name=${java.net.URLEncoder.encode(cleanTitle, "UTF-8")}&artist_name=${java.net.URLEncoder.encode(cleanArtist, "UTF-8")}&duration=$durationSec"
            val req = Request.Builder()
                .url(url)
                .header("User-Agent", "MusicFlow/3.5 (Android)")
                .build()
            client.newCall(req).execute().use { resp ->
                if (resp.isSuccessful) {
                    val body = resp.body?.string()
                    if (!body.isNullOrBlank()) {
                        val obj = gson.fromJson(body, JsonObject::class.java)
                        val syncedLyrics = obj.get("syncedLyrics")?.asString
                        val plainLyrics = obj.get("plainLyrics")?.asString ?: ""
                        if (!syncedLyrics.isNullOrBlank()) {
                            return@withContext parseLrc(songId, syncedLyrics, plainLyrics)
                        } else if (plainLyrics.isNotBlank()) {
                            return@withContext Lyrics(songId = songId, isSynced = false, plainLyrics = plainLyrics)
                        }
                    }
                }
            }
        } catch (_: Exception) {}

        // 2. Fallback: Search endpoint
        try {
            val query = "$cleanTitle $cleanArtist".trim()
            val searchUrl = "https://lrclib.net/api/search?q=${java.net.URLEncoder.encode(query, "UTF-8")}"
            val req = Request.Builder()
                .url(searchUrl)
                .header("User-Agent", "MusicFlow/3.5 (Android)")
                .build()
            client.newCall(req).execute().use { resp ->
                if (resp.isSuccessful) {
                    val body = resp.body?.string()
                    if (!body.isNullOrBlank()) {
                        val arr = gson.fromJson(body, com.google.gson.JsonArray::class.java)
                        if (arr != null && arr.size() > 0) {
                            val first = arr.get(0).asJsonObject
                            val syncedLyrics = first.get("syncedLyrics")?.asString
                            val plainLyrics = first.get("plainLyrics")?.asString ?: ""
                            if (!syncedLyrics.isNullOrBlank()) {
                                return@withContext parseLrc(songId, syncedLyrics, plainLyrics)
                            } else if (plainLyrics.isNotBlank()) {
                                return@withContext Lyrics(songId = songId, isSynced = false, plainLyrics = plainLyrics)
                            }
                        }
                    }
                }
            }
        } catch (_: Exception) {}

        null
    }

    private fun parseLrc(songId: String, lrcText: String, plainLyrics: String): Lyrics {
        val lines = mutableListOf<LyricLine>()
        lrcText.lines().forEach { line ->
            val matcher = lrcPattern.matcher(line.trim())
            if (matcher.matches()) {
                val min = matcher.group(1)?.toLongOrNull() ?: 0L
                val sec = matcher.group(2)?.toLongOrNull() ?: 0L
                val fracStr = matcher.group(3) ?: "00"
                val frac = if (fracStr.length == 2) fracStr.toLong() * 10 else fracStr.toLong()
                val timestampMs = (min * 60 + sec) * 1000 + frac
                val text = matcher.group(4)?.trim() ?: ""
                if (text.isNotEmpty()) {
                    lines.add(LyricLine(timestampMs, text))
                }
            }
        }
        lines.sortBy { it.timestampMs }
        return Lyrics(
            songId = songId,
            isSynced = lines.isNotEmpty(),
            lines = lines,
            plainLyrics = plainLyrics.ifBlank { lines.joinToString("\n") { it.text } }
        )
    }

    private fun cleanSearchTerm(term: String): String {
        return term
            .replace(Regex("\\[.*?\\]|\\(.*?\\)"), "")
            .replace(Regex("Official Video|Lyrics|Audio|Remastered|HD|4K", RegexOption.IGNORE_CASE), "")
            .trim()
    }
}

