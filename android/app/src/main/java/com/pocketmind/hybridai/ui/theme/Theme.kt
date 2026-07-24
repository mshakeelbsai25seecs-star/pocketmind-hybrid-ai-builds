package com.pocketmind.hybridai.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import com.pocketmind.hybridai.data.repo.ThemeMode

/**
 * Dark scheme mirrors conductor.build: pure black, white type, green primary CTA.
 * Light scheme keeps the same mono + green language on an off-white canvas.
 */
private val PmDarkColorScheme = darkColorScheme(
    primary = PmGreen,
    onPrimary = PmBlack,
    primaryContainer = PmGreenSoft,
    onPrimaryContainer = PmGreen,
    secondary = PmWhite,
    onSecondary = PmBlack,
    secondaryContainer = PmPanelElevated,
    onSecondaryContainer = PmOffWhite,
    tertiary = PmGreenDim,
    background = PmBlack,
    onBackground = PmWhite,
    surface = PmNearBlack,
    onSurface = PmWhite,
    surfaceVariant = PmPanel,
    onSurfaceVariant = PmMuted,
    outline = PmBorder,
    outlineVariant = PmBorderSubtle,
    error = PmError,
    errorContainer = PmErrorSoft,
    onError = PmBlack,
    inversePrimary = PmGreenDim,
    inverseSurface = PmOffWhite,
    inverseOnSurface = PmBlack
)

private val ColorSoftGreenLight = androidx.compose.ui.graphics.Color(0xFFDCFCE7)

private val PmLightColorScheme = lightColorScheme(
    primary = PmGreenDim,
    onPrimary = PmWhite,
    primaryContainer = ColorSoftGreenLight,
    onPrimaryContainer = PmGreenSoft,
    secondary = PmLightText,
    onSecondary = PmWhite,
    secondaryContainer = PmLightPanel,
    onSecondaryContainer = PmLightText,
    tertiary = PmGreen,
    background = PmLightBg,
    onBackground = PmLightText,
    surface = PmLightPanel,
    onSurface = PmLightText,
    surfaceVariant = PmOffWhite,
    onSurfaceVariant = PmLightMuted,
    outline = PmLightBorder,
    outlineVariant = PmLightBorder,
    error = PmError,
    errorContainer = PmErrorSoft,
    onError = PmWhite
)

@Composable
fun PmTheme(
    themeMode: ThemeMode = ThemeMode.DARK,
    content: @Composable () -> Unit
) {
    val darkTheme = when (themeMode) {
        ThemeMode.SYSTEM -> isSystemInDarkTheme()
        ThemeMode.LIGHT -> false
        ThemeMode.DARK -> true
    }
    MaterialTheme(
        colorScheme = if (darkTheme) PmDarkColorScheme else PmLightColorScheme,
        typography = PmTypography,
        shapes = PmShapes,
        content = content
    )
}
