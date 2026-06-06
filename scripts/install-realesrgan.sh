#!/usr/bin/env bash
# Install Real-ESRGAN ncnn-vulkan (macOS arm64) into ./bin
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p bin && cd bin
VER="v0.2.0"
ZIP="realesrgan-ncnn-vulkan-20220424-macos.zip"
URL="https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan/releases/download/${VER}/${ZIP}"
echo "Downloading $URL"
curl -L -o realesrgan.zip "$URL"
unzip -o realesrgan.zip
chmod +x realesrgan-ncnn-vulkan || true
# macOS Gatekeeper: clear quarantine so it runs headless
xattr -dr com.apple.quarantine . || true
echo "Installed. Test: ./realesrgan-ncnn-vulkan -h"
echo "Set REALESRGAN_BIN=$(pwd)/realesrgan-ncnn-vulkan in .env"
