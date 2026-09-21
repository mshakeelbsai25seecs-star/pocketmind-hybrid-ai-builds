# Microsoft Store rejection fix — Policy 10.2.9 (code signing)

## What failed

| Field | Value |
|-------|--------|
| Policy | **10.2.9 Security - Package Submissions** |
| Result | **Unsigned** — "Package should be signed with SHA256 or higher algorithm" |
| Product | PocketMind AI (`c2aea639-62fc-4bda-b565-4f1ae4f70e9a`) |
| Review date | 09/04/2026 |
| Package URL in report | `.../1.0.0/PocketMind Hybrid AI_1.0.0_x64-setup.exe` (**spaces in filename**) |

Microsoft Store **does not** re-sign classic Win32 EXE/MSI installers. For products submitted via an HTTPS Package URL, policy 10.2.9 requires:

1. The installer binary (`.exe` / `.msi`) is Authenticode-signed with **SHA-256+**
2. **Every PE file inside** (app exe, `llama-server.exe`, DLLs, …) is signed the same way
3. The certificate must chain to a CA in the **Microsoft Trusted Root Program**
4. **Self-signed certificates are rejected**

Notes / waivers will not clear this. Resubmitting the same unsigned setup.exe will fail again.

Your product in Partner Center is an **EXE/MSI (URL)** app. You cannot upload an `.msix` into that listing without Microsoft changing the product type. The fix that keeps this listing is: **sign the Store-safe CPU-only setup.exe**.

## Also fix the Package URL filename

The certification report shows a URL with **spaces**:

`PocketMind Hybrid AI_1.0.0_x64-setup.exe`

Always upload and paste the hyphenated key (no spaces):

```text
https://pub-4d3aca60dcc04c09ae0f1450f6ccf8c5.r2.dev/1.0.0/PocketMind-Hybrid-AI_1.0.0_x64-setup.exe
```

## Choose a signing certificate

| Option | Cost | Who can use it | Store OK? |
|--------|------|----------------|-----------|
| **OV/EV code-signing cert** (DigiCert, Sectigo, GlobalSign, …) | ~$150–400/yr + HSM/token | Worldwide (recommended for your publisher location) | Yes |
| **Azure Artifact Signing** (Trusted Signing) | ~$9.99/mo | Orgs: US/CA/EU/UK. Individuals: **US/CA only** | Yes |
| Self-signed / no signature | Free | Anyone | **No** |
| MSIX + Store re-sign | Free signing | Requires **MSIX product type** (support ticket or new listing) | Yes (different package type) |

If you are an individual publisher outside the US/Canada, buy an **OV code-signing certificate**. Azure Artifact Signing will not be available to you as an individual.

### After you have a cert (OV/EV)

1. Install the vendor’s hardware token / cloud HSM client and import the cert into Windows (`certmgr.msc` → Personal → Certificates).
2. Copy the certificate **SHA1 thumbprint** (no spaces).
3. Install Windows SDK **SignTool** (Visual Studio Build Tools / Windows SDK).

### After you have Azure Artifact Signing (if eligible)

1. Create an Artifact Signing account + identity validation + certificate profile in Azure.
2. `winget install -e --id Microsoft.Azure.ArtifactSigningClientTools`
3. Copy `distribution/windows-desktop/trusted-signing.metadata.example.json` to a private path and fill in Endpoint / account / profile names.
4. `az login` (or other DefaultAzureCredential) as a user with the Certificate Profile Signer role.

## Build the signed Store package (Windows PC)

```powershell
cd D:\nexus-ai-deep-fixed
git fetch origin cursor/android-studio-setup-7411
git checkout origin/cursor/android-studio-setup-7411 -- `
  scripts/Sign-PeFiles.ps1 `
  scripts/Verify-StorePackageSignatures.ps1 `
  scripts/BUILD-STORE-SIGNED-INSTALLER.ps1 `
  scripts/BUILD-STORE-INSTALLER.ps1 `
  scripts/build-desktop-windows.ps1 `
  scripts/prepare-windows-bundle-runtimes.ps1 `
  distribution/windows-desktop/STORE_RESUBMIT_10_2_9.md `
  distribution/windows-desktop/trusted-signing.metadata.example.json
```

### Path A — OV/EV thumbprint

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\BUILD-STORE-SIGNED-INSTALLER.ps1 `
  -CertificateThumbprint "PASTE_FULL_THUMBPRINT_HERE"
```

### Path B — Azure Artifact Signing

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\BUILD-STORE-SIGNED-INSTALLER.ps1 `
  -TrustedSigningMetadata "D:\secrets\trusted-signing.json"
```

Expected output:

- `distribution\windows-desktop\store-upload\PocketMind-Hybrid-AI_1.0.0_x64-setup.exe`
- Script verifies Authenticode **Valid** on setup.exe, app PE files, and CPU llama.cpp PE files
- Package remains **CPU-only** (still satisfies 10.2.4.2)

Manual verify anytime:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\Verify-StorePackageSignatures.ps1 `
  -Path "D:\nexus-ai-deep-fixed\distribution\windows-desktop\store-upload" -Recurse
```

## Upload to R2 (overwrite / versioned key, no spaces)

```powershell
aws s3 cp `
  "D:\nexus-ai-deep-fixed\distribution\windows-desktop\store-upload\PocketMind-Hybrid-AI_1.0.0_x64-setup.exe" `
  "s3://pocketmind-windows-installers/1.0.0/PocketMind-Hybrid-AI_1.0.0_x64-setup.exe" `
  --endpoint-url "https://85923c633de5b11ab9440c12142583ae.r2.cloudflarestorage.com" `
  --content-type "application/octet-stream"
```

Prefer a **new versioned key** if Partner Center cached the old binary, e.g. `1.0.0-signed/...`.

Verify before pasting into Partner Center:

```powershell
curl.exe -sI --max-redirs 0 "https://pub-4d3aca60dcc04c09ae0f1450f6ccf8c5.r2.dev/1.0.0/PocketMind-Hybrid-AI_1.0.0_x64-setup.exe"
```

Need HTTP 200, no `Location:`, and **no spaces** in the URL.

## Partner Center resubmit checklist

1. Apps and games → PocketMind AI → new submission / update
2. **Packages**
   - Package URL = hyphenated R2 URL above (signed file)
   - Installer type: EXE
   - Silent: `/S`
   - Architecture: x64
3. **Properties → Product declarations**
   - **UNCHECK** non-Microsoft drivers / NT services (CPU-only package)
   - Generative AI: keep checked
4. **Notes for certification**:

```text
RE: 10.2.9 (unsigned) + prior 10.2.4.2 (Product ID c2aea639-62fc-4bda-b565-4f1ae4f70e9a)

This resubmission addresses both prior failures:

10.2.9 Code signing
- setup.exe and all bundled PE files (app executable, llama-server.exe, and supporting DLLs)
  are Authenticode-signed with SHA-256 using a certificate that chains to the Microsoft
  Trusted Root Program.

10.2.4.2 Drivers
- Store package remains CPU-only llama.cpp. No CUDA/Vulkan folders, no .sys drivers,
  no NT services, no driver installers.

Silent install: setup.exe /S
Support: support.pocketmind@gmail.com | +92 340 5055603
```

5. Submit

## Optional later: switch product type to MSIX (free Store signing)

MSIX is free to sign via the Store, but Partner Center **cannot** upload MSIX into an existing EXE/MSI URL product. You must either:

- Open Partner Center support and ask to convert product type EXE/MSI → MSIX/PWA for product ID `c2aea639-62fc-4bda-b565-4f1ae4f70e9a`, **or**
- Delete/release the name and create a new MSIX product (Microsoft’s rejection text mentions this)

Scaffold and steps: `distribution/windows-desktop/msix/README.md`

## Do not do

- Do not resubmit the unsigned setup.exe again
- Do not use a self-signed test certificate for Store
- Do not paste a Package URL with spaces (`PocketMind Hybrid AI_...`)
- Do not resubmit the ~1 GB fat CUDA/Vulkan installer
- Do not expect certification notes alone to waive 10.2.9
