# PocketMind Hybrid AI — Android

Continuation of the Play listing **`com.pocketmind.hybridai`**.

| Field | Value |
|-------|--------|
| applicationId | `com.pocketmind.hybridai` |
| versionName | `1.0.2` |
| versionCode | `3` |
| minSdk | 26 |
| targetSdk | 35 |

## Theme

UI follows a **conductor.build** aesthetic: true black canvas, JetBrains Mono, green `#22C55E` status/CTA accents, thin borders, compact radii.

## Build

Requirements: JDK 17+, Android SDK (see `local.properties`).

```bat
cd android
copy keystore.properties.example keystore.properties
REM edit keystore.properties to point at D:\AndroidKeys\pocketmind-upload-key.jks
gradlew.bat assembleRelease
gradlew.bat bundleRelease
```

Outputs:

- `app/build/outputs/apk/release/app-release.apk`
- `app/build/outputs/bundle/release/app-release.aab`

**Never commit** `keystore.properties`, `local.properties`, or `*.jks`.

## Features

- Chats with Org Server / Free (Groq, Gemini, OpenRouter) / Premium / Local GGUF
- Live provider probes (no dead hardcoded model IDs as always-available)
- Image Studio via `gen.pollinations.ai` + Hugging Face failover
- Attachments (text), prompts, characters, SOC Assist drafts, diagnostics, backup
- Local GGUF import; generation requires `llama-cli`/`llama-server` in app `filesDir/bin`

See [PLAY_RELEASE_CHECKLIST.md](PLAY_RELEASE_CHECKLIST.md).
