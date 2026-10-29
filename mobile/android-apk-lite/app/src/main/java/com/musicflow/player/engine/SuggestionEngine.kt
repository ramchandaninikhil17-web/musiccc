package com.musicflow.player.engine

import com.musicflow.player.data.model.Song

data class SuggestionItem(
    val text: String,
    val type: SuggestionType, // HISTORY, ARTIST, SONG, REMOTE
    val song: Song? = null
)

enum class SuggestionType {
    HISTORY,
    ARTIST,
    SONG,
    REMOTE
}

object SuggestionEngine {
    fun cleanArtist(name: String?): String {
        return name?.replace(Regex(" - Topic|VEVO|Official", RegexOption.IGNORE_CASE), "")?.trim() ?: ""
    }

    /**
     * Combines user history, favorites, and remote query suggestions with weighted ranking.
     */
    fun rankSuggestions(
        query: String,
        historyQueries: List<String>,
        favoriteSongs: List<Song>,
        recentSongs: List<Song>,
        remoteSuggestions: List<String>
    ): List<SuggestionItem> {
        val q = query.trim().lowercase()
        val results = mutableListOf<SuggestionItem>()
        val seen = mutableSetOf<String>()

        // 1. History queries matching prefix or containing query
        historyQueries.forEach { h ->
            val hl = h.lowercase()
            if (hl.contains(q) && seen.add(hl)) {
                results.add(SuggestionItem(text = h, type = SuggestionType.HISTORY))
            }
        }

        // 2. Favorite songs & artists (weight = 2x)
        favoriteSongs.forEach { song ->
            val titleL = song.title.lowercase()
            val artistL = cleanArtist(song.artist).lowercase()
            if (titleL.contains(q) && seen.add(titleL)) {
                results.add(SuggestionItem(text = song.title, type = SuggestionType.SONG, song = song))
            }
            if (artistL.contains(q) && seen.add(artistL)) {
                results.add(SuggestionItem(text = cleanArtist(song.artist), type = SuggestionType.ARTIST))
            }
        }

        // 3. Recent songs
        recentSongs.forEach { song ->
            val titleL = song.title.lowercase()
            if (titleL.contains(q) && seen.add(titleL)) {
                results.add(SuggestionItem(text = song.title, type = SuggestionType.SONG, song = song))
            }
        }

        // 4. Remote suggestions from on-device extractor
        remoteSuggestions.forEach { r ->
            val rl = r.lowercase()
            if (seen.add(rl)) {
                results.add(SuggestionItem(text = r, type = SuggestionType.REMOTE))
            }
        }

        return results.take(15)
    }
}

