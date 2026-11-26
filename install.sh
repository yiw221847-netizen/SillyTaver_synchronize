#!/usr/bin/env bash
# TavernSync 安装脚本：把插件放进酒馆的 plugins/ 并打开 enableServerPlugins
# 用法：bash install.sh [酒馆目录]
set -e

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/tavernsync"
[ -d "$SRC" ] || SRC="$HERE"   # 允许在 tavernsync 目录里直接跑

ST="${1:-}"
if [ -z "$ST" ]; then
  for c in "$HOME/SillyTavern" "$HOME/sillytavern" "$HOME/ST" "$HOME/SillyTavern-release" "/sdcard/SillyTavern"; do
    if [ -f "$c/config.yaml" ]; then ST="$c"; break; fi
  done
fi

if [ -z "$ST" ] || [ ! -f "$ST/config.yaml" ]; then
  echo "找不到酒馆目录（没看到 config.yaml）。"
  echo "请把路径作为参数传进来，例如："
  echo "  bash install.sh ~/SillyTavern"
  exit 1
fi

echo "酒馆目录：$ST"
cp -a "$ST/config.yaml" "$ST/config.yaml.bak"
mkdir -p "$ST/plugins"

DEST="$ST/plugins/tavernsync"
if [ -d "$DEST" ] && [ "$(cd "$SRC" && pwd -P)" = "$(cd "$DEST" && pwd -P)" ]; then
  # 已经 git clone 到目标位置了，直接原地使用，别自己删自己
  echo "插件已在 $DEST，跳过复制。"
else
  rm -rf "$DEST"
  cp -a "$SRC" "$DEST"
  rm -rf "$DEST/test"          # 测试文件不需要装进去
  rm -f  "$DEST/install.sh"    # 安装脚本本身也不用留
fi

node - "$ST/config.yaml" <<'JS'
const fs = require('fs');
const file = process.argv[2];
let lines = fs.readFileSync(file, 'utf8').split('\n');
const idx = lines.findIndex((l) => /^#?\s*enableServerPlugins\s*:/.test(l));
let done = false;
if (idx >= 0) {
  const commented = lines[idx].trim().startsWith('#');
  lines[idx] = 'enableServerPlugins: true';
  done = true;
  if (commented) console.log('已打开 enableServerPlugins（原来是注释掉的）');
  else console.log('enableServerPlugins 已设为 true');
}
if (!done) {
  lines.push('enableServerPlugins: true');
  console.log('已在 config.yaml 末尾添加 enableServerPlugins: true');
}
fs.writeFileSync(file, lines.join('\n'));
JS

# 装前端入口：让「扩展程序」里出现一个按钮，点一下就能跳到同步面板
EXT_SRC="$SRC/st-extension"
EXT_DEST="$ST/public/scripts/extensions/third-party/tavernsync"
if [ -d "$EXT_SRC" ]; then
  if [ -d "$EXT_DEST" ] && [ "$(cd "$EXT_SRC" && pwd -P)" = "$(cd "$EXT_DEST" && pwd -P)" ]; then
    echo "前端入口已在 $EXT_DEST，跳过。"
  else
    mkdir -p "$EXT_DEST"
    cp -a "$EXT_SRC/." "$EXT_DEST/"
    echo "已安装前端入口：扩展程序里会出现「酒馆多端同步」"
  fi
fi

echo ""
echo "装好了。现在重启酒馆（Termux 里 Ctrl+C 再重新启动），然后二选一："
echo "  1) 酒馆设置 → 扩展程序 → 酒馆多端同步 → 打开同步面板"
echo "  2) 浏览器直接打开 http://127.0.0.1:8000/api/plugins/tavernsync/ui"
echo ""
echo "原来的配置备份在 $ST/config.yaml.bak"
