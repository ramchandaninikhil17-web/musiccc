package com.musicflow.player.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

@Composable
fun MusicFlowTheme(
    accentColorKey: String = "indigo",
    themeMode: String = "dark",
    content: @Composable () -> Unit
) {
    val primaryColor = when (accentColorKey.lowercase()) {
        "cyan" -> MusicFlowCyan
        "emerald" -> MusicFlowEmerald
        "orange" -> MusicFlowOrange
        "pink" -> MusicFlowPink
        "purple" -> MusicFlowPurple
        else -> MusicFlowIndigo
    }

    val isAmoled = themeMode == "amoled"
    val isLight = themeMode == "light"

    val colorScheme = when {
        isLight -> lightColorScheme(
            primary = primaryColor,
            background = Color(0xFFF9FAFB),
            surface = Color(0xFFFFFFFF),
            onPrimary = Color.White,
            onBackground = Color(0xFF111827),
            onSurface = Color(0xFF1F2937)
        )
        isAmoled -> darkColorScheme(
            primary = primaryColor,
            background = AmoledBackground,
            surface = AmoledSurface,
            surfaceVariant = AmoledCardBg,
            onPrimary = Color.White,
            onBackground = TextPrimary,
            onSurface = TextPrimary
        )
        else -> darkColorScheme(
            primary = primaryColor,
            background = DarkBackground,
            surface = DarkSurface,
            surfaceVariant = DarkSurfaceVariant,
            onPrimary = Color.White,
            onBackground = TextPrimary,
            onSurface = TextPrimary
        )
    }

    MaterialTheme(
        colorScheme = colorScheme,
        content = content
    )
}

