package com.musicflow.player

import com.musicflow.player.data.model.Song
import com.musicflow.player.engine.MoodFlowEngine
import com.musicflow.player.engine.QueryCleaner
import com.musicflow.player.engine.SuggestionEngine
import com.musicflow.player.engine.SuggestionType
import org.junit.Assert.*
import org.junit.Test

class EngineTests {

    @Test
    fun testQueryCleaner_artistTypoFixes() {
        assertEquals("arijit", QueryCleaner.clean("arjit"))
        assertEquals("arijit singh", QueryCleaner.clean("arjit singh"))
        assertEquals("eminem", QueryCleaner.clean("emimem"))
        assertEquals("the weeknd", QueryCleaner.clean("weeknd"))
        assertEquals("coldplay", QueryCleaner.clean("coldpaly"))
        assertEquals("ed sheeran", QueryCleaner.clean("ed sheran"))
    }

    @Test
    fun testQueryCleaner_preservesCasing() {
        assertEquals("Arijit", QueryCleaner.clean("Arjit"))
        assertEquals("Eminem", QueryCleaner.clean("Emimem"))
    }

    @Test
    fun testQueryCleaner_wordFixes() {
        assertEquals("favorite", QueryCleaner.clean("favourit"))
        assertEquals("song", QueryCleaner.clean("snog"))
        assertEquals("songs", QueryCleaner.clean("snogs"))
        assertEquals("playlist", QueryCleaner.clean("playlis"))
    }

    @Test
    fun testSuggestionEngine_cleanArtist() {
        assertEquals("The Weeknd", SuggestionEngine.cleanArtist("The Weeknd - Topic"))
        assertEquals("Taylor Swift", SuggestionEngine.cleanArtist("Taylor SwiftVEVO"))
        assertEquals("Ed Sheeran", SuggestionEngine.cleanArtist("Ed Sheeran Official"))
    }

    @Test
    fun testSuggestionEngine_rankSuggestions() {
        val favSong = Song(id = "1", title = "Yellow", artist = "Coldplay")
        val recentSong = Song(id = "2", title = "Viva La Vida", artist = "Coldplay")
        val history = listOf("yellow coldplay live")
        val remote = listOf("yellow lyrics", "yellow submarine")

        val results = SuggestionEngine.rankSuggestions(
            query = "yel",
            historyQueries = history,
            favoriteSongs = listOf(favSong),
            recentSongs = listOf(recentSong),
            remoteSuggestions = remote
        )

        assertTrue(results.isNotEmpty())
        assertEquals("yellow coldplay live", results[0].text)
        assertEquals(SuggestionType.HISTORY, results[0].type)
        assertEquals("Yellow", results[1].text)
        assertEquals(SuggestionType.SONG, results[1].type)
    }

    @Test
    fun testMoodFlowEngine_buildQuery() {
        val happyQuery = MoodFlowEngine.buildQuery("happy", null, null)
        assertTrue(happyQuery.isNotBlank())

        val customQuery = MoodFlowEngine.buildQuery(null, null, "Rainy cafe jazz")
        assertEquals("Rainy cafe jazz", customQuery)
    }
}

