package com.musicflow.player.ui.screens

import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.musicflow.player.data.model.Song
import com.musicflow.player.data.repository.MusicRepository
import com.musicflow.player.engine.SuggestionItem
import com.musicflow.player.engine.SuggestionType
import com.musicflow.player.playback.PlaybackManager
import com.musicflow.player.ui.components.SongRowItem
import com.musicflow.player.ui.theme.TextMuted
import com.musicflow.player.ui.theme.TextPrimary
import com.musicflow.player.ui.theme.TextSecondary
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable
fun SearchScreen(
    repository: MusicRepository,
    playbackManager: PlaybackManager,
    initialQuery: String = "",
    onOpenVoice: () -> Unit,
    modifier: Modifier = Modifier
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var query by remember { mutableStateOf(initialQuery) }
    var isLyricsMode by remember { mutableStateOf(false) }
    var searchResults by remember { mutableStateOf<List<Song>>(emptyList()) }
    var suggestions by remember { mutableStateOf<List<SuggestionItem>>(emptyList()) }
    var isSearching by remember { mutableStateOf(false) }
    var searchJob by remember { mutableStateOf<Job?>(null) }

    // Check clipboard for YouTube links
    val clipboardManager = remember { context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager }
    val clipboardText = remember {
        val clip = clipboardManager.primaryClip
        if (clip != null && clip.itemCount > 0) {
            clip.getItemAt(0).text?.toString() ?: ""
        } else ""
    }
    val hasYouTubeLinkInClipboard = remember(clipboardText) {
        clipboardText.contains("youtu.be") || clipboardText.contains("youtube.com")
    }

    fun triggerSearch(q: String) {
        searchJob?.cancel()
        if (q.isBlank()) {
            searchResults = emptyList()
            suggestions = emptyList()
            isSearching = false
            return
        }
        isSearching = true
        searchJob = scope.launch {
            val effectiveQuery = if (isLyricsMode) "lyrics: $q" else q
            searchResults = repository.search(effectiveQuery)
            suggestions = emptyList()
            isSearching = false
        }
    }

    // Debounced suggestions as user types
    LaunchedEffect(query) {
        if (query.isNotBlank() && searchResults.isEmpty()) {
            delay(150L)
            suggestions = repository.getSuggestions(query)
        } else {
            suggestions = emptyList()
        }
    }

    LaunchedEffect(initialQuery) {
        if (initialQuery.isNotBlank()) {
            query = initialQuery
            triggerSearch(initialQuery)
        }
    }

    Column(
        modifier = modifier
            .fillMaxSize()
            .statusBarsPadding()
            .padding(horizontal = 16.dp)
    ) {
        Spacer(modifier = Modifier.height(12.dp))

        // Search Text Field
        OutlinedTextField(
            value = query,
            onValueChange = {
                query = it
                if (searchResults.isNotEmpty()) searchResults = emptyList()
            },
            placeholder = { Text(if (isLyricsMode) "Search by song lyrics…" else "Search songs, artists, links…") },
            leadingIcon = { Icon(Icons.Default.Search, contentDescription = "Search", tint = TextMuted) },
            trailingIcon = {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (query.isNotEmpty()) {
                        IconButton(onClick = { query = ""; searchResults = emptyList(); suggestions = emptyList() }) {
                            Icon(Icons.Default.Clear, contentDescription = "Clear", tint = TextMuted)
                        }
                    }
                    IconButton(onClick = onOpenVoice) {
                        Icon(Icons.Default.Mic, contentDescription = "Voice Search", tint = MaterialTheme.colorScheme.primary)
                    }
                }
            },
            singleLine = true,
            shape = RoundedCornerShape(24.dp),
            modifier = Modifier.fillMaxWidth()
        )

        Spacer(modifier = Modifier.height(8.dp))

        // Filter Pills: Lyrics Mode & Paste Link
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            FilterChip(
                selected = isLyricsMode,
                onClick = { isLyricsMode = !isLyricsMode },
                label = { Text("🎤 Lyrics Search") },
                leadingIcon = { if (isLyricsMode) Icon(Icons.Default.Check, null) else null }
            )

            if (hasYouTubeLinkInClipboard) {
                SuggestionChip(
                    onClick = {
                        query = clipboardText
                        triggerSearch(clipboardText)
                    },
                    label = { Text("📋 Paste Link") },
                    icon = { Icon(Icons.Default.ContentPaste, null) }
                )
            }
        }

        Spacer(modifier = Modifier.height(8.dp))

        if (isSearching) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f),
                contentAlignment = Alignment.Center
            ) {
                CircularProgressIndicator(color = MaterialTheme.colorScheme.primary)
            }
        } else if (suggestions.isNotEmpty() && searchResults.isEmpty()) {
            // Suggestions List
            LazyColumn(modifier = Modifier.weight(1f)) {
                items(suggestions) { item ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable {
                                query = item.text
                                triggerSearch(item.text)
                            }
                            .padding(vertical = 12.dp, horizontal = 4.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Icon(
                            imageVector = when (item.type) {
                                SuggestionType.HISTORY -> Icons.Default.History
                                SuggestionType.ARTIST -> Icons.Default.Person
                                SuggestionType.SONG -> Icons.Default.MusicNote
                                SuggestionType.REMOTE -> Icons.Default.Search
                            },
                            contentDescription = null,
                            tint = TextMuted,
                            modifier = Modifier.size(20.dp)
                        )
                        Spacer(modifier = Modifier.width(16.dp))
                        Text(
                            text = item.text,
                            style = MaterialTheme.typography.bodyMedium.copy(color = TextPrimary),
                            modifier = Modifier.weight(1f)
                        )
                    }
                }
            }
        } else {
            // Results List
            LazyColumn(
                modifier = Modifier.weight(1f),
                contentPadding = PaddingValues(bottom = 120.dp)
            ) {
                items(searchResults) { song ->
                    SongRowItem(
                        song = song,
                        isPlaying = playbackManager.currentSong.collectAsState().value?.id == song.id,
                        onClick = { playbackManager.playSong(song, searchResults) },
                        onPlayNext = { playbackManager.playNext(song) },
                        onAddToQueue = { playbackManager.addToQueue(song) },
                        onToggleLike = { scope.launch { repository.toggleFavorite(song) } },
                        onDownload = { repository.startDownload(song) }
                    )
                }
            }
        }
    }
}

