package com.musicflow.player.ui.screens

import android.content.Intent
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.musicflow.player.data.preferences.AppPreferences
import com.musicflow.player.data.remote.SourceHealth
import com.musicflow.player.data.remote.SourceHealthChecker
import com.musicflow.player.data.repository.MusicRepository
import com.musicflow.player.playback.PlaybackManager
import com.musicflow.player.ui.theme.*
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    appPreferences: AppPreferences,
    repository: MusicRepository,
    playbackManager: PlaybackManager,
    onBack: () -> Unit,
    modifier: Modifier = Modifier
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    val currentAccent by appPreferences.accentColor.collectAsState(initial = "indigo")
    val currentTheme by appPreferences.themeMode.collectAsState(initial = "dark")
    val currentQuality by appPreferences.audioQuality.collectAsState(initial = "192")
    val crossfadeSec by appPreferences.crossfadeSec.collectAsState(initial = 0)
    val isGapless by appPreferences.gaplessEnabled.collectAsState(initial = true)
    val isLoudness by appPreferences.loudnessNorm.collectAsState(initial = false)

    var showHealthDialog by remember { mutableStateOf(false) }
    var healthResults by remember { mutableStateOf<List<SourceHealth>>(emptyList()) }
    var isCheckingHealth by remember { mutableStateOf(false) }

    var showSpotifyImportDialog by remember { mutableStateOf(false) }
    var spotifyInputText by remember { mutableStateOf("") }
    var isImportingSpotify by remember { mutableStateOf(false) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Settings") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.Default.ArrowBack, contentDescription = "Back")
                    }
                }
            )
        }
    ) { padding ->
        Column(
            modifier = modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp),
            verticalArrangement = Arrangement.spacedBy(24.dp)
        ) {
            Spacer(modifier = Modifier.height(4.dp))

            // THEME STUDIO
            SectionHeader("Theme Studio & Accent Color")

            Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                val accents = listOf(
                    "indigo" to MusicFlowIndigo,
                    "cyan" to MusicFlowCyan,
                    "emerald" to MusicFlowEmerald,
                    "orange" to MusicFlowOrange,
                    "pink" to MusicFlowPink,
                    "purple" to MusicFlowPurple
                )
                accents.forEach { (key, color) ->
                    Box(
                        modifier = Modifier
                            .size(36.dp)
                            .clip(CircleShape)
                            .background(color)
                            .clickable { scope.launch { appPreferences.setAccentColor(key) } },
                        contentAlignment = Alignment.Center
                    ) {
                        if (currentAccent == key) {
                            Icon(Icons.Default.Check, contentDescription = null, tint = Color.White, modifier = Modifier.size(20.dp))
                        }
                    }
                }
            }

            // Theme Mode
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf("dark" to "Spotify Dark", "amoled" to "AMOLED Black", "light" to "Light").forEach { (mode, label) ->
                    FilterChip(
                        selected = currentTheme == mode,
                        onClick = { scope.launch { appPreferences.setThemeMode(mode) } },
                        label = { Text(label) }
                    )
                }
            }

            HorizontalDivider(color = MaterialTheme.colorScheme.surfaceVariant)

            // AUDIO ENGINE SETTINGS
            SectionHeader("Audio Engine & Playback")

            // Streaming Quality
            Text("Streaming Quality: ${currentQuality}kbps", color = TextSecondary, fontSize = 14.sp)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf("128" to "128k (Low)", "192" to "192k (Standard)", "320" to "320k (Ultra)").forEach { (q, label) ->
                    FilterChip(
                        selected = currentQuality == q,
                        onClick = { scope.launch { appPreferences.setAudioQuality(q) } },
                        label = { Text(label) }
                    )
                }
            }

            // Crossfade Slider
            var sliderCrossfade by remember(crossfadeSec) { mutableFloatStateOf(crossfadeSec.toFloat()) }
            Column {
                Text("Crossfade: ${sliderCrossfade.toInt()}s", color = TextSecondary, fontSize = 14.sp)
                Slider(
                    value = sliderCrossfade,
                    onValueChange = { sliderCrossfade = it },
                    onValueChangeFinished = {
                        val sec = sliderCrossfade.toInt()
                        scope.launch { appPreferences.setCrossfadeSec(sec) }
                        playbackManager.crossfadeSeconds = sec
                    },
                    valueRange = 0f..10f,
                    steps = 9
                )
            }

            // Gapless Playback
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column {
                    Text("Gapless Playback", color = TextPrimary, fontWeight = FontWeight.Medium)
                    Text("Eliminates silence between tracks", color = TextSecondary, fontSize = 12.sp)
                }
                Switch(
                    checked = isGapless,
                    onCheckedChange = { scope.launch { appPreferences.setGaplessEnabled(it) } }
                )
            }

            HorizontalDivider(color = MaterialTheme.colorScheme.surfaceVariant)

            // DIAGNOSTICS & SOURCE HEALTH
            SectionHeader("Diagnostics & Data Sources")

            Button(
                onClick = {
                    showHealthDialog = true
                    isCheckingHealth = true
                    scope.launch {
                        healthResults = SourceHealthChecker.checkAllSources()
                        isCheckingHealth = false
                    }
                },
                modifier = Modifier.fillMaxWidth()
            ) {
                Icon(Icons.Default.HealthAndSafety, contentDescription = null)
                Spacer(modifier = Modifier.width(8.dp))
                Text("Run In-App Source Health Check")
            }

            HorizontalDivider(color = MaterialTheme.colorScheme.surfaceVariant)

            // BACKUP, RESTORE & SPOTIFY IMPORT
            SectionHeader("Backup, Restore & Migration")

            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(
                    onClick = {
                        scope.launch {
                            val json = repository.exportDataAsJson()
                            val sendIntent = Intent().apply {
                                action = Intent.ACTION_SEND
                                putExtra(Intent.EXTRA_TEXT, json)
                                type = "application/json"
                            }
                            context.startActivity(Intent.createChooser(sendIntent, "Export MusicFlow Backup JSON"))
                        }
                    },
                    modifier = Modifier.weight(1f)
                ) {
                    Icon(Icons.Default.CloudUpload, contentDescription = null)
                    Spacer(modifier = Modifier.width(6.dp))
                    Text("Export JSON")
                }

                OutlinedButton(
                    onClick = { showSpotifyImportDialog = true },
                    modifier = Modifier.weight(1f)
                ) {
                    Icon(Icons.Default.ImportExport, contentDescription = null)
                    Spacer(modifier = Modifier.width(6.dp))
                    Text("Import Spotify")
                }
            }

            HorizontalDivider(color = MaterialTheme.colorScheme.surfaceVariant)

            // APP VERSION
            Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.fillMaxWidth()) {
                Text(
                    text = "MusicFlow Native",
                    style = MaterialTheme.typography.titleMedium.copy(
                        fontWeight = FontWeight.Bold,
                        color = TextPrimary
                    )
                )
                Text(
                    text = "v3.5.0-HyperFlow • Standalone Kotlin & Compose",
                    style = MaterialTheme.typography.bodySmall.copy(color = TextMuted)
                )
            }

            Spacer(modifier = Modifier.height(40.dp))
        }
    }

    // Source Health Dialog
    if (showHealthDialog) {
        AlertDialog(
            onDismissRequest = { showHealthDialog = false },
            title = { Text("Data Source Health Status") },
            text = {
                if (isCheckingHealth) {
                    Box(modifier = Modifier.fillMaxWidth().height(100.dp), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator(color = MaterialTheme.colorScheme.primary)
                    }
                } else {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        healthResults.forEach { h ->
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Column {
                                    Text(h.sourceName, fontWeight = FontWeight.Bold, color = TextPrimary)
                                    Text(h.details, fontSize = 11.sp, color = TextSecondary)
                                }
                                Text(
                                    text = if (h.isAvailable) "${h.latencyMs}ms" else "DOWN",
                                    color = if (h.isAvailable) Color(0xFF10B981) else Color(0xFFEF4444),
                                    fontWeight = FontWeight.Bold
                                )
                            }
                        }
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = { showHealthDialog = false }) { Text("Close") }
            }
        )
    }

    // Spotify Import Dialog
    if (showSpotifyImportDialog) {
        AlertDialog(
            onDismissRequest = { if (!isImportingSpotify) showSpotifyImportDialog = false },
            title = { Text("Spotify CSV / Track Importer") },
            text = {
                Column {
                    Text("Paste track lines from a Spotify export or CSV:", fontSize = 13.sp, color = TextSecondary)
                    Spacer(modifier = Modifier.height(8.dp))
                    OutlinedTextField(
                        value = spotifyInputText,
                        onValueChange = { spotifyInputText = it },
                        modifier = Modifier.fillMaxWidth().height(140.dp)
                    )
                }
            },
            confirmButton = {
                Button(
                    enabled = !isImportingSpotify && spotifyInputText.isNotBlank(),
                    onClick = {
                        isImportingSpotify = true
                        scope.launch {
                            val lines = spotifyInputText.lines()
                            repository.batchImport(lines, "Spotify Import")
                            isImportingSpotify = false
                            showSpotifyImportDialog = false
                        }
                    }
                ) {
                    Text(if (isImportingSpotify) "Matching…" else "Start Match")
                }
            },
            dismissButton = {
                TextButton(onClick = { showSpotifyImportDialog = false }) { Text("Cancel") }
            }
        )
    }
}

@Composable
private fun SectionHeader(title: String) {
    Text(
        text = title,
        style = MaterialTheme.typography.titleMedium.copy(
            fontWeight = FontWeight.Bold,
            color = MaterialTheme.colorScheme.primary
        )
    )
}

