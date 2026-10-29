package com.musicflow.player.engine

data class MoodCategory(
    val id: String,
    val name: String,
    val emoji: String,
    val queries: List<String>
)

data class ActivityCategory(
    val id: String,
    val name: String,
    val emoji: String,
    val queries: List<String>
)

object MoodFlowEngine {
    val moods = listOf(
        MoodCategory("happy", "Happy & Upbeat", "☀️", listOf("happy upbeat feel good songs", "feel good pop music", "positive vibes playlist")),
        MoodCategory("chill", "Chill & Relax", "☕", listOf("chill relaxing lofi beats", "calm acoustic vibes", "mellow indie coffee shop")),
        MoodCategory("energetic", "Gym & Hype", "⚡", listOf("gym workout motivation beats", "high energy phonk beast mode", "pump up workout songs")),
        MoodCategory("focus", "Deep Focus", "🧠", listOf("deep focus study music instrumental", "ambient coding beats no lyrics", "alpha waves concentration")),
        MoodCategory("romantic", "Romantic Love", "❤️", listOf("romantic acoustic love songs", "late night romantic hindi songs", "love ballads playlist")),
        MoodCategory("party", "Party Dance", "🪩", listOf("club party dance hits", "top edm festival bangers", "punjabi party dance music")),
        MoodCategory("sad", "Sad & Heartbreak", "🌧️", listOf("sad emotional heartbreak songs", "slow acoustic sad ballads", "melancholy indie songs")),
        MoodCategory("sleep", "Calm Sleep", "🌙", listOf("peaceful sleep ambient music", "deep sleep soundscape rain", "calm night piano")),
        MoodCategory("nostalgia", "Retro Nostalgia", "📻", listOf("90s golden hits playlist", "retro classic rock anthems", "2000s nostalgic love songs"))
    )

    val activities = listOf(
        ActivityCategory("workout", "Workout", "🏋️", listOf("gym workout music", "running motivation")),
        ActivityCategory("coding", "Coding & Study", "💻", listOf("coding music beats", "study lo-fi instrumental")),
        ActivityCategory("driving", "Night Drive", "🚗", listOf("night driving synthwave songs", "road trip playlist")),
        ActivityCategory("morning", "Morning Routine", "🌅", listOf("morning acoustic vibes", "sunny morning breakfast music")),
        ActivityCategory("meditation", "Meditation", "🧘", listOf("mindful ambient meditation", "tibetan singing bowls peace")),
        ActivityCategory("gaming", "Gaming", "🎮", listOf("gaming electronic bass music", "speed run cyberpunk beats"))
    )

    val surprisePrompts = listOf(
        "Late night Hindi romantic acoustic songs",
        "90s rock ballads for long road trips",
        "High energy gym phonk and beast mode beats",
        "Calm acoustic guitar indie coffee shop morning",
        "Top trending Punjabi party dance hits",
        "Deep focus instrumental study and coding beats",
        "Taylor Swift and Sabrina Carpenter emotional pop",
        "Chill lofi hip hop beats with gentle rainfall",
        "2000s Bollywood nostalgic love anthems",
        "Club dance electronic synthwave and EDM festival"
    )

    fun buildQuery(moodId: String?, activityId: String?, customPrompt: String?): String {
        if (!customPrompt.isNullOrBlank()) return customPrompt.trim()
        val m = moods.find { it.id == moodId }
        val a = activities.find { it.id == activityId }

        return when {
            m != null && a != null -> "${m.queries.random()} ${a.queries.random()}"
            m != null -> m.queries.random()
            a != null -> a.queries.random()
            else -> surprisePrompts.random()
        }
    }
}

