package com.musicflow.player.voice

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import com.musicflow.player.engine.MoodFlowEngine
import com.musicflow.player.playback.PlaybackManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.util.Locale

enum class VoiceState {
    IDLE,
    LISTENING,
    PROCESSING,
    SPEAKING,
    ERROR
}

class VoiceAssistantManager(
    private val context: Context,
    private val playbackManager: PlaybackManager,
    private val onExecuteSearch: (String) -> Unit
) : RecognitionListener {

    private val scope = CoroutineScope(Dispatchers.Main)
    private var speechRecognizer: SpeechRecognizer? = null

    private val _voiceState = MutableStateFlow(VoiceState.IDLE)
    val voiceState: StateFlow<VoiceState> = _voiceState.asStateFlow()

    private val _lastTranscript = MutableStateFlow("")
    val lastTranscript: StateFlow<String> = _lastTranscript.asStateFlow()

    private val _assistantReply = MutableStateFlow("")
    val assistantReply: StateFlow<String> = _assistantReply.asStateFlow()

    val isAvailable: Boolean = SpeechRecognizer.isRecognitionAvailable(context)

    fun startListening() {
        if (!isAvailable) return
        stopListening()

        _voiceState.value = VoiceState.LISTENING
        _lastTranscript.value = ""
        _assistantReply.value = "Listening… say “Hey My Ruby” or a command"

        speechRecognizer = SpeechRecognizer.createSpeechRecognizer(context).apply {
            setRecognitionListener(this@VoiceAssistantManager)
            val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault())
                putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            }
            startListening(intent)
        }
    }

    fun stopListening() {
        try {
            speechRecognizer?.stopListening()
            speechRecognizer?.destroy()
        } catch (_: Exception) {}
        speechRecognizer = null
        if (_voiceState.value == VoiceState.LISTENING) {
            _voiceState.value = VoiceState.IDLE
        }
    }

    override fun onResults(results: Bundle?) {
        val matches = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
        val text = matches?.firstOrNull() ?: ""
        _lastTranscript.value = text
        _voiceState.value = VoiceState.PROCESSING
        parseAndExecute(text)
    }

    override fun onPartialResults(partialResults: Bundle?) {
        val matches = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
        matches?.firstOrNull()?.let {
            _lastTranscript.value = it
        }
    }

    private fun parseAndExecute(raw: String) {
        val cleaned = raw.lowercase()
            .replace(Regex("['‘’`]"), "")
            .replace(Regex("[^a-z0-9 ]+"), " ")
            .trim()

        // Strip wake phrase: "hey my ruby", "hey ruby", "ruby"
        val wakePattern = Regex("^(?:hey my ruby|hey ruby|my ruby|ruby|hello ruby)\\s*")
        val cmd = cleaned.replace(wakePattern, "").trim()

        if (cmd.isBlank()) {
            _assistantReply.value = "Yes? I'm listening."
            _voiceState.value = VoiceState.IDLE
            return
        }

        when {
            // Transport controls
            cmd.contains("pause") || cmd.contains("stop") -> {
                playbackManager.pause()
                _assistantReply.value = "Paused playback"
            }
            cmd.contains("resume") || cmd == "play" -> {
                playbackManager.resume()
                _assistantReply.value = "Resuming playback"
            }
            cmd.contains("next") || cmd.contains("skip") -> {
                playbackManager.skipToNext()
                _assistantReply.value = "Skipping to next track"
            }
            cmd.contains("previous") || cmd.contains("back") -> {
                playbackManager.skipToPrevious()
                _assistantReply.value = "Going to previous track"
            }
            cmd.contains("shuffle") -> {
                playbackManager.toggleShuffle()
                _assistantReply.value = "Shuffle toggled"
            }
            cmd.contains("repeat") -> {
                playbackManager.toggleRepeat()
                _assistantReply.value = "Repeat mode changed"
            }
            // Mood commands
            cmd.contains("workout") || cmd.contains("gym") -> {
                val q = MoodFlowEngine.buildQuery("energetic", "workout", null)
                _assistantReply.value = "Playing workout motivation beats"
                onExecuteSearch(q)
            }
            cmd.contains("relax") || cmd.contains("chill") || cmd.contains("lofi") -> {
                val q = MoodFlowEngine.buildQuery("chill", null, null)
                _assistantReply.value = "Playing chill relaxing tunes"
                onExecuteSearch(q)
            }
            cmd.contains("study") || cmd.contains("focus") || cmd.contains("coding") -> {
                val q = MoodFlowEngine.buildQuery("focus", "coding", null)
                _assistantReply.value = "Starting deep focus session"
                onExecuteSearch(q)
            }
            cmd.contains("party") || cmd.contains("dance") -> {
                val q = MoodFlowEngine.buildQuery("party", null, null)
                _assistantReply.value = "Turning up party bangers"
                onExecuteSearch(q)
            }
            cmd.contains("sleep") || cmd.contains("ambient") -> {
                val q = MoodFlowEngine.buildQuery("sleep", null, null)
                _assistantReply.value = "Playing calming sleep sounds"
                onExecuteSearch(q)
            }
            // Song / artist search
            cmd.startsWith("play ") -> {
                val songQuery = cmd.removePrefix("play ").trim()
                _assistantReply.value = "Searching for $songQuery"
                onExecuteSearch(songQuery)
            }
            else -> {
                _assistantReply.value = "Searching for $cmd"
                onExecuteSearch(cmd)
            }
        }

        scope.launch {
            kotlinx.coroutines.delay(2000L)
            _voiceState.value = VoiceState.IDLE
        }
    }

    override fun onReadyForSpeech(params: Bundle?) {}
    override fun onBeginningOfSpeech() {}
    override fun onRmsChanged(rmsdB: Float) {}
    override fun onBufferReceived(buffer: ByteArray?) {}
    override fun onEndOfSpeech() { _voiceState.value = VoiceState.PROCESSING }
    override fun onError(error: Int) {
        _voiceState.value = VoiceState.ERROR
        _assistantReply.value = "Mic timeout or error ($error)"
        stopListening()
    }
    override fun onEvent(eventType: Int, params: Bundle?) {}
}

