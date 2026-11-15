package com.prata.remote.agent.ui

// PRATA Remote — Tema Agent (Command 002, Tugas 2)
// Midnight Navy + Glassmorphism aksen cyan — sama dengan web dashboard.
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val NavyBackground = Color(0xFF080D18)
private val NavySurface = Color(0xFF111B2B)
private val CyanAccent = Color(0xFF50D8F5)
private val OnNavy = Color(0xFFE8EEF7)

private val PrataColors = darkColorScheme(
    primary = CyanAccent,
    onPrimary = Color(0xFF06222B),
    background = NavyBackground,
    onBackground = OnNavy,
    surface = NavySurface,
    onSurface = OnNavy,
    surfaceVariant = Color(0xFF1A2740),
    onSurfaceVariant = Color(0xFF9FB0C9),
    error = Color(0xFFFF7A7A),
)

@Composable
fun PrataTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = PrataColors, content = content)
}
