"""生成推送端点和密钥的共用测试向量 tests/fixtures/push-endpoints.json（B2 第 15 行，测试开发维护）。

用法（在仓库根目录跑）：python -I build/gen_push_endpoints.py
依赖：Python 3 和 cryptography（pip install cryptography），用它在 P-256 曲线上取真公钥。
输出：tests/fixtures/push-endpoints.json（按脚本位置定位，覆盖写；LF 换行、UTF-8），
      结尾打印五个数：端点合格数、端点不合格数、keys 合格数、keys 不合格数、keysSendOnly 条数。

结果是固定的：随机串用 random.seed(20261103)，公钥用 derive_private_key 从固定私钥往后找，
同一份脚本每次生成的文件逐字节相同。改了样例要重新生成，再跑
  npx vitest run tests/build/push-endpoints-fixture.test.ts tests/build/push-endpoints-fixture-items.test.ts
规则出处：B2-安全审查-S-B2签字 D1-1～D1-3、D1-7、D1-8、1.5 节、第六节；架构审 D1 第 4 点。
"""
import json, base64, os, random
random.seed(20261103)
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tests", "fixtures", "push-endpoints.json")
def tok(n, alphabet="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"):
    return "".join(random.choice(alphabet) for _ in range(n))
def b64u(b, pad=False):
    s = base64.urlsafe_b64encode(b).decode()
    return s if pad else s.rstrip("=")

E = []
def ok(ep, why, ref=None):
    E.append({"endpoint": ep, "ok": True, "why": why, **({"ref": ref} if ref else {})})
def bad(ep, why, ref, **extra):
    E.append({"endpoint": ep, "ok": False, "why": why, "ref": ref, **extra})

FCM = "https://fcm.googleapis.com/fcm/send/"
# ---------- 合格 ----------
ok("https://web.push.apple.com/" + tok(60), "Safari / iPhone 主屏幕版现在用的端点主机", "6 合格组")
ok("https://api.push.apple.com/" + tok(40), "另一个一级子域，苹果以后换子域也不用改", "6 合格组")
ok("https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB" + tok(40) + "%2b" + tok(20) + "%3d", "Edge 安装版（WNS）：带查询串，查询串里有 %2b、%3d", "6 合格组")
tok(60)  # 原先这里用随机串，gitleaks 当成 generic-api-key 误报；照旧取一次随机数，保证后面各条不变
ok("https://db5p.notify.windows.com/w/?token=BQYAAAA" + "wns-" * 15, "WNS 另一个一级子域（token 用重复短串，低熵免得被密钥扫描误报，字符仍在合法范围内）")
ok(FCM + tok(22) + ":APA91b" + tok(120), "Chrome（FCM 旧格式）：令牌里带冒号，冒号只出现在路径里是合格的", "6 合格组")
ok("https://fcm.googleapis.com/wp/" + tok(150), "Chrome（FCM 新格式 /wp/）", "6 合格组")
ok("https://updates.push.services.mozilla.com/wpush/v2/gAAAAAB" + tok(140), "Firefox（autopush v2）", "6 合格组")
ok("https://updates.push.services.mozilla.com/wpush/v1/gAAAAAB" + tok(100), "Firefox（autopush v1）")
L = 2048
ok(FCM + "a" * (L - len(FCM)), "长度边界：正好 2048 字符，合格", "6 第 35 条")
ok("https://" + "a" * 63 + ".push.apple.com/x", "子域标签正好 63 字符，合格", "6 合格组")
ok("https://a.push.apple.com/x", "子域标签 1 个字符，合格")
ok("https://123.notify.windows.com/w/?token=x", "子域标签全是数字，合格（不是 IP：后面还有 notify.windows.com）")
ok("https://wns2-bl2p.notify.windows.com/w/?token=x", "子域标签中间带连字符，合格")
ok(FCM + "abc%3Adef", "路径里带 %（%3A），% 只许出现在路径里", "6 合格组")
ok("https://updates.push.services.mozilla.com/wpush/v2/abc?x=1&y=2", "路径后带查询串 ?、&、=，合格")
ok("https://web.push.apple.com/" + "-_" + tok(30), "令牌里有 - 和 _（base64url 字符）")
ok("https://fcm.googleapis.com/", "路径只有一个 /：规则要求路径以 / 开头、不为空，这也算合格（真实端点不会这样，钉住边界）")

ok("https://fcm.googleapis.com/a..b", "两个点但不单独成段，合格", "6 补充合格组")
ok("https://fcm.googleapis.com/a.b/", "点在段中间、路径以 / 结尾，合格", "6 补充合格组")
ok("https://fcm.googleapis.com/.well", "段以点开头但不只是点，合格", "6 补充合格组")
ok("https://wns2-par02p.notify.windows.com/w/?token=a%2Bb%3D", "查询串里大写的百分号编码，WHATWG 原样保留", "6 补充合格组")
ok("https://wns2-par02p.notify.windows.com/w/?token=a%2bb%3d", "查询串里小写的百分号编码，WHATWG 原样保留", "6 补充合格组")
ok("https://fcm.googleapis.com/fcm/send/x?", "空查询串（只有一个 ?），WHATWG 原样保留", "6 补充合格组")
ok("https://fcm.googleapis.com/fcm/send/abc:APA91b-x_y", "FCM 令牌带 :、-、_", "6 补充合格组")
ok("https://updates.push.services.mozilla.com/wpush/v2/a~b+c=d&e", "路径里带 ~、+、=、&", "6 补充合格组")
ok("https://api.push.apple.com/3/device/" + tok(64, "0123456789abcdef"), "苹果 /3/device/ 形式的路径", "1.5 第 ① 点")

# ---------- 不合格（安全审查第六节 1～37 条） ----------
P = "6 第 {} 条"
bad("http://fcm.googleapis.com/fcm/send/x", "不是 https", P.format(1))
bad("HTTPS://fcm.googleapis.com/fcm/send/x", "协议大写：只收规范写法，不转小写", P.format(2))
for s in ["https:fcm.googleapis.com/fcm/send/x", "https:/fcm.googleapis.com/fcm/send/x", "https:///fcm.googleapis.com/fcm/send/x"]:
    bad(s, "斜杠个数不对：WHATWG 会修成正常地址，原串必须是 https:// 开头", P.format(3))
for s in ["wss://fcm.googleapis.com/x", "javascript:alert(1)", "data:,x", "file:///etc/passwd"]:
    bad(s, "别的协议", P.format(4))
bad("//fcm.googleapis.com/x", "没有协议（协议相对地址）", P.format(5))
bad("", "空串", P.format(5))
bad("   ", "只有空格", P.format(5))
bad(" https://fcm.googleapis.com/x", "开头空格：WHATWG 会去掉，原串不许有空白", P.format(6))
bad("https://fcm.googleapis.com/x ", "末尾空格", P.format(6))
bad("https://fcm.googleapis.com/x\n", "末尾换行", P.format(6))
bad("https://fcm.googleapis.com", "主机后面没有路径（WHATWG 会补成 /，原串不合格）", P.format(7))
bad("https://fcm.googleapis.com?x=1", "问号直接跟在主机后面，路径为空", P.format(7))
bad("https://evil.com#.web.push.apple.com/x", "片段混淆：真实主机是 evil.com", P.format(8))
bad("https://evil.com?.web.push.apple.com/x", "查询串混淆：真实主机是 evil.com", P.format(9))
bad("https://evil.com\\.web.push.apple.com/x", "反斜杠混淆：WHATWG 把反斜杠当 /，真实主机是 evil.com", P.format(10))
bad("https://fcm.googleapis.com\\@evil.com/x", "反斜杠加 @ 混淆", P.format(10))
bad("https://fcm.googleapis.com@evil.com/x", "@ 混淆：@ 前面是用户名，真实主机是 evil.com", P.format(11))
bad("https://user:pass@fcm.googleapis.com/x", "带用户名密码", P.format(11))
bad("https://@fcm.googleapis.com/x", "空用户名：url.username 为空，只看解析结果会放行", P.format(11))
bad("https://:@fcm.googleapis.com/x", "空用户名和空密码", P.format(11))
bad("https://fcm.googleapis.com.evil.com/x", "前缀拼接：白名单主机后面接别的域", P.format(12))
bad("https://web.push.apple.com.evil.com/x", "前缀拼接（苹果）", P.format(12))
bad("https://evilpush.apple.com/x", "后缀拼接：主机以 push.apple.com 结尾但不是 .push.apple.com", P.format(13))
bad("https://evil-fcm.googleapis.com/x", "后缀拼接（FCM 要完全相等）", P.format(13))
bad("https://xfcm.googleapis.com/x", "后缀拼接（多一个字符）", P.format(13))
bad("https://push.apple.com/x", "只有根域，没有一级子域", P.format(14))
bad("https://notify.windows.com/x", "只有根域（WNS）", P.format(14))
bad("https://a.web.push.apple.com/x", "多级子域（苹果）", P.format(15))
bad("https://a.b.notify.windows.com/x", "多级子域（WNS）", P.format(15))
bad("https://.push.apple.com/x", "空标签（开头点）", P.format(16))
bad("https://web..push.apple.com/x", "空标签（连续两个点）", P.format(16))
bad("https://-web.push.apple.com/x", "标签以连字符开头", P.format(17))
bad("https://web-.push.apple.com/x", "标签以连字符结尾", P.format(17))
bad("https://" + "a" * 64 + ".push.apple.com/x", "子域标签 64 个字符，超过 63", P.format(18))
bad("https://xn--zz.push.apple.com/x", "xn-- 标签（不合法的 punycode）", P.format(19))
bad("https://xn--web-abc.notify.windows.com/x", "xn-- 标签（WNS）", P.format(19))
bad("https://android.googleapis.com/gcm/send/x", "旧的 GCM 主机，不收", P.format(20))
bad("https://googleapis.com/x", "FCM 的上级域", P.format(20))
bad("https://updates.push.services.mozilla.com.evil.com/x", "前缀拼接（Mozilla）", P.format(20))
bad("https://WEB.push.apple.com/x", "主机有大写：只收规范写法，不转小写（否则同一端点能存成多行，去重失效）", P.format(21))
bad("https://Fcm.googleapis.com/x", "主机首字母大写", P.format(21))
bad("https://web.push.apple.com./x", "末尾点：不去点，直接拒（去重失效）", P.format(22))
bad("https://fcm.googleapis.com../x", "两个末尾点", P.format(22))
bad("https://web%2epush%2eapple%2ecom/x", "主机里 %2e：WHATWG 会解码成点，原串主机不许 %", P.format(23))
bad("https://fcm%2Egoogleapis.com/x", "主机里 %2E（大写）", P.format(23))
bad("https://evil.com%2f.web.push.apple.com/x", "主机里 %2f（编码的斜杠）", P.format(23))
bad("https://evil.com%23.web.push.apple.com/x", "主机里 %23（编码的 #）", P.format(23))
bad("https://fcm\uff0egoogleapis\uff0ecom/x", "全角点 U+FF0E：IDNA 会映射成点", P.format(24))
bad("https://fcm.googleapis\u3002com/x", "句号 U+3002", P.format(24))
bad("https://web.push.apple\uff61com/x", "半角句号 U+FF61", P.format(24))
bad("https://fcm.googleapi\u017f.com/x", "长 s U+017F：不分大小写比较时可能当成 s", P.format(25))
bad("https://w\u0435b.push.apple.com/x", "西里尔字母 е（U+0435）冒充 e", P.format(25))
bad("https://\uff46\uff43\uff4d.googleapis.com/x", "全角字母 ｆｃｍ", P.format(25))
bad("https://web.push.apple.com\t.evil.com/x", "主机里有制表符：WHATWG 会删掉，拼出 web.push.apple.com.evil.com", P.format(26))
bad("https://fcm.googleapis.com\n/x", "主机后有换行", P.format(26))
bad("https://fcm.goo\tgleapis.com/x", "主机中间有制表符：WHATWG 删掉后变成 fcm.googleapis.com", P.format(26))
bad("https://fcm.googleapis.com\u0000/x", "主机里带 NUL", P.format(26), pg=False,
    pgWhy="PostgreSQL 的 text 不能含 \\u0000，这一条只在 Deno 一侧跑；SQL 一侧入参本身进不了 text")
bad("https://fcm.googleapis.com:443/x", "写了默认端口也拒", P.format(27))
bad("https://fcm.googleapis.com:/x", "端口为空", P.format(28))
bad("https://fcm.googleapis.com:8443/x", "非默认端口", P.format(29))
bad("https://fcm.googleapis.com:0443/x", "前导 0 的端口", P.format(29))
bad("https://web.push.apple.com:65536/x", "超出范围的端口", P.format(29))
for s, w in [("https://127.0.0.1/x", "IPv4 回环"), ("https://169.254.169.254/latest/meta-data", "云元数据地址"), ("https://10.0.0.1/x", "内网 IPv4")]:
    bad(s, w, P.format(30))
for s, w in [("https://2130706433/x", "十进制整数 IPv4"), ("https://0x7f000001/x", "十六进制 IPv4"), ("https://0177.0.0.1/x", "八进制 IPv4"), ("https://127.1/x", "简写 IPv4")]:
    bad(s, w + "：WHATWG 会规范化成 127.0.0.1", P.format(31))
for s, w in [("https://[::1]/x", "IPv6 回环"), ("https://[::ffff:127.0.0.1]/x", "IPv4 映射的 IPv6"), ("https://[::ffff:7f00:1]/x", "IPv4 映射的 IPv6（十六进制）"), ("https://[fe80::1%25eth0]/x", "带区域号的链路本地 IPv6")]:
    bad(s, w, P.format(32))
for s, w in [("https://localhost/x", "localhost"), ("https://kong:8000/x", "本地 Supabase 网关主机名"), ("https://host.docker.internal/x", "docker 宿主机名")]:
    bad(s, w, P.format(33))
bad(FCM + "a" * (L + 1 - len(FCM)), "长度边界：2049 字符，拒", P.format(34))
bad(FCM + "a" * (100000 - len(FCM)), "10 万字符：拒，而且两边都不能超时（先查长度、正则不能回溯爆炸）", P.format(36))
bad("https://fcm.googleapis.com/x#frag", "带片段", P.format(37))
bad("https://fcm.googleapis.com/a\\b", "路径里有反斜杠", P.format(37))
bad("https://fcm.googleapis.com/a b", "路径里有空格", P.format(37))

FQ = "https://fcm.googleapis.com/fcm/send/"
WQ = "https://wns2-par02p.notify.windows.com/w/?token="
for ch in '"<>^`{}|':
    bad(FQ + "a" + ch + "b", f"路径里有 {ch}：WHATWG 会改写，或不在字符集里", P.format(40))
bad(FQ + "a{b}", "路径里有一对 {}", P.format(40))
bad(FQ + "a@b", "路径里有 @：不在字符集里（容易和用户名混淆），出自 1.5 第 ① 点“不收的字符”", "1.5 第 ① 点")
for ch in "'!$()*,;@[]":
    bad(WQ + "a" + ch + "b", f"查询串里有 {ch}", P.format(41))
for path, w in [("/a/../b", "点段 .."), ("/a/./b", "点段 ."), ("/..", "路径只有 /.."), ("/.", "路径只有 /."), ("/a/..", "结尾是点段 .."),
                ("/a/%2e%2e/b", "编码的点段 %2e%2e"), ("/a/.%2e/b", "半编码的点段 .%2e"), ("/a/%2E/b", "大写编码的点 %2E")]:
    bad("https://fcm.googleapis.com" + path, w + "：WHATWG 会消掉点段，路径就变了", P.format(42))
bad(WQ + "%2e", "查询串里有 %2e：原串里一律不许出现编码的点", P.format(42))
for path, w in [("/a%", "% 后面没有数字"), ("/a%2", "% 后面只有一位"), ("/a%zz", "% 后面不是十六进制")]:
    bad("https://fcm.googleapis.com" + path, "坏的百分号编码：" + w, P.format(43))
bad(WQ + "a?b", "两个 ?：查询串里不能再出现 ?", P.format(44))

for i, e in enumerate(E, 1):
    e["id"] = ("ok-" if e["ok"] else "bad-") + f"{i:03d}"

# ---------- 密钥（bad_push_keys，D1-7） ----------
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import serialization
B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
def curve_pub(pred, start):
    """从固定种子往后找第一把满足条件的 P-256 公钥（真在曲线上），回 65 字节"""
    n = start
    while True:
        k = ec.derive_private_key(n, ec.SECP256R1())
        raw = k.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
        if pred(b64u(raw)):
            return raw
        n += 1
K = []
KS = []
def key(field, v, okv, why, ref=None):
    K.append({"field": field, "value": v, "ok": okv, "why": why, **({"ref": ref} if ref else {})})
pub = curve_pub(lambda s: True, 1000)
auth = bytes(random.randrange(256) for _ in range(16))
p87 = b64u(pub); p88 = b64u(pub, True); a22 = b64u(auth); a24 = b64u(auth, True)
assert len(p87) == 87 and p87[0] == "B" and len(p88) == 88 and len(a22) == 22 and len(a24) == 24
R38 = "6 第 38 条"; R39 = "6 第 39 条"; R17 = "1.5 第 ③ 点 D1-7"
key("p256dh", p87, True, "P-256 曲线上的点，65 字节、首字节 0x04，base64url 不补齐（87 字符，浏览器给的就是这种）")
key("p256dh", p88, True, "同上，补齐成 88 字符（末尾一个 =）")
pBA = curve_pub(lambda s: s[1] == "A", 2000); pBP = curve_pub(lambda s: s[1] == "P", 3000)
p0 = curve_pub(lambda s: s[-1] == "0", 4000); pw = curve_pub(lambda s: s[-1] == "w", 5000)
key("p256dh", b64u(pBA), True, "以 BA 开头（第 2 个字符取下限 A），不补齐", R17)
key("p256dh", b64u(pBP, True), True, "以 BP 开头（第 2 个字符取上限 P），补齐", R17)
key("p256dh", b64u(p0), True, "末字符 0（值 52，是 4 的倍数），不补齐", R17)
key("p256dh", b64u(pw, True), True, "末字符 w（值 48，是 4 的倍数），补齐", R17)
key("p256dh", p87[:85], False, "85 字符", R38)
key("p256dh", p88 + "A", False, "89 字符", R38)
key("p256dh", "A" + p87[1:], False, "首字节不是 0x04（第一个字符不是 B）", R38)
key("p256dh", p87[:40] + "=" + p87[41:], False, "= 出现在中间", R38)
key("p256dh", "B+" + p87[2:], False, "含 +（标准 base64）", R38)
key("p256dh", "B/" + p87[2:], False, "含 /（标准 base64）", R38)
key("p256dh", p87[:86] + "\u00e9", False, "含非 ASCII（é）", R38)
key("p256dh", "", False, "空串", R38)
for c in B64[16:]:
    key("p256dh", "B" + c + p87[2:], False, f"第 2 个字符是 {c}：首字节成了 0x05～0x07，不是 0x04", R17)
for c in "BCD_":
    key("p256dh", p87[:86] + c, False, f"末字符 {c} 不是 4 的倍数：多出来的 2 位不为 0（非规范编码）", R17)
key("p256dh", p87[:86] + "==", False, "88 个字符却以两个 = 结尾（只有 86 个数据字符）", R17)
key("auth", a22, True, "16 字节，base64url 不补齐（22 字符）")
key("auth", a24, True, "同上，补齐成 24 字符（末尾 ==）")
a2 = b64u(bytes(random.randrange(256) for _ in range(16)))
for c in "AQgw":
    key("auth", a2[:21] + c, True, f"末字符 {c}（多出来的 4 位为 0），合格", R17)
key("auth", a22[:21], False, "21 字符", R39)
key("auth", a24 + "A", False, "25 字符", R39)
key("auth", a22[:10] + "=" + a22[11:], False, "= 出现在中间", R39)
key("auth", "+" + a22[1:], False, "含 +", R39)
key("auth", "/" + a22[1:], False, "含 /", R39)
key("auth", "", False, "空串", R39)
for c in "BR_":
    key("auth", a22[:21] + c, False, f"末字符 {c}：多出来的 4 位不为 0（非规范编码）", R17)
key("auth", a22 + "=", False, "只补一个 =（16 字节要补两个）", R17)
# 正则管不到的：不在曲线上的点。SQL 收、发送时 importKey 失败 → bad_keys（D1-7 最后一段），不进两边一致的那组
def off_curve(raw, bump):
    b = bytearray(raw); b[-1] ^= bump
    return bytes(b)
for i, (bump, why) in enumerate([(4, "y 坐标最后一个字节改了，点不在曲线上"), (8, "同上，换一个字节值")], 1):
    v = b64u(off_curve(pub, bump))
    KS.append({"id": f"key-send-{i:03d}", "field": "p256dh", "value": v, "sqlOk": True, "sendOk": False,
               "why": why + "；正则合格，SQL 会收下，发送时 importKey 失败按 bad_keys 处理", "ref": "1.5 第 ③ 点 D1-7"})
zero = bytes([4]) + bytes(64)
KS.append({"id": "key-send-003", "field": "p256dh", "value": b64u(zero), "sqlOk": True, "sendOk": False,
           "why": "x、y 全 0，不在曲线上；正则合格，发送时 bad_keys", "ref": "1.5 第 ③ 点 D1-7"})
for i, k in enumerate(K, 1):
    k["id"] = f"key-{i:03d}"

doc = {
    "$comment": [
        "推送端点和密钥的共用测试向量（B2 TC-B2-80；架构审 D1 第 4 点；B2-安全审查-S-B2签字 D1-1～D1-3、D1-7、D1-8、1.5 节、第六节）。",
        "pgTAP（private.push_endpoint_ok 和密钥校验）和 Deno（_shared 下的 TS 校验模块）读同一个文件，逐条断言 ok，两边结果必须一致，CI 拦。",
        "规则（安全审查 D1-1，2026-11-03 定，取代架构审 D1 的“转小写、去末尾点后比对”）：只收规范写法的原串，不做任何规范化；",
        "① 只含 0x21～0x7E；② 长度 ≤ 2048；③ 整串匹配 ^https://(主机)(/(?:[A-Za-z0-9._~:/=&+-]|%[0-9A-Fa-f]{2})*)(\\?(?:[A-Za-z0-9._~:/=&+-]|%[0-9A-Fa-f]{2})*)?$（安全审查 1.5 第 ① 点），主机只许 [a-z0-9.-]；",
        "③ 之外再查两条：原串里不许有 %2e、%2E；路径（? 之前）不许有单独成段的 . 或 ..（用 (^|/)\\.{1,2}(/|$) 匹配，命中就拒）；",
        "④ 主机完全等于 fcm.googleapis.com 或 updates.push.services.mozilla.com，或是 push.apple.com、notify.windows.com 的一级子域：标签 1～63 字符、首尾不是连字符、不以 xn-- 开头。",
        "比较区分大小写，不用 /i、/u、~*、ilike、lower()。",
        "字段：id；endpoint（或 keys 里的 value）是原串；ok 是期望结果；why 说明测的是什么；ref 对应安全审查第六节的条号（“6 补充合格组”是第六节 11-03 补充的合格写法，“1.5 第 ① 点”出自 1.5 节）；",
        "pg 为 false 的只在 Deno 一侧跑（PostgreSQL 的 text 放不下 \\u0000），pgWhy 写原因。",
        "keys 是 bad_push_keys 的向量，两边结论必须一致：field 为 p256dh 或 auth（安全审查 D1-7：p256dh ^B[A-P][A-Za-z0-9_-]{84}[AEIMQUYcgkosw048]=?$，auth ^[A-Za-z0-9_-]{21}[AQgw](==)?$；Deno 一侧先用同一条正则，再严格解码核 65 / 16 字节）。",
        "keysSendOnly 是正则管不到的部分（公钥不在 P-256 曲线上）：sqlOk 为 true（SQL 收下），sendOk 为 false（发送时 importKey 失败，按 bad_keys 处理）。这一组不进两边结论必须一致的比对。",
        "由测试开发维护；改了要跑 tests/build/push-endpoints-fixture.test.ts（格式、条数，并用独立的参考实现核对每一条 ok）。"
    ],
    "version": 1,
    "endpoints": E,
    "keys": K,
    "keysSendOnly": KS,
}
text = json.dumps(doc, ensure_ascii=False, indent=1)
# 原串里的非 ASCII 字符一律写成 \uXXXX 转义（安全审查第六节：看得出是哪个字符），说明文字照常写中文
for e in E + K + KS:
    v = e.get("endpoint", e.get("value"))
    raw, esc = json.dumps(v, ensure_ascii=False), json.dumps(v, ensure_ascii=True)
    if raw != esc:
        text = text.replace(raw, esc)
assert json.loads(text) == doc
with open(OUT, "w", encoding="utf-8", newline="\n") as f:
    f.write(text + "\n")
print(sum(e["ok"] for e in E), sum(not e["ok"] for e in E), sum(k["ok"] for k in K), sum(not k["ok"] for k in K), len(KS))
