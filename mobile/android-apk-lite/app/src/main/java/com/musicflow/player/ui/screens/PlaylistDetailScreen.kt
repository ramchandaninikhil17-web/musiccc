package com.musicflow.player.ui.screens

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.musicflow.player.data.repository.MusicRepository
import com.musicflow.player.playback.PlaybackManager
import com.musicflow.player.ui.components.SongRowItem
import com.musicflow.player.ui.theme.TextMuted
import com.musicflow.player.ui.theme.TextPrimary
import com.musicflow.player.ui.theme.TextSecondary
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PlaylistDetailScreen(
    playlistId: String,
    repository: MusicRepository,
    playbackManager: PlaybackManager,
    onBack: () -> Unit,
    modifier: Modifier = Modifier
) {
    val scope = rememberCoroutineScope()
    val songs by repository.getPlaylistSongsFlow(playlistId).collectAsState(initial = emptyList())

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Playlist Details") },
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
                .padding(horizontal = 16.dp)
        ) {
            // Header: Play All & Shuffle
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(vertical = 12.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                Button(
                    onClick = {
                        if (songs.isNotEmpty()) playbackManager.playSong(songs.first(), songs)
                    },
                    modifier = Modifier.weight(1f)
                ) {
                    Icon(Icons.Default.PlayArrow, contentDescription = null)
                    Spacer(modifier = Modifier.width(8.dp))
                    Text("Play All (${songs.size})")
                }

                FilledTonalButton(
                    onClick = {
                        if (songs.isNotEmpty()) playbackManager.playSong(songs.shuffled().first(), songs.shuffled())
                    },
                    modifier = Modifier.weight(1f)
                ) {
                    Icon(Icons.Default.Shuffle, contentDescription = null)
                    Spacer(modifier = Modifier.width(8.dp))
                    Text("Shuffle")
                }
            }

            if (songs.isEmpty()) {
                Box(
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                    contentAlignment = Alignment.Center
                ) {
                    Text("No songs in this playlist yet.", color = TextMuted)
                }
            } else {
                LazyColumn(
                    modifier = Modifier.weight(1f),
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
    }
}

