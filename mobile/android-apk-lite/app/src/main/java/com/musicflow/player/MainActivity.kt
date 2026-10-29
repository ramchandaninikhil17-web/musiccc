package com.musicflow.player

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.musicflow.player.data.preferences.AppPreferences
import com.musicflow.player.data.repository.MusicRepository
import com.musicflow.player.playback.PlaybackManager
import com.musicflow.player.ui.navigation.AppNavigation
import com.musicflow.player.ui.theme.MusicFlowTheme
import com.musicflow.player.voice.VoiceAssistantManager
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import java.util.regex.Pattern

class MainActivity : ComponentActivity() {

    private lateinit var appPreferences: AppPreferences
    private lateinit var repository: MusicRepository
    private lateinit var playbackManager: PlaybackManager
    private lateinit var voiceAssistant: VoiceAssistantManager

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { permissions ->
        if (permissions[Manifest.permission.READ_MEDIA_AUDIO] == true ||
            permissions[Manifest.permission.READ_EXTERNAL_STORAGE] == true
        ) {
            lifecycleScope.launch {
                repository.scanLocalMedia()
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        appPreferences = AppPreferences(this)
        repository = MusicRepository(this)
        playbackManager = PlaybackManager.getInstance(this)

        voiceAssistant = VoiceAssistantManager(
            context = this,
            playbackManager = playbackManager,
            onExecuteSearch = { query ->
                lifecycleScope.launch {
                    val results = repository.search(query)
                    if (results.isNotEmpty()) {
                        playbackManager.playSong(results.first(), results)
                    }
                }
            }
        )

        requestRequiredPermissions()
        handleDeepLink(intent)
        resumeLastSession()

        setContent {
            val accentColor by appPreferences.accentColor.collectAsState(initial = "indigo")
            val themeMode by appPreferences.themeMode.collectAsState(initial = "dark")

            MusicFlowTheme(accentColorKey = accentColor, themeMode = themeMode) {
                Surface(modifier = Modifier.fillMaxSize()) {
                    AppNavigation(
                        repository = repository,
                        playbackManager = playbackManager,
                        appPreferences = appPreferences,
                        voiceAssistant = voiceAssistant,
                        onOpenVoice = { checkAndStartVoice() }
                    )
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleDeepLink(intent)
    }

    private fun handleDeepLink(intent: Intent?) {
        val data: Uri? = intent?.data
        if (data != null) {
            val urlString = data.toString()
            val ytId = extractYouTubeId(urlString)
            if (ytId != null) {
                lifecycleScope.launch {
                    val song = repository.resolveSongById(ytId)
                    if (song != null) {
                        playbackManager.playSong(song, listOf(song))
                    }
                }
            }
        }
    }

    private fun resumeLastSession() {
        lifecycleScope.launch {
            val lastSongId = appPreferences.resumeSongId.first()
            val lastPos = appPreferences.resumePosMs.first()
            if (!lastSongId.isNullOrBlank()) {
                val song = repository.resolveSongById(lastSongId)
                if (song != null) {
                    playbackManager.addToQueue(song)
                    if (lastPos > 0) {
                        playbackManager.seekTo(lastPos)
                    }
                }
            }
        }
    }

    private fun requestRequiredPermissions() {
        val permsToRequest = mutableListOf<String>()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                permsToRequest.add(Manifest.permission.POST_NOTIFICATIONS)
            }
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_MEDIA_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                permsToRequest.add(Manifest.permission.READ_MEDIA_AUDIO)
            }
        } else {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
                permsToRequest.add(Manifest.permission.READ_EXTERNAL_STORAGE)
            }
        }

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            permsToRequest.add(Manifest.permission.RECORD_AUDIO)
        }

        if (permsToRequest.isNotEmpty()) {
            permissionLauncher.launch(permsToRequest.toTypedArray())
        }
    }

    private fun checkAndStartVoice() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            voiceAssistant.startListening()
        } else {
            permissionLauncher.launch(arrayOf(Manifest.permission.RECORD_AUDIO))
        }
    }

    private fun extractYouTubeId(urlOrId: String): String? {
        val trimmed = urlOrId.trim()
        if (trimmed.length == 11 && Pattern.compile("^[a-zA-Z0-9_-]{11}$").matcher(trimmed).matches()) {
            return trimmed
        }
        val p = Pattern.compile("(?:youtu\\.be/|youtube\\.com/(?:embed/|v/|watch\\?v=|watch\\?.+&v=))([a-zA-Z0-9_-]{11})")
        val m = p.matcher(trimmed)
        return if (m.find()) m.group(1) else null
    }

    override fun onDestroy() {
        // Save current song and position to DataStore on destroy
        val cur = playbackManager.currentSong.value
        val pos = playbackManager.currentPositionMs.value
        if (cur != null) {
            lifecycleScope.launch {
                appPreferences.saveResumeState(cur.id, pos)
            }
        }
        super.onDestroy()
    }
}
