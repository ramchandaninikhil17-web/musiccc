package com.musicflow.player.ui.navigation

import androidx.compose.animation.*
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.compose.*
import com.musicflow.player.data.preferences.AppPreferences
import com.musicflow.player.data.repository.MusicRepository
import com.musicflow.player.playback.PlaybackManager
import com.musicflow.player.ui.components.FullscreenPlayer
import com.musicflow.player.ui.components.MiniPlayer
import com.musicflow.player.ui.screens.*
import com.musicflow.player.ui.theme.TextMuted
import com.musicflow.player.ui.theme.TextPrimary
import com.musicflow.player.ui.theme.TextSecondary
import com.musicflow.player.voice.VoiceAssistantManager
import com.musicflow.player.voice.VoiceState
import kotlinx.coroutines.launch

sealed class Screen(val route: String, val title: String, val icon: ImageVector) {
    object Home : Screen("home", "Home", Icons.Default.Home)
    object Search : Screen("search", "Search", Icons.Default.Search)
    object Library : Screen("library", "Library", Icons.Default.LibraryMusic)
}

@Composable
fun AppNavigation(
    repository: MusicRepository,
    playbackManager: PlaybackManager,
    appPreferences: AppPreferences,
    voiceAssistant: VoiceAssistantManager,
    onOpenVoice: () -> Unit,
    modifier: Modifier = Modifier
) {
    val navController = rememberNavController()
    val scope = rememberCoroutineScope()
    val currentSong by playbackManager.currentSong.collectAsState()
    val isPlaying by playbackManager.isPlaying.collectAsState()
    val currentPosMs by playbackManager.currentPositionMs.collectAsState()
    val durationMs by playbackManager.durationMs.collectAsState()

    var isPlayerExpanded by remember { mutableStateOf(false) }
    var searchInitialQuery by remember { mutableStateOf("") }

    val navBackStackEntry by navController.currentBackStackEntryAsState()
    val currentRoute = navBackStackEntry?.destination?.route

    val bottomNavItems = listOf(Screen.Home, Screen.Search, Screen.Library)
    val isBottomBarVisible = currentRoute in bottomNavItems.map { it.route }

    Box(modifier = modifier.fillMaxSize()) {
        Scaffold(
            bottomBar = {
                if (isBottomBarVisible) {
                    Column(modifier = Modifier.fillMaxWidth()) {
                        // Mini-Player if song is loaded
                        if (currentSong != null && !isPlayerExpanded) {
                            MiniPlayer(
                                song = currentSong!!,
                                isPlaying = isPlaying,
                                progressMs = currentPosMs,
                                durationMs = durationMs,
                                onTogglePlayPause = { playbackManager.togglePlayPause() },
                                onSkipNext = { playbackManager.skipToNext() },
                                onExpand = { isPlayerExpanded = true }
                            )
                        }

                        // Bottom Navigation Bar
                        NavigationBar(
                            containerColor = MaterialTheme.colorScheme.surface,
                            tonalElevation = 8.dp
                        ) {
                            bottomNavItems.forEach { screen ->
                                val selected = currentRoute == screen.route
                                NavigationBarItem(
                                    icon = { Icon(screen.icon, contentDescription = screen.title) },
                                    label = { Text(screen.title) },
                                    selected = selected,
                                    colors = NavigationBarItemDefaults.colors(
                                        selectedIconColor = MaterialTheme.colorScheme.primary,
                                        selectedTextColor = MaterialTheme.colorScheme.primary,
                                        unselectedIconColor = TextMuted,
                                        unselectedTextColor = TextMuted,
                                        indicatorColor = Color.Transparent
                                    ),
                                    onClick = {
                                        navController.navigate(screen.route) {
                                            popUpTo(navController.graph.findStartDestination().id) {
                                                saveState = true
                                            }
                                            launchSingleTop = true
                                            restoreState = true
                                        }
                                    }
                                )
                            }
                        }
                    }
                }
            }
        ) { padding ->
            NavHost(
                navController = navController,
                startDestination = Screen.Home.route,
                modifier = Modifier.padding(padding)
            ) {
                composable(Screen.Home.route) {
                    HomeScreen(
                        repository = repository,
                        playbackManager = playbackManager,
                        onNavigateToSearchWithQuery = { q ->
                            searchInitialQuery = q
                            navController.navigate(Screen.Search.route)
                        },
                        onNavigateToFocus = { navController.navigate("focus_flow") },
                        onNavigateToMood = { navController.navigate("mood_flow") },
                        onNavigateToStats = { navController.navigate("stats") },
                        onNavigateToSettings = { navController.navigate("settings") },
                        onNavigateToCarMode = { navController.navigate("car_mode") }
                    )
                }

                composable(Screen.Search.route) {
                    SearchScreen(
                        repository = repository,
                        playbackManager = playbackManager,
                        initialQuery = searchInitialQuery,
                        onOpenVoice = onOpenVoice
                    )
                }

                composable(Screen.Library.route) {
                    LibraryScreen(
                        repository = repository,
                        playbackManager = playbackManager,
                        onNavigateToPlaylistDetail = { id -> navController.navigate("playlist_detail/$id") }
                    )
                }

                composable("playlist_detail/{id}") { backStackEntry ->
                    val playlistId = backStackEntry.arguments?.getString("id") ?: ""
                    PlaylistDetailScreen(
                        playlistId = playlistId,
                        repository = repository,
                        playbackManager = playbackManager,
                        onBack = { navController.popBackStack() }
                    )
                }

                composable("focus_flow") {
                    FocusFlowScreen(
                        onBack = { navController.popBackStack() },
                        onPlayFocusQuery = { q ->
                            searchInitialQuery = q
                            navController.navigate(Screen.Search.route)
                        }
                    )
                }

                composable("mood_flow") {
                    MoodFlowScreen(
                        onBack = { navController.popBackStack() },
                        onStartMix = { q ->
                            searchInitialQuery = q
                            navController.navigate(Screen.Search.route)
                        }
                    )
                }

                composable("stats") {
                    StatsScreen(
                        repository = repository,
                        onBack = { navController.popBackStack() }
                    )
                }

                composable("car_mode") {
                    CarModeScreen(
                        playbackManager = playbackManager,
                        onOpenVoice = onOpenVoice,
                        onExitCarMode = { navController.popBackStack() }
                    )
                }

                composable("settings") {
                    SettingsScreen(
                        appPreferences = appPreferences,
                        repository = repository,
                        playbackManager = playbackManager,
                        onBack = { navController.popBackStack() }
                    )
                }
            }
        }

        // Fullscreen Player Overlay with smooth transition
        AnimatedVisibility(
            visible = isPlayerExpanded,
            enter = slideInVertically(initialOffsetY = { it }),
            exit = slideOutVertically(targetOffsetY = { it })
        ) {
            FullscreenPlayer(
                playbackManager = playbackManager,
                onCollapse = { isPlayerExpanded = false },
                onToggleLike = { song -> scope.launch { repository.toggleFavorite(song) } },
                onDownload = { song -> repository.startDownload(song) }
            )
        }

        // Voice Assistant Overlay Dialog
        val voiceState by voiceAssistant.voiceState.collectAsState()
        val transcript by voiceAssistant.lastTranscript.collectAsState()
        val reply by voiceAssistant.assistantReply.collectAsState()

        if (voiceState != VoiceState.IDLE) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(Color.Black.copy(alpha = 0.75f))
                    .clickable { voiceAssistant.stopListening() },
                contentAlignment = Alignment.Center
            ) {
                Surface(
                    color = MaterialTheme.colorScheme.surfaceVariant,
                    shape = CircleShape,
                    modifier = Modifier.padding(32.dp)
                ) {
                    Column(
                        modifier = Modifier.padding(32.dp),
                        horizontalAlignment = Alignment.CenterHorizontally
                    ) {
                        Icon(
                            imageVector = Icons.Default.Mic,
                            contentDescription = "Listening",
                            tint = MaterialTheme.colorScheme.primary,
                            modifier = Modifier.size(64.dp)
                        )
                        Spacer(modifier = Modifier.height(16.dp))
                        Text(
                            text = if (transcript.isNotBlank()) "“$transcript”" else "Listening…",
                            style = MaterialTheme.typography.titleMedium.copy(
                                fontWeight = FontWeight.Bold,
                                color = TextPrimary
                            )
                        )
                        Spacer(modifier = Modifier.height(8.dp))
                        Text(
                            text = reply,
                            style = MaterialTheme.typography.bodySmall.copy(color = TextSecondary),
                            fontSize = 12.sp
                        )
                    }
                }
            }
        }
    }
}

