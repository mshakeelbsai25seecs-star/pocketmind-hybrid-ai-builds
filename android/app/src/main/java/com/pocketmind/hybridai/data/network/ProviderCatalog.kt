package com.pocketmind.hybridai.data.network

/** The four model "tabs" shown across Models/Chat/OrgServer screens. */
enum class ModelKind { LOCAL, ORG, FREE, PREMIUM }

/** A statically known model that seeds the Models screen before/without a live probe. */
data class SeedModel(
    val providerId: String,
    val providerLabel: String,
    val modelId: String,
    val label: String,
    val kind: ModelKind,
    val contextLength: Int? = null,
    val notes: String? = null
)

/**
 * Curated catalog of provider base URLs and starter model lists.
 *
 * Model ids known to be routinely retired by their providers (e.g. `qwen-qwq-32b`,
 * `gemini-1.5-flash`, `gemini-2.0-flash`) are deliberately NOT seeded here. They
 * should only ever appear in the app if [ProviderHealthRepository]'s live probe
 * actually returns them for the current account/region.
 */
object ProviderCatalog {
    const val GROQ_BASE = "https://api.groq.com/openai/v1/"
    const val OPENROUTER_BASE = "https://openrouter.ai/api/v1/"
    const val DEEPSEEK_BASE = "https://api.deepseek.com/v1/"
    const val MISTRAL_BASE = "https://api.mistral.ai/v1/"
    const val TOGETHER_BASE = "https://api.together.xyz/v1/"
    const val HF_ROUTER_BASE = "https://router.huggingface.co/v1/"
    const val GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/"
    const val POLLINATIONS_IMAGE_BASE = "https://gen.pollinations.ai/image/"
    const val POLLINATIONS_MODELS_URL = "https://gen.pollinations.ai/image/models"
    const val HF_INFERENCE_BASE = "https://api-inference.huggingface.co/models/"

    /** Free-tier chat models worth trying first; ordered by general quality/speed trade-off. */
    val FREE_SEED_MODELS: List<SeedModel> = listOf(
        SeedModel("groq", "Groq", "llama-3.1-8b-instant", "Llama 3.1 8B Instant", ModelKind.FREE, 131072, "Fastest free option"),
        SeedModel("groq", "Groq", "llama-3.3-70b-versatile", "Llama 3.3 70B Versatile", ModelKind.FREE, 131072, "Best free quality"),
        SeedModel("gemini", "Google Gemini", "gemini-2.5-flash", "Gemini 2.5 Flash", ModelKind.FREE, 1048576, "Free tier via Google AI Studio key"),
        SeedModel("gemini", "Google Gemini", "gemini-2.5-flash-lite", "Gemini 2.5 Flash-Lite", ModelKind.FREE, 1048576, "Lower latency, smaller free quota cost")
    )

    /** Premium / pay-as-you-go models that require a funded account with the provider. */
    val PREMIUM_SEED_MODELS: List<SeedModel> = listOf(
        SeedModel("openrouter", "OpenRouter", "openai/gpt-4o", "GPT-4o (via OpenRouter)", ModelKind.PREMIUM, 128000),
        SeedModel("openrouter", "OpenRouter", "openai/gpt-4.1", "GPT-4.1 (via OpenRouter)", ModelKind.PREMIUM, 1048576),
        SeedModel("openrouter", "OpenRouter", "anthropic/claude-3.5-sonnet", "Claude 3.5 Sonnet (via OpenRouter)", ModelKind.PREMIUM, 200000),
        SeedModel("openrouter", "OpenRouter", "anthropic/claude-opus-4", "Claude Opus (via OpenRouter)", ModelKind.PREMIUM, 200000),
        SeedModel("openrouter", "OpenRouter", "z-ai/glm-5.2", "GLM-5.2 (via OpenRouter)", ModelKind.PREMIUM, 1000000, "Frontier long-horizon coding/agent model"),
        SeedModel("openrouter", "OpenRouter", "meta-llama/llama-3.1-405b-instruct", "Llama 3.1 405B (via OpenRouter)", ModelKind.PREMIUM, 131072, "Frontier 405B-class"),
        SeedModel("openrouter", "OpenRouter", "meta-llama/llama-3.3-70b-instruct", "Llama 3.3 70B (via OpenRouter)", ModelKind.PREMIUM, 131072),
        SeedModel("openrouter", "OpenRouter", "qwen/qwen-2.5-72b-instruct", "Qwen 2.5 72B (via OpenRouter)", ModelKind.PREMIUM, 131072),
        SeedModel("openrouter", "OpenRouter", "deepseek/deepseek-chat-v3-0324", "DeepSeek V3 (via OpenRouter)", ModelKind.PREMIUM, 64000),
        SeedModel("openrouter", "OpenRouter", "cohere/command-r-plus", "Command R+ (via OpenRouter)", ModelKind.PREMIUM, 128000),
        SeedModel("deepseek", "DeepSeek", "deepseek-chat", "DeepSeek Chat V3", ModelKind.PREMIUM, 64000),
        SeedModel("deepseek", "DeepSeek", "deepseek-reasoner", "DeepSeek Reasoner (R1)", ModelKind.PREMIUM, 64000),
        SeedModel("mistral", "Mistral", "mistral-large-latest", "Mistral Large", ModelKind.PREMIUM, 128000),
        SeedModel("together", "Together AI", "meta-llama/Llama-3.3-70B-Instruct-Turbo", "Llama 3.3 70B Turbo (Together)", ModelKind.PREMIUM, 131072),
        SeedModel("together", "Together AI", "meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo", "Llama 3.1 405B Turbo (Together)", ModelKind.PREMIUM, 131072, "Hosted 405B-class")
    )

    /** Pollinations text-to-image models served from [POLLINATIONS_IMAGE_BASE]. */
    val IMAGE_MODELS: List<String> = listOf("flux", "flux-realism", "turbo", "any-dark")

    /** Fallback Hugging Face image model used when Pollinations fails and an HF token is set. */
    const val HF_FALLBACK_IMAGE_MODEL = "black-forest-labs/FLUX.1-schnell"

    fun baseUrlFor(providerId: String): String? = when (providerId) {
        "groq" -> GROQ_BASE
        "openrouter" -> OPENROUTER_BASE
        "deepseek" -> DEEPSEEK_BASE
        "mistral" -> MISTRAL_BASE
        "together" -> TOGETHER_BASE
        "hf" -> HF_ROUTER_BASE
        else -> null
    }
}
