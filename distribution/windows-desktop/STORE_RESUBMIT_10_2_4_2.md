# Microsoft Store rejection fix — Policy 10.2.4.2

## Why notes / waivers failed twice

Policy 10.2.4.2:

> Dependency on non-Microsoft provided driver(s) or NT service(s) is not allowed.
> Exceptions may be considered case by case (typically WHCP / OEM / partner accounts).

Microsoft Q&A confirms: for normal publisher accounts, **disclosing in certification notes does not grant a waiver**. Resubmitting the same fat installer with better notes will keep failing.

Your fat Store package embeds llama.cpp **CUDA** and **Vulkan** user-mode DLLs
(`cudart*.dll`, `cublas*.dll`, Vulkan/ggml DLLs). Certification scans the Surface
Laptop install and flags them under 10.2.4.2 even though they are not `.sys` kernel drivers.

## The real fix

Ship a **Store-safe setup.exe** that embeds **CPU-only** llama.cpp.

- CUDA / Vulkan are **not** in the Store installer
- Users who want GPU acceleration install those runtimes **after** install
  (`scripts\INSTALL-LLAMA-RUNTIMES.cmd` or in-app Runtime Manager)
- Uncheck the Product declaration about non-Microsoft drivers

Keep the full fat installer for your website / direct downloads if you want; just
do **not** use it as the Microsoft Store Package URL.

## Build the Store-safe package (on your Windows PC)

```powershell
cd D:\nexus-ai-deep-fixed
git fetch origin cursor/android-studio-setup-7411
git checkout origin/cursor/android-studio-setup-7411 -- `
  scripts/BUILD-STORE-INSTALLER.ps1 `
  scripts/build-desktop-windows.ps1 `
  scripts/prepare-windows-bundle-runtimes.ps1 `
  distribution/windows-desktop/STORE_RESUBMIT_10_2_4_2.md

powershell -ExecutionPolicy Bypass -File .\scripts\BUILD-STORE-INSTALLER.ps1
```

Expected result:

- `...\bundle\nsis\PocketMind Hybrid AI_1.0.0_x64-setup.exe`
- Much smaller than the ~1 GB fat package (CPU only)
- Build script verifies `src-tauri\resources\llama.cpp` has **no** `cuda\` or `vulkan\`

Optional sanity check before upload:

```powershell
$setup = "D:\nexus-ai-deep-fixed\distribution\windows-desktop\payload\PocketMind Hybrid AI_1.0.0_x64-setup.exe"
# Confirm resources after build:
Get-ChildItem "D:\nexus-ai-deep-fixed\src-tauri\resources\llama.cpp" -Directory | Select-Object Name
# Should list only: cpu
```

## Host the new setup.exe (direct URL, no redirect)

Re-upload to Cloudflare R2 (same bucket / public URL path), overwriting:

`1.0.0/PocketMind-Hybrid-AI_1.0.0_x64-setup.exe`

Use the AWS CLI flow you already used (`aws s3 cp ... --endpoint-url ...`).

Verify:

```powershell
curl.exe -sI --max-redirs 0 "https://pub-4d3aca60dcc04c09ae0f1450f6ccf8c5.r2.dev/1.0.0/PocketMind-Hybrid-AI_1.0.0_x64-setup.exe"
```

Need HTTP 200, no `Location:`, and a **smaller Content-Length** than the old ~1 GB fat build.

## Partner Center resubmit checklist

1. Apps and games → PocketMind AI → **Update** / create new submission
2. **Packages**
   - Package URL stays the same R2 URL (after you overwrite the file), **or** bump to a new versioned path if you prefer
   - Installer type: EXE
   - Silent: `/S`
   - Architecture: x64
3. **Properties → Product declarations**
   - **UNCHECK** `This product depends on non-Microsoft drivers or NT services.`
   - Generative AI: keep **checked**
4. **Properties → Notes for certification** — replace with:

```text
RE: Prior 10.2.4.2 rejection (Product ID c2aea639-62fc-4bda-b565-4f1ae4f70e9a)

This resubmission removes the previously flagged non-Microsoft GPU runtime libraries from the Store installer.

What changed
- Previous package embedded llama.cpp CUDA and Vulkan user-mode DLLs for optional GPU acceleration.
- This package embeds CPU llama.cpp only (llama-server.exe + supporting CPU DLLs under resources\llama.cpp\cpu\).
- No CUDA folders, no Vulkan folders, no .sys kernel drivers, no NT services, and no driver installers are included.

How GPU users get acceleration (optional, after install)
- Users may separately download/install CUDA/Vulkan llama.cpp runtimes via the product's Runtime Manager / installer helper.
- That optional download is NOT part of this Store package.

Certification test path (Surface Laptop)
1. Silent install: setup.exe /S
2. Launch PocketMind Hybrid AI
3. Open Settings → Runtime / Models
4. Confirm app runs using the bundled CPU runtime
5. No GPU driver installation prompts should appear

Support: support.pocketmind@gmail.com | +92 340 5055603
```

5. **Store listing → Description** — replace the old top Note with:

```text
Note: This Store package includes the app and a CPU local-inference runtime. Optional GPU acceleration (CUDA/Vulkan) can be added after install from the app’s Runtime Manager if your hardware supports it. No kernel drivers or Windows services are installed.
```

6. Save all sections → **Submit to the Store**

## Do not do

- Do not resubmit the ~1 GB fat installer
- Do not keep the non-Microsoft drivers checkbox checked for this package
- Do not rely on another policy-waiver note alone — that already failed twice
