# 构建脚本：先跑架构检查（build/check_arch.py，不通过就停止），再读取 build/manifest.json，把 CSS、JS 按顺序内联进 src/index.html。
#   --target claude（默认）：生成发布用单文件 dist/planner.html，以及两个本地测试页
#       dist/test.html         模拟存储适配器 mock-db（tests/mock/mock-db.js），不需要 claude.ai
#       dist/test-claude.html  与发布版同一份页面 + window.claude 桩（tests/mock/claude-stub.js），验证 claude-db 适配器
#       两个测试页的示例数据都来自 tests/mock/sample-data.js；顶部有“测试页面”提示条（tests/harness/banner.html）
#   --target staging：预发布版 dist/staging.html，和正式版一样接真实数据库，顶部提示“预发布测试版：不是你的正式数据”
#   --target web：独立服务器 / PWA 版，预留，尚未实现。
#   发布用的 dist/planner.html 里不能出现任何环境提示文案，构建时会检查。
# 依赖：Python 3.8+ 标准库、build/check_arch.py。用法：python build/build.py [--target claude|staging|web]
import argparse
import json
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import check_arch  # noqa: E402  同目录的架构检查

ROOT = pathlib.Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"


def fail(msg):
    sys.exit("构建失败：" + msg)


def read(rel):
    """读源文件；用 utf-8-sig，文件开头若有 BOM 会被去掉，不会混进产物。"""
    f = ROOT / rel
    if not f.is_file():
        fail("找不到文件 %s（检查 build/manifest.json 里的路径是否写对）" % rel)
    try:
        return f.read_text(encoding="utf-8-sig")
    except UnicodeDecodeError as e:
        fail("%s 不是 UTF-8 编码（%s），请用 UTF-8 保存" % (rel, e))


def strip_lead_comment(html):
    """去掉 HTML 源文件开头的说明注释（源码规范要求的文件头注释，不进产物）。"""
    return re.sub(r"\A\s*<!--.*?-->\s*\n", "", html, count=1, flags=re.S)


def css_bundle(m):
    parts = [read(p).rstrip("\n") for p in m["styles"]]
    return "<style>\n" + "\n".join(parts) + "\n</style>"


def js_bundle(m, build_cfg, extra_before_entry=()):
    files = list(m["scripts"]) + list(extra_before_entry) + [m["entry"]]
    out = ["<script>", "(function(){", "const App = {};",
           "App.BUILD = " + json.dumps(build_cfg, ensure_ascii=False) + ";"]
    for p in files:
        src = read(p)
        if "</script" in src.lower():
            fail("%s 里出现了 </script，会截断内联脚本" % p)
        out += ["// ==== " + p + " ====", "(function(){", src.rstrip("\n"), "})();"]
    out += ["})();", "</script>"]
    return "\n".join(out)


def page(m, build_cfg, extra_before_entry=()):
    tpl = strip_lead_comment(read(m["template"]))
    for mark in ("<!-- @styles -->", "<!-- @scripts -->"):
        if tpl.count(mark) != 1:
            fail("模板 %s 里 %s 必须恰好出现一次" % (m["template"], mark))
    tpl = tpl.replace("<!-- @styles -->", css_bundle(m))
    return tpl.replace("<!-- @scripts -->", js_bundle(m, build_cfg, extra_before_entry))


# 环境提示条：文案 → (底色, 字色)。发布版不能出现这里的任何一句
BANNERS = {
    "test": ("测试页面：这里用的是模拟数据，刷新就会还原，不会保存到云端", "#f1df4a", "#121316"),
    "staging": ("预发布测试版：不是你的正式数据", "#3a6cf4", "#ffffff"),
}


def banner(kind):
    text, bg, fg = BANNERS[kind]
    html = strip_lead_comment(read("tests/harness/banner.html")).strip()
    return html.replace("{{文案}}", text).replace("{{底色}}", bg).replace("{{字色}}", fg)


def harness(m, app_html, stub_files):
    """测试页：骨架 + 测试提示条 + 页面脚本之前的一段 <script>（示例数据、可选的 window.claude 桩）+ 页面。"""
    sk = strip_lead_comment(read(m["tests"]["skeleton"])).rstrip("\n")
    stub = "<script>\n" + "\n".join(read(p).rstrip("\n") for p in stub_files) + "\n</script>\n"
    for mark in ("<!-- @banner -->", "<!-- @stub -->", "<!-- @app -->"):
        if sk.count(mark) != 1:
            fail("测试页骨架 %s 里 %s 必须恰好出现一次" % (m["tests"]["skeleton"], mark))
    return sk.replace("<!-- @banner -->", banner("test")).replace("<!-- @stub -->", stub).replace("<!-- @app -->", app_html) + "\n"


def check_no_banner(name, html):
    """发布版里不能混进环境提示文案。"""
    for text, _, _ in BANNERS.values():
        if text in html:
            fail("%s 里出现了环境提示“%s”，发布版不能带测试提示" % (name, text))


def write(name, text):
    DIST.mkdir(exist_ok=True)
    (DIST / name).write_text(text, encoding="utf-8", newline="\n")
    print("  写出 dist/%s（%d 字节）" % (name, len(text.encode("utf-8"))))


def build_claude(m):
    prod = page(m, {"target": "claude", "storage": "claude-db"})
    check_no_banner("dist/planner.html", prod)
    write("planner.html", prod)
    mock = page(m, {"target": "test", "storage": "mock-db"}, [m["tests"]["mockAdapter"]])
    t = m["tests"]
    write("test.html", harness(m, mock, [t["sampleData"]]))
    write("test-claude.html", harness(m, prod, [t["sampleData"], t["claudeStub"]]))


def build_staging(m):
    """预发布版：和正式版同一份页面、接真实数据库，只多一条“预发布测试版”提示条。"""
    html = page(m, {"target": "staging", "storage": "claude-db"}) + "\n" + banner("staging") + "\n"
    write("staging.html", html)
    prod = ROOT / "dist/planner.html"
    if prod.is_file():
        check_no_banner("dist/planner.html", prod.read_text(encoding="utf-8"))


def build_web(m):
    # 预留：独立服务器 / PWA 版。以后会生成多文件产物 dist/web/：
    #   index.html（只引用外部文件）、assets/app.<hash>.css、assets/app.<hash>.js（按 manifest 顺序拼接，可选压缩）、
    #   manifest.webmanifest（名称、图标 192/512、theme_color、display: standalone、start_url）、
    #   sw.js（Service Worker：预缓存外壳实现离线打开，处理 push / notificationclick 做提醒推送）、
    #   icons/（从 assets/ 生成各尺寸图标），并把 App.BUILD.storage 设为 "rest"。
    print("--target web 尚未实现：以后会生成多文件版本（index.html + 静态资源）、manifest.webmanifest 和 Service Worker。")
    return 2


def main():
    if hasattr(sys.stdout, "reconfigure"):   # Windows 下管道输出默认是 GBK，统一成 UTF-8
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description="日程与待办 构建脚本")
    ap.add_argument("--target", choices=["claude", "staging", "web"], default="claude",
                    help="claude：单文件发布版和测试页（默认）；staging：预发布版 dist/staging.html；web：独立服务器 PWA 版（预留）")
    args = ap.parse_args()
    try:
        m = json.loads(read("build/manifest.json"))
    except json.JSONDecodeError as e:
        fail("build/manifest.json 格式错误：第 %d 行第 %d 列，%s" % (e.lineno, e.colno, e.msg))
    for key in ("template", "styles", "scripts", "entry", "tests"):
        if key not in m:
            fail("build/manifest.json 缺少 \"%s\" 一项" % key)
    print("架构检查")
    if check_arch.run() != 0:
        fail("架构检查没通过，先按上面的提示修改（规则见 docs/10-架构/架构约定.md）")
    if args.target == "web":
        sys.exit(build_web(m))
    if args.target == "staging":
        print("构建 --target staging")
        build_staging(m)
        print("完成")
        return
    print("构建 --target claude")
    build_claude(m)
    print("完成")


if __name__ == "__main__":
    main()
