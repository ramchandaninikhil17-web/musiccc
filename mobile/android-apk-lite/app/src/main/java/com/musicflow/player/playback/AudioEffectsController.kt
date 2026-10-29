package com.musicflow.player.playback

import android.media.audiofx.BassBoost
import android.media.audiofx.Equalizer
import android.util.Log

class AudioEffectsController {
    private var equalizer: Equalizer? = null
    private var bassBoost: BassBoost? = null
    private var currentAudioSessionId: Int = 0

    val presets = mapOf(
        "flat" to listOf(0, 0, 0, 0, 0),
        "bassboost" to listOf(7, 5, 2, 1, 3),
        "vocal" to listOf(-2, 1, 4, 3, -1),
        "rock" to listOf(5, 2, -1, 3, 5),
        "pop" to listOf(-1, 3, 5, 1, 2),
        "edm" to listOf(7, 4, -1, 4, 6),
        "acoustic" to listOf(3, 2, 2, 3, 3)
    )

    fun attachToAudioSession(audioSessionId: Int) {
        if (audioSessionId == 0 || audioSessionId == currentAudioSessionId) return
        currentAudioSessionId = audioSessionId
        release()

        try {
            equalizer = Equalizer(0, audioSessionId).apply {
                enabled = true
            }
        } catch (e: Exception) {
            Log.w("AudioEffects", "Failed to init Equalizer: ${e.message}")
        }

        try {
            bassBoost = BassBoost(0, audioSessionId).apply {
                enabled = true
            }
        } catch (e: Exception) {
            Log.w("AudioEffects", "Failed to init BassBoost: ${e.message}")
        }
    }

    fun setBassBoostStrength(strength: Int) { // 0 to 1000
        try {
            bassBoost?.setStrength(strength.coerceIn(0, 1000).toShort())
        } catch (_: Exception) {}
    }

    fun applyPreset(presetName: String) {
        val gains = presets[presetName.lowercase()] ?: presets["flat"] ?: return
        val eq = equalizer ?: return
        val numBands = eq.numberOfBands.toInt()
        val minLevel = eq.bandLevelRange[0]
        val maxLevel = eq.bandLevelRange[1]

        gains.forEachIndexed { i, dB ->
            if (i < numBands) {
                val milliBels = (dB * 100).coerceIn(minLevel.toInt(), maxLevel.toInt()).toShort()
                try {
                    eq.setBandLevel(i.toShort(), milliBels)
                } catch (_: Exception) {}
            }
        }
    }

    fun setBandGain(bandIndex: Int, gainDb: Int) {
        val eq = equalizer ?: return
        if (bandIndex < eq.numberOfBands) {
            val minLevel = eq.bandLevelRange[0]
            val maxLevel = eq.bandLevelRange[1]
            val mb = (gainDb * 100).coerceIn(minLevel.toInt(), maxLevel.toInt()).toShort()
            try {
                eq.setBandLevel(bandIndex.toShort(), mb)
            } catch (_: Exception) {}
        }
    }

    fun release() {
        try { equalizer?.release() } catch (_: Exception) {}
        try { bassBoost?.release() } catch (_: Exception) {}
        equalizer = null
        bassBoost = null
    }
}

