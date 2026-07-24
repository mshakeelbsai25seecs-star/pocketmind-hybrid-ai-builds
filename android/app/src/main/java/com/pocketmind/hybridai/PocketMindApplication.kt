package com.pocketmind.hybridai

import android.app.Application
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import com.pocketmind.hybridai.data.repo.SettingsRepository
import com.pocketmind.hybridai.engine.llama.LocalLlamaEngine
import dagger.hilt.android.HiltAndroidApp
import javax.inject.Inject

/**
 * Application entry point. Hilt generates the DI container graph rooted here;
 * see [com.pocketmind.hybridai.di.AppModule] for the bindings that are available
 * app-wide (network client, database, secure storage, preferences, etc).
 */
@HiltAndroidApp
class PocketMindApplication : Application() {

    @Inject lateinit var settings: SettingsRepository
    @Inject lateinit var localEngine: LocalLlamaEngine

    override fun onCreate() {
        super.onCreate()
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStop(owner: LifecycleOwner) {
                if (settings.sleepOnBackground.value) {
                    localEngine.stop()
                }
            }
        })
    }
}
