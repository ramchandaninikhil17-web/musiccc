package com.musicflow.player.ui.components

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.musicflow.player.playback.AudioEffectsController
import com.musicflow.player.ui.theme.TextMuted
import com.musicflow.player.ui.theme.TextPrimary
import com.musicflow.player.ui.theme.TextSecondary

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AudioEffectsSheet(
    audioEffectsController: AudioEffectsController,
    onDismiss: () -> Unit
) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        containerColor = MaterialTheme.colorScheme.surface
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 24.dp, vertical = 16.dp)
        ) {
            Text(
                text = "Audio Equalizer & DSP",
                style = MaterialTheme.typography.titleLarge.copy(
                    fontWeight = FontWeight.Bold,
                    color = TextPrimary
                )
            )
            Spacer(modifier = Modifier.height(16.dp))

            // Preset Pills
            var selectedPreset by remember { mutableStateOf("flat") }
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                audioEffectsController.presets.keys.forEach { preset ->
                    FilterChip(
                        selected = selectedPreset == preset,
                        onClick = {
                            selectedPreset = preset
                            audioEffectsController.applyPreset(preset)
                        },
                        label = { Text(preset.replaceFirstChar { it.uppercase() }) }
                    )
                }
            }

            Spacer(modifier = Modifier.height(24.dp))

            // Bass Boost Slider
            var bassBoostVal by remember { mutableFloatStateOf(0f) }
            Text(
                text = "Bass Boost: ${(bassBoostVal * 100).toInt()}%",
                style = MaterialTheme.typography.bodyMedium.copy(color = TextSecondary)
            )
            Slider(
                value = bassBoostVal,
                onValueChange = {
                    bassBoostVal = it
                    audioEffectsController.setBassBoostStrength((it * 1000).toInt())
                },
                valueRange = 0f..1f
            )

            Spacer(modifier = Modifier.height(16.dp))

            // Band sliders
            Text(
                text = "Equalizer Bands (60Hz, 230Hz, 910Hz, 3.6kHz, 14kHz)",
                style = MaterialTheme.typography.bodyMedium.copy(color = TextSecondary)
            )
            Spacer(modifier = Modifier.height(8.dp))

            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(140.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                val bandFrequencies = listOf("60Hz", "230Hz", "910Hz", "3.6k", "14k")
                bandFrequencies.forEachIndexed { index, freq ->
                    var gain by remember { mutableFloatStateOf(0f) }
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        modifier = Modifier.weight(1f)
                    ) {
                        Text(
                            text = "${gain.toInt()}dB",
                            style = MaterialTheme.typography.labelSmall.copy(color = TextMuted, fontSize = 10.sp)
                        )
                        Slider(
                            value = gain,
                            onValueChange = {
                                gain = it
                                audioEffectsController.setBandGain(index, it.toInt())
                            },
                            valueRange = -10f..10f,
                            modifier = Modifier.weight(1f)
                        )
                        Text(
                            text = freq,
                            style = MaterialTheme.typography.labelSmall.copy(color = TextSecondary, fontSize = 10.sp)
                        )
                    }
                }
            }

            Spacer(modifier = Modifier.height(24.dp))
        }
    }
}

