#!/usr/bin/env bash
# Idempotent installer for Android Studio + SDK packages needed by
# PocketMind Hybrid AI (android/ — compileSdk 35, AGP 8.7, JDK 17+).
set -euo pipefail

STUDIO_VERSION="${STUDIO_VERSION:-2026.1.3.8}"
STUDIO_ARCHIVE="${STUDIO_ARCHIVE:-android-studio-quail3-patch1-linux.tar.gz}"
STUDIO_URL="${STUDIO_URL:-https://edgedl.me.gvt1.com/android/studio/ide-zips/${STUDIO_VERSION}/${STUDIO_ARCHIVE}}"
STUDIO_SHA256="${STUDIO_SHA256:-5bd5ee5d6e747b13f82fba3241380bd358cc2f4a847815c8e860757df13dc35f}"
CMDLINE_TOOLS_URL="${CMDLINE_TOOLS_URL:-https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip}"

INSTALL_ROOT="${INSTALL_ROOT:-/opt}"
SDK_ROOT="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/Android/Sdk}}"
DOWNLOAD_DIR="${DOWNLOAD_DIR:-$HOME/Downloads}"
AVD_NAME="${AVD_NAME:-pocketmind_api35}"

mkdir -p "$DOWNLOAD_DIR" "$SDK_ROOT"

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

need_cmd curl
need_cmd unzip
need_cmd tar
need_cmd java

echo "==> Ensuring system libraries for Android Studio (Ubuntu/Debian)..."
if command -v apt-get >/dev/null 2>&1; then
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    wget curl unzip zip tar \
    libncurses6 libstdc++6 zlib1g libbz2-1.0 \
    libnss3 libnspr4 libx11-6 libxext6 libxrender1 libxi6 libxtst6 \
    libxkbcommon0 libdbus-1-3 libglib2.0-0 libfontconfig1 libfreetype6 \
    fontconfig ca-certificates >/dev/null
fi

if [ ! -x "$INSTALL_ROOT/android-studio/bin/studio.sh" ]; then
  echo "==> Downloading Android Studio (${STUDIO_VERSION})..."
  ARCHIVE_PATH="$DOWNLOAD_DIR/$STUDIO_ARCHIVE"
  if [ ! -f "$ARCHIVE_PATH" ]; then
    curl -fL --progress-bar -o "$ARCHIVE_PATH" "$STUDIO_URL"
  fi
  echo "$STUDIO_SHA256  $ARCHIVE_PATH" | sha256sum -c -
  echo "==> Extracting Android Studio to $INSTALL_ROOT/android-studio..."
  sudo rm -rf "$INSTALL_ROOT/android-studio"
  sudo tar -xzf "$ARCHIVE_PATH" -C "$INSTALL_ROOT"
  sudo ln -sfn "$INSTALL_ROOT/android-studio/bin/studio.sh" /usr/local/bin/android-studio
  sudo ln -sfn "$INSTALL_ROOT/android-studio/bin/studio.sh" /usr/local/bin/studio
else
  echo "==> Android Studio already present at $INSTALL_ROOT/android-studio"
fi

if [ ! -x "$SDK_ROOT/cmdline-tools/latest/bin/sdkmanager" ] && \
   [ ! -x "$SDK_ROOT/cmdline-tools/latest/bin/android" ]; then
  echo "==> Installing Android SDK cmdline-tools..."
  ZIP_PATH="$DOWNLOAD_DIR/commandlinetools-linux.zip"
  if [ ! -f "$ZIP_PATH" ]; then
    curl -fL --progress-bar -o "$ZIP_PATH" "$CMDLINE_TOOLS_URL"
  fi
  TMP=$(mktemp -d)
  unzip -q -o "$ZIP_PATH" -d "$TMP"
  rm -rf "$SDK_ROOT/cmdline-tools/latest"
  mkdir -p "$SDK_ROOT/cmdline-tools/latest"
  if [ -d "$TMP/cmdline-tools" ]; then
    mv "$TMP/cmdline-tools/"* "$SDK_ROOT/cmdline-tools/latest/"
  else
    mv "$TMP/"* "$SDK_ROOT/cmdline-tools/latest/"
  fi
  rm -rf "$TMP"
fi

export ANDROID_HOME="$SDK_ROOT"
export ANDROID_SDK_ROOT="$SDK_ROOT"
export PATH="$SDK_ROOT/cmdline-tools/latest/bin:$SDK_ROOT/platform-tools:$SDK_ROOT/emulator:$PATH"

SDKMANAGER=$(command -v sdkmanager || true)
if [ -z "$SDKMANAGER" ]; then
  echo "sdkmanager not found under $SDK_ROOT/cmdline-tools/latest/bin" >&2
  exit 1
fi

echo "==> Accepting SDK licenses..."
yes | "$SDKMANAGER" --licenses >/tmp/android-sdk-licenses.log 2>&1 || true

echo "==> Installing SDK packages for PocketMind (API 35)..."
"$SDKMANAGER" --install \
  "platform-tools" \
  "platforms;android-35" \
  "build-tools;35.0.0" \
  "build-tools;34.0.0" \
  "emulator" \
  "system-images;android-35;google_apis;x86_64"

# Normalize cmdline-tools/latest if sdkmanager wrote latest-2
if [ -d "$SDK_ROOT/cmdline-tools/latest-2" ] && [ ! -x "$SDK_ROOT/cmdline-tools/latest/bin/sdkmanager" ]; then
  rm -rf "$SDK_ROOT/cmdline-tools/latest"
  mv "$SDK_ROOT/cmdline-tools/latest-2" "$SDK_ROOT/cmdline-tools/latest"
fi

if ! avdmanager list avd 2>/dev/null | grep -q "$AVD_NAME"; then
  echo "==> Creating AVD $AVD_NAME..."
  echo "no" | avdmanager create avd \
    -n "$AVD_NAME" \
    -k "system-images;android-35;google_apis;x86_64" \
    -d pixel_6 \
    --force >/dev/null
fi

ENV_FILE="$HOME/.android-env.sh"
cat > "$ENV_FILE" << EOF
#!/usr/bin/env bash
export ANDROID_HOME="\${ANDROID_HOME:-$SDK_ROOT}"
export ANDROID_SDK_ROOT="\${ANDROID_SDK_ROOT:-\$ANDROID_HOME}"
export JAVA_HOME="\${JAVA_HOME:-/usr/lib/jvm/java-21-openjdk-amd64}"
export PATH="\$ANDROID_HOME/cmdline-tools/latest/bin:\$ANDROID_HOME/platform-tools:\$ANDROID_HOME/emulator:/opt/android-studio/bin:\$JAVA_HOME/bin:\$PATH"
EOF
chmod +x "$ENV_FILE"

if ! grep -q 'ANDROID_HOME' "$HOME/.bashrc" 2>/dev/null; then
  cat >> "$HOME/.bashrc" << 'EOF'

# Android SDK / Studio (PocketMind Hybrid AI)
[ -f "$HOME/.android-env.sh" ] && . "$HOME/.android-env.sh"
EOF
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -d "$REPO_ROOT/android" ]; then
  cat > "$REPO_ROOT/android/local.properties" << EOF
## Machine-local SDK path. Do not commit.
sdk.dir=$SDK_ROOT
EOF
  chmod +x "$REPO_ROOT/android/gradlew" 2>/dev/null || true
fi

echo
echo "Android environment ready."
echo "  Studio:  $INSTALL_ROOT/android-studio/bin/studio.sh  (also: android-studio)"
echo "  SDK:     $SDK_ROOT"
echo "  AVD:     $AVD_NAME"
echo "  Env:     source $ENV_FILE"
echo
echo "Build the app:"
echo "  source $ENV_FILE && cd $REPO_ROOT/android && ./gradlew assembleDebug"
