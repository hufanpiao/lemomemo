#!/usr/bin/env bash
# 构建前的 VAPID 公钥格式核对：release-build.yml（接手清单 VAPID-prod-format，没有开关）和 deploy-preview.yml（B2 O-2）都调这一份。
# 用法：VAPID_PUBLIC_KEY=<值> [VAPID_KEY_REQUIRED=true|false] bash build/ci/vapid-public-key.sh <仓库变量名>
#   仓库变量名：PROD_VAPID_PUBLIC_KEY 或 PREVIEW_VAPID_PUBLIC_KEY（报错里用它，并据此提示 set-vapid-keys.ps1 -Target prod|preview）
#   VAPID_KEY_REQUIRED：只有正好写 false 时为空才只出警告、照常构建（填了但格式不对照样失败）；不写、true 和别的任何值（False、0、拼错）
#   都按必填，为空就失败（11-14 整块评审：原来只有正好 true 才必填，写错开关就悄悄放宽）
# 格式：0x04‖x‖y 的 base64url，87 个字符，以 B 开头、第二个字符在 A～P（首字节 0x04），最后一个字符只能是 AEIMQUYcgkosw048 之一
# （D1-7 的 p256dh、set-vapid-keys.ps1、tests/build/set-vapid-keys.test.ts 同一写法，安全审查 O1-S4）。
# 输出里不回显变量的值。注意 GitHub 会在步骤日志的 Run 表头展开 env: 的值，vars 不遮：公钥本身是公开值，
# 但误填进来的私钥 JWK 也会照样进日志，所以误填后一律按私钥已暴露处理、换钥匙。格式不对时只报长度。
# 正反例在 tests/build/vapid-public-key-check.test.ts（直接跑本脚本）。
set -euo pipefail
# 正则的字符区间按字节比较，不受运行环境的语言设置影响（代码审查复核建议 ③）
export LC_ALL=C

name="${1:?请写仓库变量名，例如 PROD_VAPID_PUBLIC_KEY}"
case "$name" in
  PROD_*) target=prod ;;
  PREVIEW_*) target=preview ;;
  *) echo "::error::仓库变量名要以 PROD_ 或 PREVIEW_ 开头：$name"; exit 2 ;;
esac
key="${VAPID_PUBLIC_KEY:-}"
summary="${GITHUB_STEP_SUMMARY:-/dev/null}"

if [ -z "$key" ]; then
  if [ "${VAPID_KEY_REQUIRED:-true}" != "false" ]; then
    echo "::error::仓库变量 $name 是空的：负责人照 docs/00-团队/负责人-VAPID密钥-步骤.md 运行 set-vapid-keys.ps1 -Target $target，把打印的公钥填进去"
    exit 1
  fi
  echo "::warning::仓库变量 $name 还没填：这次构建不带 VAPID 公钥，推送订阅用不了（开关 VAPID_KEY_REQUIRED 还是 false）"
  echo "VAPID 公钥：没填（开关关着，照常构建）" >> "$summary"
  exit 0
fi
# 先核格式（B2 代码审查复核 M1）：真 P-256 公钥的 base64url 里也可能恰好含 kty（实测约 0.025%），格式合格就放行；
# 不合格时才看像不像私钥 JWK（有 {、"、kty），像就按私钥已暴露处理，否则只报格式不对
if [[ "$key" =~ ^B[A-P][A-Za-z0-9_-]{84}[AEIMQUYcgkosw048]$ ]]; then
  echo "VAPID 公钥：已填（87 个字符，格式对）" >> "$summary"
  exit 0
fi
case "$key" in
  *'{'*|*'"'*|*kty*) echo "::error::$name 看起来是私钥 JWK，不是公钥：立刻到仓库 Variables 删掉它，并重跑 set-vapid-keys.ps1 换一对钥匙（私钥已经暴露）"; exit 1 ;;
esac
# 正好 43 个字符：P-256 私钥 d 的 base64url 长度（安全复核建议），按私钥已经暴露处理
if [ "${#key}" -eq 43 ]; then
  echo "::error::$name 只有 43 个字符：这可能是私钥的 d，按私钥已经暴露处理：立刻到仓库 Variables 删掉它，并重跑 set-vapid-keys.ps1 换一对钥匙"
  exit 1
fi
echo "::error::$name 格式不对（应为 87 个字符的 base64url、以 B 开头；现在 ${#key} 个字符）：照 set-vapid-keys.ps1 打印的那一行重新填，不要带空格和换行"
exit 1
