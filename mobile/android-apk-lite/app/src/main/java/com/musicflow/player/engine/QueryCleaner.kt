package com.musicflow.player.engine

object QueryCleaner {
    private val corrections = mapOf(
        "arjit" to "arijit", "arjit singh" to "arijit singh", "arjith" to "arijit",
        "emimem" to "eminem", "eminam" to "eminem", "emniem" to "eminem",
        "bts" to "BTS", "blackpink" to "BLACKPINK",
        "coldpaly" to "coldplay", "codplay" to "coldplay",
        "imagin dragons" to "imagine dragons", "imgaine dragons" to "imagine dragons",
        "ed sheran" to "ed sheeran", "ed sheeren" to "ed sheeran", "ed sheerin" to "ed sheeran",
        "tayler swift" to "taylor swift", "talor swift" to "taylor swift",
        "billie eilsh" to "billie eilish", "billie elish" to "billie eilish",
        "weeknd" to "the weeknd", "wekknd" to "the weeknd",
        "marron 5" to "maroon 5", "marroon 5" to "maroon 5",
        "linkin park" to "linkin park", "linken park" to "linkin park", "linkn park" to "linkin park",
        "beyonce" to "beyoncé", "beyonc" to "beyoncé",
        "rhianna" to "rihanna", "riahna" to "rihanna",
        "adelle" to "adele",
        "arianna grande" to "ariana grande", "ariana grand" to "ariana grande",
        "jutin bieber" to "justin bieber", "justine bieber" to "justin bieber", "justin beiber" to "justin bieber",
        "selena gomaz" to "selena gomez", "selna gomez" to "selena gomez",
        "shawn mendes" to "shawn mendes", "shaun mendes" to "shawn mendes",
        "dua lipa" to "dua lipa", "dua lippa" to "dua lipa",
        "bad buny" to "bad bunny", "bad banny" to "bad bunny",
        "the chainsmoker" to "the chainsmokers", "chainsmoker" to "the chainsmokers",
        "marshmello" to "marshmello", "marshmallow dj" to "marshmello",
        "post malon" to "post malone",
        "kayne west" to "kanye west", "kanye" to "kanye west",
        "neha kakker" to "neha kakkar", "neha kakar" to "neha kakkar",
        "atif aslm" to "atif aslam", "aatif aslam" to "atif aslam",
        "shreya ghosal" to "shreya ghoshal", "shreya goshal" to "shreya ghoshal",
        "pritam" to "pritam", "preetam" to "pritam",
        "ar rehman" to "a.r. rahman", "ar rahman" to "a.r. rahman",
        "honey sing" to "honey singh", "yo yo honey" to "yo yo honey singh",
        "badshaah" to "badshah", "baadshah singer" to "badshah",
        "favourit" to "favorite", "favourites" to "favorites",
        "musci" to "music", "muisc" to "music", "muscic" to "music",
        "snog" to "song", "snogs" to "songs", "sonds" to "songs",
        "bollwood" to "bollywood", "bolywood" to "bollywood",
        "playlis" to "playlist", "plalist" to "playlist",
        "romanitc" to "romantic", "romanic" to "romantic",
        "acustic" to "acoustic", "accoustic" to "acoustic",
        "instramental" to "instrumental", "instrumetal" to "instrumental",
        "unpluged" to "unplugged", "unplgged" to "unplugged",
        "lates" to "latest", "latset" to "latest",
        "tredning" to "trending", "trendig" to "trending"
    )

    fun clean(query: String?): String {
        if (query.isNullOrBlank()) return ""
        val trimmed = query.trim().replace(Regex("\\s+"), " ")
        val lower = trimmed.lowercase()
        val isFirstUpper = trimmed.isNotEmpty() && trimmed[0].isUpperCase()

        // 1. Exact match
        corrections[lower]?.let {
            return if (isFirstUpper) it.replaceFirstChar { c -> c.uppercase() } else it
        }

        // 2. Word-by-word replacement
        val words = trimmed.split(" ")
        val fixedWords = words.map { word ->
            val wLower = word.lowercase()
            val fixed = corrections[wLower]
            if (fixed != null && !fixed.contains(" ")) {
                if (word.isNotEmpty() && word[0].isUpperCase()) {
                    fixed.replaceFirstChar { it.uppercase() }
                } else fixed
            } else {
                word
            }
        }
        return fixedWords.joinToString(" ")
    }
}

