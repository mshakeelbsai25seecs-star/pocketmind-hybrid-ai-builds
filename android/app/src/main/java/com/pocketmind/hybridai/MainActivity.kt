package com.pocketmind.hybridai

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.pocketmind.hybridai.ui.navigation.PmApp
import dagger.hilt.android.AndroidEntryPoint

/**
 * Single-activity host for the whole app. All UI lives in Compose; navigation
 * between features is handled by [PmApp] / PmNavHost.
 */
@AndroidEntryPoint
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            PmApp()
        }
    }
}
