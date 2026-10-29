package com.musicflow.player.playback

import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

class SleepTimerManager(private val onTimerFinished: () -> Unit) {
    private var job: Job? = null
    private val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())

    private val _remainingSeconds = MutableStateFlow<Long?>(null)
    val remainingSeconds: StateFlow<Long?> = _remainingSeconds.asStateFlow()

    var isEndOfTrackMode: Boolean = false
        private set

    fun startTimerMinutes(minutes: Int) {
        cancel()
        if (minutes <= 0) return
        isEndOfTrackMode = false
        val totalSec = minutes * 60L
        _remainingSeconds.value = totalSec

        job = scope.launch {
            var left = totalSec
            while (left > 0) {
                delay(1000L)
                left--
                _remainingSeconds.value = left
            }
            _remainingSeconds.value = null
            onTimerFinished()
        }
    }

    fun setEndOfCurrentTrack() {
        cancel()
        isEndOfTrackMode = true
        _remainingSeconds.value = -1L // Special marker for "End of Track"
    }

    fun onTrackFinished() {
        if (isEndOfTrackMode) {
            cancel()
            onTimerFinished()
        }
    }

    fun cancel() {
        job?.cancel()
        job = null
        isEndOfTrackMode = false
        _remainingSeconds.value = null
    }
}

