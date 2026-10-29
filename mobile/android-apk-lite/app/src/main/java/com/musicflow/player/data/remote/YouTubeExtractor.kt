package com.musicflow.player.data.remote

import android.util.Log
import com.google.gson.Gson
import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.musicflow.player.data.model.Song
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.net.URLEncoder
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

object YouTubeExtractor {
    private const val TAG = "YouTubeExtractor"
    private val client = OkHttpClient.Builder()
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .build()

    private val gson = Gson()
    private val streamCache = ConcurrentHashMap<String, Pair<String, Long>>() // id -> (url, expiry)
    private val CACHE_DURATION_MS = 4 * 60 * 60 * 1000L // 4 hours

    /**
     * Search YouTube for songs with metadata, thumbnails, duration
     */
    suspend fun search(query: String): List<Song> = withContext(Dispatchers.IO) {
        if (query.isBlank()) return@withContext emptyList()

        // 1. Try YouTube InnerTube Android Music Search
        try {
            val songs = searchInnerTube(query)
            if (songs.isNotEmpty()) return@withContext songs
        } catch (e: Exception) {
            Log.w(TAG, "InnerTube search failed: ${e.message}")
        }

        // 2. Fallback: Piped API
        try {
            val songs = searchPiped(query)
            if (songs.isNotEmpty()) return@withContext songs
        } catch (e: Exception) {
            Log.w(TAG, "Piped search failed: ${e.message}")
        }

        emptyList()
    }

    /**
     * Resolve stream URL for a given YouTube Video ID
     */
    suspend fun getStreamUrl(videoId: String, quality: String = "192"): String? = withContext(Dispatchers.IO) {
        val cached = streamCache[videoId]
        if (cached != null && System.currentTimeMillis() < cached.second) {
            return@withContext cached.first
        }

        // 1. Try InnerTube Player API with Android client context
        try {
            val url = resolveInnerTubeStream(videoId, quality)
            if (!url.isNullOrBlank()) {
                streamCache[videoId] = Pair(url, System.currentTimeMillis() + CACHE_DURATION_MS)
                return@withContext url
            }
        } catch (e: Exception) {
            Log.w(TAG, "InnerTube stream resolve failed: ${e.message}")
        }

        // 2. Fallback: Piped Streams
        try {
            val url = resolvePipedStream(videoId)
            if (!url.isNullOrBlank()) {
                streamCache[videoId] = Pair(url, System.currentTimeMillis() + CACHE_DURATION_MS)
                return@withContext url
            }
        } catch (e: Exception) {
            Log.w(TAG, "Piped stream resolve failed: ${e.message}")
        }

        null
    }

    /**
     * Instant search suggestions via Google Suggestion API
     */
    suspend fun getSuggestions(query: String): List<String> = withContext(Dispatchers.IO) {
        if (query.isBlank()) return@withContext emptyList()
        try {
            val url = "https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=${URLEncoder.encode(query, "UTF-8")}"
            val req = Request.Builder().url(url).build()
            client.newCall(req).execute().use { resp ->
                if (resp.isSuccessful) {
                    val body = resp.body?.string() ?: return@withContext emptyList()
                    val arr = gson.fromJson(body, JsonArray::class.java)
                    if (arr.size() > 1 && arr.get(1).isJsonArray) {
                        val suggestions = mutableListOf<String>()
                        arr.get(1).asJsonArray.forEach { elem ->
                            suggestions.add(elem.asString)
                        }
                        return@withContext suggestions
                    }
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Suggestions error: ${e.message}")
        }
        emptyList()
    }

    /**
     * Get auto-queue / related tracks for radio mode
     */
    suspend fun getRelatedTracks(videoId: String): List<Song> = withContext(Dispatchers.IO) {
        try {
            val songs = getPipedRelated(videoId)
            if (songs.isNotEmpty()) return@withContext songs
        } catch (_: Exception) {}

        // Fallback: search with video title
        emptyList()
    }

    // -------------------------------------------------------------
    // InnerTube API Implementation
    // -------------------------------------------------------------
    private fun searchInnerTube(query: String): List<Song> {
        val jsonPayload = """
            {
                "context": {
                    "client": {
                        "clientName": "ANDROID",
                        "clientVersion": "19.09.37",
                        "androidSdkVersion": 34,
                        "hl": "en",
                        "gl": "US"
                    }
                },
                "query": ${gson.toJson(query)}
            }
        """.trimIndent()

        val req = Request.Builder()
            .url("https://www.youtube.com/youtubei/v1/search")
            .header("User-Agent", "com.google.android.youtube/19.09.37 (Linux; U; Android 14)")
            .header("X-YouTube-Client-Name", "3")
            .header("X-YouTube-Client-Version", "19.09.37")
            .post(jsonPayload.toRequestBody("application/json".toMediaType()))
            .build()

        client.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) return emptyList()
            val root = gson.fromJson(resp.body?.string(), JsonObject::class.java) ?: return emptyList()
            val list = mutableListOf<Song>()

            val contents = root.getAsJsonObject("contents")
                ?.getAsJsonObject("twoColumnSearchResultsRenderer")
                ?.getAsJsonObject("primaryContents")
                ?.getAsJsonObject("sectionListRenderer")
                ?.getAsJsonArray("contents")
                ?.get(0)?.asJsonObject
                ?.getAsJsonObject("itemSectionRenderer")
                ?.getAsJsonArray("contents")

            contents?.forEach { item ->
                val v = item.asJsonObject.getAsJsonObject("videoRenderer") ?: return@forEach
                val id = v.get("videoId")?.asString ?: return@forEach
                val title = v.getAsJsonObject("title")?.getAsJsonArray("runs")?.get(0)?.asJsonObject?.get("text")?.asString ?: "Unknown Track"
                val artist = v.getAsJsonObject("ownerText")?.getAsJsonArray("runs")?.get(0)?.asJsonObject?.get("text")?.asString ?: "Artist"
                val durText = v.getAsJsonObject("lengthText")?.get("simpleText")?.asString ?: "0:00"
                val duration = parseDurationString(durText)

                val thumb = "https://i.ytimg.com/vi/$id/hqdefault.jpg"
                list.add(Song(id = id, title = title, artist = artist, duration = duration, thumbnail = thumb))
            }

            return list
        }
    }

    private fun resolveInnerTubeStream(videoId: String, quality: String): String? {
        val jsonPayload = """
            {
                "context": {
                    "client": {
                        "clientName": "ANDROID",
                        "clientVersion": "19.09.37",
                        "androidSdkVersion": 34
                    }
                },
                "videoId": "$videoId"
            }
        """.trimIndent()

        val req = Request.Builder()
            .url("https://www.youtube.com/youtubei/v1/player")
            .header("User-Agent", "com.google.android.youtube/19.09.37 (Linux; U; Android 14)")
            .header("X-YouTube-Client-Name", "3")
            .header("X-YouTube-Client-Version", "19.09.37")
            .post(jsonPayload.toRequestBody("application/json".toMediaType()))
            .build()

        client.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) return null
            val root = gson.fromJson(resp.body?.string(), JsonObject::class.java) ?: return null
            val streamingData = root.getAsJsonObject("streamingData") ?: return null

            // Check adaptive formats for highest quality audio
            var bestAudioUrl: String? = null
            var bestBitrate = 0

            val formats = streamingData.getAsJsonArray("adaptiveFormats")
            formats?.forEach { f ->
                val obj = f.asJsonObject
                val mime = obj.get("mimeType")?.asString ?: ""
                val url = obj.get("url")?.asString
                val bitrate = obj.get("bitrate")?.asInt ?: 0

                if (mime.startsWith("audio/") && !url.isNullOrBlank()) {
                    if (bitrate > bestBitrate) {
                        bestBitrate = bitrate
                        bestAudioUrl = url
                    }
                }
            }

            return bestAudioUrl
        }
    }

    // -------------------------------------------------------------
    // Piped Fallback Implementation
    // -------------------------------------------------------------
    private val pipedInstances = listOf("https://pipedapi.kavin.rocks", "https://api.piped.privacydev.net")

    private fun searchPiped(query: String): List<Song> {
        val instance = pipedInstances[0]
        val url = "$instance/search?q=${URLEncoder.encode(query, "UTF-8")}&filter=music_songs"
        val req = Request.Builder().url(url).build()

        client.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) return emptyList()
            val root = gson.fromJson(resp.body?.string(), JsonObject::class.java) ?: return emptyList()
            val items = root.getAsJsonArray("items") ?: return emptyList()
            val songs = mutableListOf<Song>()

            items.forEach { elem ->
                val obj = elem.asJsonObject
                val urlPath = obj.get("url")?.asString ?: ""
                val id = urlPath.replace("/watch?v=", "")
                val title = obj.get("title")?.asString ?: "Unknown Title"
                val artist = obj.get("uploaderName")?.asString ?: "Unknown Artist"
                val duration = obj.get("duration")?.asLong ?: 0L
                val thumb = obj.get("thumbnail")?.asString ?: "https://i.ytimg.com/vi/$id/hqdefault.jpg"

                if (id.length == 11) {
                    songs.add(Song(id = id, title = title, artist = artist, duration = duration, thumbnail = thumb))
                }
            }
            return songs
        }
    }

    private fun resolvePipedStream(videoId: String): String? {
        for (instance in pipedInstances) {
            try {
                val url = "$instance/streams/$videoId"
                val req = Request.Builder().url(url).build()
                client.newCall(req).execute().use { resp ->
                    if (resp.isSuccessful) {
                        val root = gson.fromJson(resp.body?.string(), JsonObject::class.java)
                        val audioStreams = root?.getAsJsonArray("audioStreams")
                        if (audioStreams != null && audioStreams.size() > 0) {
                            var bestUrl: String? = null
                            var bestBitrate = 0
                            audioStreams.forEach { s ->
                                val obj = s.asJsonObject
                                val streamUrl = obj.get("url")?.asString
                                val bitrate = obj.get("bitrate")?.asInt ?: 0
                                if (!streamUrl.isNullOrBlank() && bitrate > bestBitrate) {
                                    bestBitrate = bitrate
                                    bestUrl = streamUrl
                                }
                            }
                            if (bestUrl != null) return bestUrl
                        }
                    }
                }
            } catch (_: Exception) {}
        }
        return null
    }

    private fun getPipedRelated(videoId: String): List<Song> {
        val instance = pipedInstances[0]
        val url = "$instance/streams/$videoId"
        val req = Request.Builder().url(url).build()
        client.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) return emptyList()
            val root = gson.fromJson(resp.body?.string(), JsonObject::class.java) ?: return emptyList()
            val related = root.getAsJsonArray("relatedStreams") ?: return emptyList()
            val songs = mutableListOf<Song>()
            related.forEach { r ->
                val obj = r.asJsonObject
                val urlPath = obj.get("url")?.asString ?: ""
                val id = urlPath.replace("/watch?v=", "")
                if (id.length == 11) {
                    songs.add(
                        Song(
                            id = id,
                            title = obj.get("title")?.asString ?: "Track",
                            artist = obj.get("uploaderName")?.asString ?: "Artist",
                            duration = obj.get("duration")?.asLong ?: 0L,
                            thumbnail = obj.get("thumbnail")?.asString ?: "https://i.ytimg.com/vi/$id/hqdefault.jpg"
                        )
                    )
                }
            }
            return songs
        }
    }

    private fun parseDurationString(text: String): Long {
        val parts = text.split(":")
        return when (parts.size) {
            2 -> (parts[0].toLongOrNull() ?: 0L) * 60 + (parts[1].toLongOrNull() ?: 0L)
            3 -> (parts[0].toLongOrNull() ?: 0L) * 3600 + (parts[1].toLongOrNull() ?: 0L) * 60 + (parts[2].toLongOrNull() ?: 0L)
            else -> 0L
        }
    }
}

