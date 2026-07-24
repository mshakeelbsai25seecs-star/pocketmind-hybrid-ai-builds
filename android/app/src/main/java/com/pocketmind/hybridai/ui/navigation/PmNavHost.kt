package com.pocketmind.hybridai.ui.navigation

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Chat
import androidx.compose.material.icons.outlined.Home
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material.icons.outlined.Menu
import androidx.compose.material.icons.outlined.SmartToy
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.pocketmind.hybridai.data.repo.SettingsRepository
import com.pocketmind.hybridai.feature.backup.BackupScreen
import com.pocketmind.hybridai.feature.batchdocs.BatchDocsScreen
import com.pocketmind.hybridai.feature.characters.CharactersScreen
import com.pocketmind.hybridai.feature.chat.ChatListScreen
import com.pocketmind.hybridai.feature.chat.ChatScreen
import com.pocketmind.hybridai.feature.diagnostics.DiagnosticsScreen
import com.pocketmind.hybridai.feature.help.HelpScreen
import com.pocketmind.hybridai.feature.home.HomeScreen
import com.pocketmind.hybridai.feature.imagestudio.ImageStudioScreen
import com.pocketmind.hybridai.feature.models.ModelsScreen
import com.pocketmind.hybridai.feature.onboarding.OnboardingScreen
import com.pocketmind.hybridai.feature.orgserver.OrgServerScreen
import com.pocketmind.hybridai.feature.prompts.PromptsScreen
import com.pocketmind.hybridai.feature.runtime.RuntimePowerScreen
import com.pocketmind.hybridai.feature.settings.SettingsScreen
import com.pocketmind.hybridai.feature.socassist.SocAssistScreen
import com.pocketmind.hybridai.feature.storage.StorageScreen
import com.pocketmind.hybridai.ui.components.PmCard
import com.pocketmind.hybridai.ui.components.PmTopBar
import com.pocketmind.hybridai.ui.theme.PmGreen
import com.pocketmind.hybridai.ui.theme.PmTheme
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject

@HiltViewModel
class AppShellViewModel @Inject constructor(
    val settings: SettingsRepository
) : ViewModel()

private data class Tab(val dest: TopLevelDestination, val icon: ImageVector)

@Composable
fun PmApp(vm: AppShellViewModel = hiltViewModel()) {
    val themeMode by vm.settings.themeMode.collectAsState()
    val onboardingDone by vm.settings.onboardingDone.collectAsState()
    PmTheme(themeMode = themeMode) {
        val nav = rememberNavController()
        val start = if (onboardingDone) Routes.Home.route else Routes.Onboarding.route
        val backStack by nav.currentBackStackEntryAsState()
        val current = backStack?.destination?.route
        val tabs = listOf(
            Tab(TopLevelDestination.HOME, Icons.Outlined.Home),
            Tab(TopLevelDestination.CHATS, Icons.AutoMirrored.Outlined.Chat),
            Tab(TopLevelDestination.MODELS, Icons.Outlined.SmartToy),
            Tab(TopLevelDestination.IMAGES, Icons.Outlined.Image)
        )
        val showBar = tabs.any { it.dest.route == current }

        Scaffold(
            containerColor = MaterialTheme.colorScheme.background,
            topBar = {
                if (showBar) {
                    PmTopBar(
                        title = "PocketMind",
                        actions = {
                            IconButton(onClick = { nav.navigate(Routes.Menu.route) }) {
                                Icon(Icons.Outlined.Menu, contentDescription = "Tools menu")
                            }
                        }
                    )
                }
            },
            bottomBar = {
                if (showBar) {
                    NavigationBar(
                        containerColor = MaterialTheme.colorScheme.background,
                        tonalElevation = 0.dp
                    ) {
                        tabs.forEach { tab ->
                            val selected = current == tab.dest.route
                            NavigationBarItem(
                                selected = selected,
                                onClick = {
                                    nav.navigate(tab.dest.route) {
                                        popUpTo(nav.graph.findStartDestination().id) { saveState = true }
                                        launchSingleTop = true
                                        restoreState = true
                                    }
                                },
                                icon = { Icon(tab.icon, contentDescription = tab.dest.label) },
                                label = {
                                    Text(tab.dest.label, style = MaterialTheme.typography.labelSmall)
                                },
                                colors = NavigationBarItemDefaults.colors(
                                    selectedIconColor = PmGreen,
                                    selectedTextColor = PmGreen,
                                    indicatorColor = PmGreen.copy(alpha = 0.12f),
                                    unselectedIconColor = MaterialTheme.colorScheme.onSurfaceVariant,
                                    unselectedTextColor = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            )
                        }
                    }
                }
            }
        ) { padding ->
            NavHost(
                navController = nav,
                startDestination = start,
                modifier = Modifier.padding(padding)
            ) {
                composable(Routes.Onboarding.route) {
                    OnboardingScreen(
                        onDone = {
                            vm.settings.completeOnboarding()
                            nav.navigate(Routes.Home.route) {
                                popUpTo(Routes.Onboarding.route) { inclusive = true }
                            }
                        }
                    )
                }
                composable(Routes.Home.route) {
                    HomeScreen(
                        onOpenChats = { nav.navigate(Routes.ChatList.route) },
                        onOpenOrg = { nav.navigate(Routes.OrgServer.route) },
                        onOpenModels = { nav.navigate(Routes.Models.route) },
                        onOpenImages = { nav.navigate(Routes.ImageStudio.route) }
                    )
                }
                composable(Routes.ChatList.route) {
                    ChatListScreen(
                        onOpenChat = { id -> nav.navigate(Routes.Chat.build(id)) },
                        onNewChat = { id -> nav.navigate(Routes.Chat.build(id)) }
                    )
                }
                composable(
                    route = Routes.Chat.route,
                    arguments = listOf(
                        navArgument(Routes.Chat.ARG_CONVERSATION_ID) { type = NavType.StringType }
                    )
                ) { entry ->
                    val id = entry.arguments?.getString(Routes.Chat.ARG_CONVERSATION_ID).orEmpty()
                    ChatScreen(conversationId = id, onBack = { nav.popBackStack() })
                }
                composable(Routes.Models.route) { ModelsScreen() }
                composable(Routes.ImageStudio.route) { ImageStudioScreen() }
                composable(Routes.Menu.route) {
                    OverflowMenuScreen(
                        onBack = { nav.popBackStack() },
                        onNavigate = { route ->
                            nav.popBackStack()
                            nav.navigate(route)
                        }
                    )
                }
                composable(Routes.OrgServer.route) {
                    OrgServerScreen(onBack = { nav.popBackStack() })
                }
                composable(Routes.Runtime.route) {
                    RuntimePowerScreen(onBack = { nav.popBackStack() })
                }
                composable(Routes.Diagnostics.route) {
                    DiagnosticsScreen(onBack = { nav.popBackStack() })
                }
                composable(Routes.Settings.route) {
                    SettingsScreen(onBack = { nav.popBackStack() })
                }
                composable(Routes.Prompts.route) {
                    PromptsScreen(onBack = { nav.popBackStack() })
                }
                composable(Routes.Characters.route) {
                    CharactersScreen(onBack = { nav.popBackStack() })
                }
                composable(Routes.Backup.route) {
                    BackupScreen(onBack = { nav.popBackStack() })
                }
                composable(Routes.SocAssist.route) {
                    SocAssistScreen(onBack = { nav.popBackStack() })
                }
                composable(Routes.Help.route) {
                    HelpScreen(onBack = { nav.popBackStack() })
                }
                composable(Routes.Storage.route) {
                    StorageScreen(onBack = { nav.popBackStack() })
                }
                composable(Routes.BatchDocs.route) {
                    BatchDocsScreen(onBack = { nav.popBackStack() })
                }
            }
        }
    }
}

@Composable
private fun OverflowMenuScreen(
    onBack: () -> Unit,
    onNavigate: (String) -> Unit
) {
    androidx.compose.foundation.layout.Column {
        PmTopBar(title = "Tools", onBack = onBack)
        LazyColumn(
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            item {
                Text(
                    "Secondary features stay here so the home tabs stay focused.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(bottom = 8.dp)
                )
            }
            items(OverflowNavItems, key = { it.route }) { item ->
                PmCard(onClick = { onNavigate(item.route) }) {
                    Text(item.label, style = MaterialTheme.typography.titleMedium)
                }
            }
        }
    }
}
