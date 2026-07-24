package com.pocketmind.hybridai.ui.navigation

/** All navigable destinations in the app. */
sealed class Routes(val route: String) {
    data object Onboarding : Routes("onboarding")
    data object Home : Routes("home")
    data object ChatList : Routes("chats")

    data object Chat : Routes("chat/{conversationId}") {
        const val ARG_CONVERSATION_ID = "conversationId"
        fun build(conversationId: String) = "chat/$conversationId"
    }

    data object Models : Routes("models")
    data object OrgServer : Routes("org_server")
    data object ImageStudio : Routes("image_studio")
    data object Diagnostics : Routes("diagnostics")
    data object Settings : Routes("settings")
    data object Prompts : Routes("prompts")
    data object Characters : Routes("characters")
    data object Backup : Routes("backup")
    data object SocAssist : Routes("soc_assist")
    data object Help : Routes("help")
    data object Storage : Routes("storage")
    data object BatchDocs : Routes("batch_docs")
    data object Runtime : Routes("runtime_power")
    data object Menu : Routes("menu")
}

/** Top-level destinations that show the bottom navigation bar. */
enum class TopLevelDestination(val route: String, val label: String) {
    HOME(Routes.Home.route, "Home"),
    CHATS(Routes.ChatList.route, "Chats"),
    MODELS(Routes.Models.route, "Models"),
    IMAGES(Routes.ImageStudio.route, "Images")
}

/** Secondary tools opened from the hamburger overflow list. */
data class OverflowNavItem(val label: String, val route: String)

val OverflowNavItems = listOf(
    OverflowNavItem("Org Server", Routes.OrgServer.route),
    OverflowNavItem("Runtime / Power", Routes.Runtime.route),
    OverflowNavItem("Diagnostics", Routes.Diagnostics.route),
    OverflowNavItem("Prompts", Routes.Prompts.route),
    OverflowNavItem("Characters", Routes.Characters.route),
    OverflowNavItem("SOC Assist", Routes.SocAssist.route),
    OverflowNavItem("Batch Docs", Routes.BatchDocs.route),
    OverflowNavItem("Storage", Routes.Storage.route),
    OverflowNavItem("Backup", Routes.Backup.route),
    OverflowNavItem("Help", Routes.Help.route),
    OverflowNavItem("Settings", Routes.Settings.route)
)
