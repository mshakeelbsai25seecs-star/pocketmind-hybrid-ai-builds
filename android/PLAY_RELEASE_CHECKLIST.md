# Play release checklist — PocketMind Hybrid AI 1.0.2 (3)

## Identity

- [ ] `applicationId` is `com.pocketmind.hybridai` (no `.debug` suffix on release)
- [ ] `versionName` = `1.0.2`, `versionCode` = `3`
- [ ] Signed with upload keystore `pocketmind-upload-key.jks` / alias `PocketMind`

## Build

- [ ] `gradlew.bat clean bundleRelease` succeeds
- [ ] AAB opens in Play Console as an update to the existing listing

## Smoke — free chat (live)

- [ ] Add Groq key → Models → Refresh → `llama-3.1-8b-instant` or `llama-3.3-70b-versatile` usable
- [ ] Add Gemini key → `gemini-2.5-flash` usable
- [ ] Deprecated IDs are not required for the happy path

## Smoke — free image (live)

- [ ] Image Studio generate via `gen.pollinations.ai` succeeds OR fails over to HF with token
- [ ] App does not depend solely on legacy `image.pollinations.ai`

## Smoke — org / local

- [ ] Org Server Test connection lists models; chat streams
- [ ] Import GGUF listed under Local; diagnostics shows Vulkan/CPU honestly
- [ ] Without native binary, local generate shows clear unavailable message (no fake AI)

## UX

- [ ] Dark conductor theme (JetBrains Mono, black, green accents) on phone + tablet widths
- [ ] Bottom nav: Home / Chats / Models / Images / More
- [ ] Backup export/import chats without leaking API keys
