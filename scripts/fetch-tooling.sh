#!/usr/bin/env bash
# Download pinned ripgrep / Python / Node into src-tauri/resources/tooling
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$ROOT/src-tauri/resources/tooling/MANIFEST.json"
OUT="$ROOT/src-tauri/resources/tooling"

uname_s="$(uname -s)"
uname_m="$(uname -m)"
case "$uname_s-$uname_m" in
  Darwin-arm64) TARGET="${POCKETMIND_TOOLING_TARGET:-aarch64-apple-darwin}" ;;
  Darwin-x86_64) TARGET="${POCKETMIND_TOOLING_TARGET:-x86_64-apple-darwin}" ;;
  Linux-aarch64) TARGET="${POCKETMIND_TOOLING_TARGET:-aarch64-unknown-linux-gnu}" ;;
  Linux-x86_64) TARGET="${POCKETMIND_TOOLING_TARGET:-x86_64-unknown-linux-musl}" ;;
  *) echo "Unsupported platform; set POCKETMIND_TOOLING_TARGET"; exit 1 ;;
esac

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required for fetch-tooling.sh"
  exit 1
fi

parse_sha() {
  grep -Eo '[a-fA-F0-9]{64}' | head -n1 | tr 'A-F' 'a-f'
}

fetch_one() {
  local name="$1"
  local url ver bin arch_bin sha_url dest tmp archive
  url=$(jq -r --arg t "$TARGET" --arg n "$name" '.tools[$n].targets[$t].url // empty' "$MANIFEST")
  [[ -n "$url" ]] || { echo "WARN: no $name for $TARGET"; return 0; }
  ver=$(jq -r --arg n "$name" '.tools[$n].version' "$MANIFEST")
  bin=$(jq -r --arg t "$TARGET" --arg n "$name" '.tools[$n].targets[$t].binary // empty' "$MANIFEST")
  arch_bin=$(jq -r --arg t "$TARGET" --arg n "$name" '.tools[$n].targets[$t].archive_binary // empty' "$MANIFEST")
  sha_url=$(jq -r --arg t "$TARGET" --arg n "$name" '.tools[$n].targets[$t].sha256_url // empty' "$MANIFEST")
  dest="$OUT/$name/$ver/$TARGET"
  mkdir -p "$dest"
  tmp=$(mktemp -d)
  archive="$tmp/archive"
  echo "Downloading $name $ver ($TARGET)..."
  curl -fsSL "$url" -o "$archive"
  if [[ -n "$sha_url" ]]; then
    exp=$(curl -fsSL "$sha_url" | parse_sha)
    act=$(shasum -a 256 "$archive" | awk '{print tolower($1)}')
    [[ -n "$exp" && "$exp" == "$act" ]] || { echo "$name sha mismatch"; exit 1; }
  elif [[ "$name" == "node" ]]; then
    sums_url=$(jq -r '.tools.node.shasums_url // empty' "$MANIFEST")
    if [[ -n "$sums_url" ]]; then
      base=$(basename "$url")
      exp=$(curl -fsSL "$sums_url" | awk -v b="$base" 'index($0,b){print tolower($1); exit}')
      act=$(shasum -a 256 "$archive" | awk '{print tolower($1)}')
      [[ -n "$exp" && "$exp" == "$act" ]] || { echo "$name sha mismatch"; exit 1; }
    fi
  fi
  mkdir -p "$tmp/extract"
  case "$url" in
    *.zip) unzip -q "$archive" -d "$tmp/extract" ;;
    *) tar -xzf "$archive" -C "$tmp/extract" ;;
  esac
  rm -rf "${dest:?}/"*
  if [[ "$name" == "python" ]]; then
    # Keep relocatable layout; expose binary name expected by tooling::python_path
    if [[ -n "$arch_bin" && -f "$tmp/extract/$arch_bin" ]]; then
      cp -a "$tmp/extract/." "$dest/"
      # Symlink/copy canonical name beside tree root when nested
      if [[ ! -f "$dest/$bin" ]]; then
        cp "$tmp/extract/$arch_bin" "$dest/$bin"
        chmod +x "$dest/$bin"
      fi
    else
      cp -a "$tmp/extract/." "$dest/"
      found=$(find "$tmp/extract" -type f \( -name python3.12 -o -name python3 -o -name python \) | head -n1)
      [[ -n "$found" ]] || { echo "python binary missing"; exit 1; }
      cp "$found" "$dest/$bin"
      chmod +x "$dest/$bin"
    fi
  else
    if [[ -n "$arch_bin" && -f "$tmp/extract/$arch_bin" ]]; then
      cp "$tmp/extract/$arch_bin" "$dest/$bin"
    else
      found=$(find "$tmp/extract" -type f -name "$bin" | head -n1)
      [[ -n "$found" ]] || { echo "$bin missing"; exit 1; }
      cp "$found" "$dest/$bin"
    fi
    chmod +x "$dest/$bin"
  fi
  rm -rf "$tmp"
  echo "OK $name -> $dest"
}

echo "Fetching tooling for $TARGET"
fetch_one ripgrep
fetch_one python
fetch_one node
echo "Tooling fetch complete for $TARGET"
