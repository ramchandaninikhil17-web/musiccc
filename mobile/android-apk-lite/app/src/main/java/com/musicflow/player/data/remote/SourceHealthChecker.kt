package com.musicflow.player.data.remote

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

data class SourceHealth(
    val sourceName: String,
    val isAvailable: Boolean,
    val latencyMs: Long,
    val details: String
)

object SourceHealthChecker {
    private val client = OkHttpClient.Builder()
        .connectTimeout(4, TimeUnit.SECONDS)
        .readTimeout(4, TimeUnit.SECONDS)
        .build()

    suspend fun checkAllSources(): List<SourceHealth> = withContext(Dispatchers.IO) {
        val list = mutableListOf<SourceHealth>()

        // 1. YouTube InnerTube
        list.add(testEndpoint("YouTube InnerTube (Direct)", "https://www.youtube.com"))

        // 2. Google Suggest
        list.add(testEndpoint("Google Suggestion API", "https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=music"))

        // 3. LRCLIB Synced Lyrics
        list.add(testEndpoint("LRCLIB (Synced Lyrics)", "https://lrclib.net/api/search?q=test"))

        // 4. Piped Fallback
        list.add(testEndpoint("Piped API (Fallback)", "https://pipedapi.kavin.rocks"))

        list
    }

    private fun testEndpoint(name: String, url: String): SourceHealth {
        val start = System.currentTimeMillis()
        return try {
            val req = Request.Builder().url(url).build()
            client.newCall(req).execute().use { resp ->
                val latency = System.currentTimeMillis() - start
                if (resp.isSuccessful) {
                    SourceHealth(name, true, latency, "Operational (${resp.code})")
                } else {
                    SourceHealth(name, false, latency, "HTTP ${resp.code}")
                }
            }
        } catch (e: Exception) {
            val latency = System.currentTimeMillis() - start
            SourceHealth(name, false, latency, e.message ?: "Connection Timeout")
        }
    }
}

