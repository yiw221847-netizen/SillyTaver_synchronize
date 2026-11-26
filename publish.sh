#!/usr/bin/env bash
# 用一次性 Token 建仓库并推送 tavernsync
# 用法：GH_TOKEN=github_pat_xxx bash publish.sh [仓库名] [private|public]
set -euo pipefail

NAME="${1:-tavernsync}"
VIS="${2:-private}"
TOKEN="${GH_TOKEN:-}"
[ -n "$TOKEN" ] || { echo "缺少 GH_TOKEN"; exit 1; }
command -v curl >/dev/null 2>&1 || HAS_CURL=0
API="https://api.github.com"

api() {  # api METHOD PATH BODY
  local m="$1" p="$2" b="${3:-}"
  /opt/node/bin/node -e '
    const [m,p,b,tok] = process.argv.slice(1);
    fetch("https://api.github.com" + p, {
      method: m,
      headers: { Authorization: "Bearer " + tok, Accept: "application/vnd.github+json", "User-Agent": "tavernsync" },
      body: b || undefined,
    }).then(async r => { const t = await r.text(); console.log(r.status + " " + t.slice(0, 300)); });
  ' "$m" "$p" "$b" "$TOKEN"
}

LOGIN=$(/opt/node/bin/node -e '
  fetch("https://api.github.com/user", { headers: { Authorization: "Bearer " + process.argv[1], "User-Agent": "tavernsync" } })
    .then(r => r.json()).then(j => console.log(j.login || ""));
' "$TOKEN")

[ -n "$LOGIN" ] || { echo "Token 无效（拿不到用户名）"; exit 1; }
echo "账号：$LOGIN"

echo "创建仓库 $LOGIN/$NAME（$VIS）…"
api POST /user/repos "{\"name\":\"$NAME\",\"private\":$([ "$VIS" = private ] && echo true || echo false),\"description\":\"TavernSync: SillyTavern data sync to GitHub\"}" | head -c 200; echo

# 用 askpass 传 Token，不写进 remote、不出现在命令行里
ASKPASS=$(mktemp)
chmod 700 "$ASKPASS"
printf '#!/bin/sh\ncase "$1" in\n  *Username*) echo x-access-token ;;\n  *Password*) echo "%s" ;;\nesac\n' "$TOKEN" > "$ASKPASS"

cd "$(dirname "$0")"
git remote remove origin 2>/dev/null || true
git remote add origin "https://github.com/$LOGIN/$NAME.git"
GIT_ASKPASS="$ASKPASS" GIT_TERMINAL_PROMPT=0 git push -u origin HEAD:main || {
  echo "推送失败"; rm -f "$ASKPASS"; exit 1; }
rm -f "$ASKPASS"

echo ""
echo "✓ 已推送：https://github.com/$LOGIN/$NAME"
echo "安装：git clone https://github.com/$LOGIN/$NAME.git ~/SillyTavern/plugins/tavernsync"
