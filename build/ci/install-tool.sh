#!/usr/bin/env bash
# 在 CI 里按 tools/ci-tools.lock 安装一个命令行工具：下载 → 核对 SHA-256 → 解压 → 加进 PATH。
# 哈希对不上就失败，不重试、不换地址（架构 8.3 依赖供应链第 ⑤ 条）。
#
# 用法：bash build/ci/install-tool.sh <名称> [平台]
#   名称：gitleaks、osv-scanner、supabase、actionlint（见 tools/ci-tools.lock）
#   平台：默认 linux_amd64
# 只在 GitHub Actions 的 Linux runner 上用；本机发布用 tools/release/publish.ps1 里自己的一份。
set -euo pipefail

name="${1:?请写工具名，例如 gitleaks}"
platform="${2:-linux_amd64}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
lock="$root/tools/ci-tools.lock"

# 取锁文件里第一行“名称 平台”都对上的记录（注释和空行跳过）
line="$(awk -v n="$name" -v p="$platform" '$0 !~ /^[[:space:]]*#/ && NF == 6 && $1 == n && $3 == p { print; exit }' "$lock")"
if [ -z "$line" ]; then
  echo "::error::tools/ci-tools.lock 里没有 $name / $platform 这一行"
  exit 1
fi
read -r _ version _ file sha url <<<"$line"

# 地址只认 GitHub 官方发布页，防止锁文件被改成别处
case "$url" in
  https://github.com/*/releases/download/*) ;;
  *) echo "::error::$name 的下载地址不是 GitHub 发布页：$url"; exit 1 ;;
esac

work="${RUNNER_TEMP:-/tmp}/lemo-tools/$name-$version"
bin="${RUNNER_TEMP:-/tmp}/lemo-tools/bin"
mkdir -p "$work" "$bin"

curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  --retry 3 --output "$work/$file" "$url"

echo "$sha  $work/$file" | sha256sum --check --strict -
echo "$name $version：SHA-256 核对通过"

case "$file" in
  *.tar.gz) tar -xzf "$work/$file" -C "$work" ;;
  *.zip) unzip -q -o "$work/$file" -d "$work" ;;
  *) cp "$work/$file" "$work/$name" ;;
esac

# 解压出来的可执行文件名：supabase、gitleaks、actionlint；osv-scanner 是单文件，上面已改名
src="$work/$name"
if [ ! -f "$src" ]; then
  echo "::error::解压后没找到 $name 可执行文件"
  ls -la "$work"
  exit 1
fi
install -m 0755 "$src" "$bin/$name"

if [ -n "${GITHUB_PATH:-}" ]; then
  echo "$bin" >> "$GITHUB_PATH"
fi
"$bin/$name" --version 2>/dev/null || "$bin/$name" version 2>/dev/null || true
