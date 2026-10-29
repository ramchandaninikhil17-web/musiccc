package com.musicflow.player.data.preferences

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.*
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.map
import java.io.IOException

val Context.dataStore: DataStore<Preferences> by preferencesDataStore(name = "musicflow_settings")

class AppPreferences(private val context: Context) {
    companion object {
        val KEY_ACCENT_COLOR = stringPreferencesKey("accent_color")
        val KEY_THEME_MODE = stringPreferencesKey("theme_mode") // "dark", "amoled", "light"
        val KEY_AUDIO_QUALITY = stringPreferencesKey("audio_quality") // "128", "192", "320"
        val KEY_CROSSFADE_SEC = intPreferencesKey("crossfade_sec") // 0 to 10
        val KEY_GAPLESS_ENABLED = booleanPreferencesKey("gapless_enabled")
        val KEY_LOUDNESS_NORM = booleanPreferencesKey("loudness_norm")
        val KEY_BASS_BOOST = intPreferencesKey("bass_boost") // 0 to 1000
        val KEY_EQ_PRESET = stringPreferencesKey("eq_preset")
        val KEY_EQ_BANDS = stringPreferencesKey("eq_bands") // comma separated 10 floats
        val KEY_AUTO_QUEUE = booleanPreferencesKey("auto_queue")
        val KEY_WIFI_ONLY_DL = booleanPreferencesKey("wifi_only_dl")
        val KEY_RESUME_SONG_ID = stringPreferencesKey("resume_song_id")
        val KEY_RESUME_POS_MS = longPreferencesKey("resume_pos_ms")
        val KEY_AUTO_FIX_SEARCH = booleanPreferencesKey("auto_fix_search")
    }

    val accentColor: Flow<String> = context.dataStore.data.safeMap { it[KEY_ACCENT_COLOR] ?: "indigo" }
    val themeMode: Flow<String> = context.dataStore.data.safeMap { it[KEY_THEME_MODE] ?: "dark" }
    val audioQuality: Flow<String> = context.dataStore.data.safeMap { it[KEY_AUDIO_QUALITY] ?: "192" }
    val crossfadeSec: Flow<Int> = context.dataStore.data.safeMap { it[KEY_CROSSFADE_SEC] ?: 0 }
    val gaplessEnabled: Flow<Boolean> = context.dataStore.data.safeMap { it[KEY_GAPLESS_ENABLED] ?: true }
    val loudnessNorm: Flow<Boolean> = context.dataStore.data.safeMap { it[KEY_LOUDNESS_NORM] ?: false }
    val bassBoost: Flow<Int> = context.dataStore.data.safeMap { it[KEY_BASS_BOOST] ?: 0 }
    val eqPreset: Flow<String> = context.dataStore.data.safeMap { it[KEY_EQ_PRESET] ?: "flat" }
    val eqBands: Flow<String> = context.dataStore.data.safeMap { it[KEY_EQ_BANDS] ?: "0,0,0,0,0,0,0,0,0,0" }
    val autoQueue: Flow<Boolean> = context.dataStore.data.safeMap { it[KEY_AUTO_QUEUE] ?: true }
    val wifiOnlyDl: Flow<Boolean> = context.dataStore.data.safeMap { it[KEY_WIFI_ONLY_DL] ?: false }
    val resumeSongId: Flow<String?> = context.dataStore.data.safeMap { it[KEY_RESUME_SONG_ID] }
    val resumePosMs: Flow<Long> = context.dataStore.data.safeMap { it[KEY_RESUME_POS_MS] ?: 0L }
    val autoFixSearch: Flow<Boolean> = context.dataStore.data.safeMap { it[KEY_AUTO_FIX_SEARCH] ?: true }

    suspend fun setAccentColor(color: String) { context.dataStore.edit { it[KEY_ACCENT_COLOR] = color } }
    suspend fun setThemeMode(mode: String) { context.dataStore.edit { it[KEY_THEME_MODE] = mode } }
    suspend fun setAudioQuality(q: String) { context.dataStore.edit { it[KEY_AUDIO_QUALITY] = q } }
    suspend fun setCrossfadeSec(sec: Int) { context.dataStore.edit { it[KEY_CROSSFADE_SEC] = sec } }
    suspend fun setGaplessEnabled(en: Boolean) { context.dataStore.edit { it[KEY_GAPLESS_ENABLED] = en } }
    suspend fun setLoudnessNorm(en: Boolean) { context.dataStore.edit { it[KEY_LOUDNESS_NORM] = en } }
    suspend fun setBassBoost(value: Int) { context.dataStore.edit { it[KEY_BASS_BOOST] = value } }
    suspend fun setEqPreset(preset: String) { context.dataStore.edit { it[KEY_EQ_PRESET] = preset } }
    suspend fun setEqBands(bandsStr: String) { context.dataStore.edit { it[KEY_EQ_BANDS] = bandsStr } }
    suspend fun setAutoQueue(en: Boolean) { context.dataStore.edit { it[KEY_AUTO_QUEUE] = en } }
    suspend fun setWifiOnlyDl(en: Boolean) { context.dataStore.edit { it[KEY_WIFI_ONLY_DL] = en } }
    suspend fun saveResumeState(songId: String, posMs: Long) {
        context.dataStore.edit {
            it[KEY_RESUME_SONG_ID] = songId
            it[KEY_RESUME_POS_MS] = posMs
        }
    }
}

private fun <T> Flow<Preferences>.safeMap(transform: (Preferences) -> T): Flow<T> {
    return this.catch { e ->
        if (e is IOException) emit(emptyPreferences()) else throw e
    }.map(transform)
}

