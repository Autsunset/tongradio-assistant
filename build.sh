#!/usr/bin/env bash
# Build TongRadio Assistant for Chrome/Edge and Firefox.
# 产物是两个「解压即用」的 zip（自签 crx / 未签名 xpi 现代浏览器装不了，不再生成）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
DIST="$ROOT/dist"

rm -rf "$DIST"
mkdir -p "$DIST/chrome-src" "$DIST/firefox-src"

# ---------- 公共文件 ----------
for f in background.js popup; do
  cp -r "$ROOT/$f" "$DIST/chrome-src/"
  cp -r "$ROOT/$f" "$DIST/firefox-src/"
done
cp -r "$ROOT/icons" "$DIST/chrome-src/"
cp -r "$ROOT/icons" "$DIST/firefox-src/"

# ---------- 各浏览器 manifest ----------
cp "$ROOT/manifest.chrome.json" "$DIST/chrome-src/manifest.json"
cp "$ROOT/manifest.firefox.json" "$DIST/firefox-src/manifest.json"

# ---------- 解压安装用 zip ----------
# 包一个顶层文件夹：解压一次就得到 chrome-src / firefox-src，浏览器里直接选它。
cd "$DIST"
zip -qr "$DIST/tongradio-assistant-chrome-src.zip" chrome-src
zip -qr "$DIST/tongradio-assistant-firefox-src.zip" firefox-src
cd - >/dev/null

# ---------- Firefox xpi（AMO 上传用，manifest 必须在根目录） ----------
cd "$DIST/firefox-src"
zip -qr "$DIST/tongradio-assistant-firefox.xpi" manifest.json background.js popup icons
cd - >/dev/null

echo "---- 产物 ----"
ls -lh "$DIST"/*.zip "$DIST"/*.xpi
echo
echo "使用方法："
echo "  tongradio-assistant-chrome-src.zip   Chrome/Edge：解压 → 开发者模式 → 加载已解压的扩展程序 → 选 chrome-src"
echo "  tongradio-assistant-firefox-src.zip  Firefox：解压 → about:debugging → 临时载入 firefox-src/manifest.json"
echo "  tongradio-assistant-firefox.xpi      Firefox 正式安装：上传到 AMO 签名（manifest 在根目录）→ 下载已签名版双击安装"
