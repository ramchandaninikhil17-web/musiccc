package com.musicflow.player.ui.screens

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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.musicflow.player.data.model.Song
import com.musicflow.player.data.repository.MusicRepository
import com.musicflow.player.playback.PlaybackManager
import com.musicflow.player.ui.components.SongRowItem
import com.musicflow.player.ui.theme.TextMuted
import com.musicflow.player.ui.theme.TextPrimary
import com.musicflow.player.ui.theme.TextSecondary
import kotlinx.coroutines.launch

@Composable
fun LibraryScreen(
    repository: MusicRepository,
    playbackManager: PlaybackManager,
    onNavigateToPlaylistDetail: (String) -> Unit,
    modifier: Modifier = Modifier
) {
    val scope = rememberCoroutineScope()
    var selectedTab by remember { mutableIntStateOf(0) } // 0: Playlists, 1: Liked, 2: Downloads, 3: Local

    val playlists by repository.getPlaylistsFlow().collectAsState(initial = emptyList())
    val favorites by repository.getFavoriteSongsFlow().collectAsState(initial = emptyList())
    val downloads by repository.getDownloadedSongsFlow().collectAsState(initial = emptyList())
    val localFiles by repository.getLocalSongsFlow().collectAsState(initial = emptyList())

    var showNewPlaylistDialog by remember { mutableStateOf(false) }
    var showBatchImportDialog by remember { mutableStateOf(false) }

    Column(
        modifier = modifier
            .fillMaxSize()
            .statusBarsPadding()
            .padding(horizontal = 16.dp)
    ) {
        Spacer(modifier = Modifier.height(16.dp))

        // Title and Actions
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = "Your Library",
                style = MaterialTheme.typography.headlineMedium.copy(
                    fontWeight = FontWeight.Bold,
                    color = TextPrimary
                )
            )

            Row {
                IconButton(onClick = { showBatchImportDialog = true }) {
                    Icon(Icons.Default.PostAdd, contentDescription = "Batch Import", tint = TextSecondary)
                }
                IconButton(onClick = { showNewPlaylistDialog = true }) {
                    Icon(Icons.Default.Add, contentDescription = "Create Playlist", tint = MaterialTheme.colorScheme.primary)
                }
            }
        }

        Spacer(modifier = Modifier.height(12.dp))

        // Tab Row
        val tabs = listOf("Playlists", "Liked (${favorites.size})", "Downloads (${downloads.size})", "Local Files")
        ScrollableTabRow(
            selectedTabIndex = selectedTab,
            edgePadding = 0.dp,
            divider = {},
            containerColor = Color.Transparent,
            modifier = Modifier.fillMaxWidth()
        ) {
            tabs.forEachIndexed { index, title ->
                Tab(
                    selected = selectedTab == index,
                    onClick = { selectedTab = index },
                    text = {
                        Text(
                            text = title,
                            fontWeight = if (selectedTab == index) FontWeight.Bold else FontWeight.Normal,
                            color = if (selectedTab == index) MaterialTheme.colorScheme.primary else TextSecondary
                        )
                    }
                )
            }
        }

        Spacer(modifier = Modifier.height(8.dp))

        // Tab Content
        when (selectedTab) {
            0 -> {
                // Playlists Tab
                if (playlists.isEmpty()) {
                    Box(modifier = Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                        Text("No playlists yet. Tap + above to create one!", color = TextMuted)
                    }
                } else {
                    LazyColumn(
                        modifier = Modifier.weight(1f),
                        contentPadding = PaddingValues(bottom = 120.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        items(playlists) { playlist ->
                            Surface(
                                color = MaterialTheme.colorScheme.surfaceVariant,
                                shape = RoundedCornerShape(10.dp),
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable { onNavigateToPlaylistDetail(playlist.id) }
                            ) {
                                Row(
                                    modifier = Modifier.padding(12.dp),
                                    verticalAlignment = Alignment.CenterVertically
                                ) {
                                    Icon(
                                        imageVector = Icons.Default.QueueMusic,
                                        contentDescription = null,
                                        tint = MaterialTheme.colorScheme.primary,
                                        modifier = Modifier.size(40.dp)
                                    )
                                    Spacer(modifier = Modifier.width(16.dp))
                                    Column(modifier = Modifier.weight(1f)) {
                                        Text(
                                            text = playlist.name,
                                            style = MaterialTheme.typography.titleMedium.copy(
                                                fontWeight = FontWeight.Bold,
                                                color = TextPrimary
                                            )
                                        )
                                        Text(
                                            text = "${playlist.songCount} songs",
                                            style = MaterialTheme.typography.bodySmall.copy(color = TextSecondary)
                                        )
                                    }
                                    IconButton(onClick = { scope.launch { repository.deletePlaylist(playlist.id) } }) {
                                        Icon(Icons.Default.DeleteOutline, contentDescription = "Delete", tint = TextMuted)
                                    }
                                }
                            }
                        }
                    }
                }
            }
            1 -> {
                // Liked Songs Tab
                SongList(
                    songs = favorites,
                    emptyMessage = "No liked songs yet. Tap heart on any song!",
                    repository = repository,
                    playbackManager = playbackManager,
                    modifier = Modifier.weight(1f)
                )
            }
            2 -> {
                // Downloads Tab
                SongList(
                    songs = downloads,
                    emptyMessage = "No downloaded tracks yet.",
                    repository = repository,
                    playbackManager = playbackManager,
                    modifier = Modifier.weight(1f)
                )
            }
            3 -> {
                // Local Files Tab
                Column(modifier = Modifier.weight(1f)) {
                    Button(
                        onClick = { scope.launch { repository.scanLocalMedia() } },
                        modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp)
                    ) {
                        Icon(Icons.Default.Refresh, contentDescription = null)
                        Spacer(modifier = Modifier.width(8.dp))
                        Text("Rescan Device Audio Files")
                    }
                    SongList(
                        songs = localFiles,
                        emptyMessage = "No local audio files found.",
                        repository = repository,
                        playbackManager = playbackManager,
                        modifier = Modifier.weight(1f)
                    )
                }
            }
        }
    }

    // New Playlist Dialog
    if (showNewPlaylistDialog) {
        var playlistName by remember { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { showNewPlaylistDialog = false },
            title = { Text("New Playlist") },
            text = {
                OutlinedTextField(
                    value = playlistName,
                    onValueChange = { playlistName = it },
                    label = { Text("Playlist Name") },
                    singleLine = true
                )
            },
            confirmButton = {
                Button(onClick = {
                    if (playlistName.isNotBlank()) {
                        scope.launch { repository.createPlaylist(playlistName.trim()) }
                        showNewPlaylistDialog = false
                    }
                }) {
                    Text("Create")
                }
            },
            dismissButton = {
                TextButton(onClick = { showNewPlaylistDialog = false }) { Text("Cancel") }
            }
        )
    }

    // Batch Import Dialog
    if (showBatchImportDialog) {
        var playlistName by remember { mutableStateOf("Imported Mix") }
        var rawText by remember { mutableStateOf("") }
        var isImporting by remember { mutableStateOf(false) }

        AlertDialog(
            onDismissRequest = { if (!isImporting) showBatchImportDialog = false },
            title = { Text("Batch Import Tracks") },
            text = {
                Column {
                    OutlinedTextField(
                        value = playlistName,
                        onValueChange = { playlistName = it },
                        label = { Text("Target Playlist Name") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth()
                    )
                    Spacer(modifier = Modifier.height(8.dp))
                    OutlinedTextField(
                        value = rawText,
                        onValueChange = { rawText = it },
                        label = { Text("Paste song names or YouTube links (1 per line)") },
                        modifier = Modifier.fillMaxWidth().height(150.dp)
                    )
                }
            },
            confirmButton = {
                Button(
                    enabled = !isImporting && rawText.isNotBlank(),
                    onClick = {
                        isImporting = true
                        scope.launch {
                            val lines = rawText.lines()
                            repository.batchImport(lines, playlistName)
                            isImporting = false
                            showBatchImportDialog = false
                        }
                    }
                ) {
                    Text(if (isImporting) "Importing…" else "Start Import")
                }
            },
            dismissButton = {
                TextButton(onClick = { showBatchImportDialog = false }) { Text("Cancel") }
            }
        )
    }
}

@Composable
private fun SongList(
    songs: List<Song>,
    emptyMessage: String,
    repository: MusicRepository,
    playbackManager: PlaybackManager,
    modifier: Modifier = Modifier
) {
    val scope = rememberCoroutineScope()
    if (songs.isEmpty()) {
        Box(modifier = modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
            Text(emptyMessage, color = TextMuted)
        }
    } else {
        LazyColumn(
            modifier = modifier,
            contentPadding = PaddingValues(bottom = 120.dp)
        ) {
            items(songs) { song ->
                SongRowItem(
                    song = song,
                    isPlaying = playbackManager.currentSong.collectAsState().value?.id == song.id,
                    onClick = { playbackManager.playSong(song, songs) },
                    onPlayNext = { playbackManager.playNext(song) },
                    onAddToQueue = { playbackManager.addToQueue(song) },
                    onToggleLike = { scope.launch { repository.toggleFavorite(song) } },
                    onDownload = { repository.startDownload(song) }
                )
            }
        }
    }
}

