#!/usr/bin/env bash
# Build TongRadio Assistant for Chrome/Edge (.crx) and Firefox (.xpi)
# 产物同时包含「解压安装」zip，方便放进 GitHub Releases 分发。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
DIST="$ROOT/dist"
CHROME_BIN="${CHROME_BIN:-google-chrome}"

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

# ---------- Firefox xpi (zip) ----------
cd "$DIST/firefox-src"
zip -qr "$DIST/tongradio-assistant-firefox.xpi" \
  manifest.json background.js popup icons
cd - >/dev/null

# ---------- Chrome/Edge crx ----------
# 私钥：无则生成（PKCS#8），有则复用，保证扩展 ID 稳定
KEY="$ROOT/.crx-key.pem"
if [ ! -f "$KEY" ]; then
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$KEY" 2>/dev/null
  echo "generated new signing key: $KEY (请妥善保存，更换会导致扩展 ID 变化)"
fi

echo "packing crx with $CHROME_BIN ..."
if "$CHROME_BIN" --no-sandbox --no-first-run \
    --pack-extension="$DIST/chrome-src" \
    --pack-extension-key="$KEY" >/dev/null 2>&1 && [ -f "$DIST/chrome-src.crx" ]; then
  mv "$DIST/chrome-src.crx" "$DIST/tongradio-assistant-chrome.crx"
else
  echo "WARN: chrome 打包失败，跳过 crx（可改用 chrome-src 解压安装）"
fi

# ---------- 解压安装用 zip（GitHub Releases 分发） ----------
# 包一个顶层文件夹，解压一次就直接得到 chrome-src / firefox-src 文件夹，
# 在浏览器里「加载已解压的扩展程序」直接选它即可，不用在零散文件里找。
cd "$DIST"
zip -qr "$DIST/tongradio-assistant-chrome-src.zip" chrome-src
zip -qr "$DIST/tongradio-assistant-firefox-src.zip" firefox-src
cd - >/dev/null

echo "---- 产物 ----"
ls -lh "$DIST"
echo
echo "GitHub Releases 建议上传："
echo "  tongradio-assistant-chrome.crx        Chrome/Edge 自签 crx（开发者模式拖入）"
echo "  tongradio-assistant-chrome-src.zip    Chrome/Edge 解压安装（加载已解压的扩展程序）"
echo "  tongradio-assistant-firefox.xpi       Firefox 扩展包（AMO 签名 / 临时加载）"
echo "  tongradio-assistant-firefox-src.zip   Firefox 解压临时加载"
echo "商店上传请用："
echo "  tongradio-assistant-chrome-src.zip -> Edge / Chrome Web Store"
echo "  tongradio-assistant-firefox.xpi    -> AMO"
