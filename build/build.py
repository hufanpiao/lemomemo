# 构建脚本：读取 build/manifest.json，把 CSS、JS 按顺序内联进 src/index.html。
#   --target claude（默认）：生成发布用单文件 dist/planner.html，以及两个本地测试页
#       dist/test.html         模拟存储适配器 mock-db（tests/mock/mock-db.js），不需要 claude.ai
#       dist/test-claude.html  与发布版同一份页面 + window.claude 桩（tests/mock/claude-stub.js），验证 claude-db 适配器
#   --target web：独立服务器 / PWA 版，预留，尚未实现。
# 依赖：Python 3.8+ 标准库。用法：python build/build.py [--target claude|web]
import argparse
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"


def read(rel):
    return (ROOT / rel).read_text(encoding="utf-8")


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
            sys.exit("错误：%s 里出现了 </script，会截断内联脚本" % p)
        out += ["// ==== " + p + " ====", "(function(){", src.rstrip("\n"), "})();"]
    out += ["})();", "</script>"]
    return "\n".join(out)


def page(m, build_cfg, extra_before_entry=()):
    tpl = strip_lead_comment(read(m["template"]))
    for mark in ("<!-- @styles -->", "<!-- @scripts -->"):
        if tpl.count(mark) != 1:
            sys.exit("错误：模板里 %s 必须恰好出现一次" % mark)
    tpl = tpl.replace("<!-- @styles -->", css_bundle(m))
    return tpl.replace("<!-- @scripts -->", js_bundle(m, build_cfg, extra_before_entry))


def harness(m, app_html, stub_js=None):
    sk = strip_lead_comment(read(m["tests"]["skeleton"])).rstrip("\n")
    stub = "<script>\n" + stub_js.rstrip("\n") + "\n</script>\n" if stub_js else ""
    return sk.replace("<!-- @stub -->", stub).replace("<!-- @app -->", app_html) + "\n"


def write(name, text):
    DIST.mkdir(exist_ok=True)
    (DIST / name).write_text(text, encoding="utf-8", newline="\n")
    print("  写出 dist/%s（%d 字节）" % (name, len(text.encode("utf-8"))))


def build_claude(m):
    prod = page(m, {"target": "claude", "storage": "claude-db"})
    write("planner.html", prod)
    mock = page(m, {"target": "test", "storage": "mock-db"}, [m["tests"]["mockAdapter"]])
    write("test.html", harness(m, mock))
    write("test-claude.html", harness(m, prod, read(m["tests"]["claudeStub"])))


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
    ap.add_argument("--target", choices=["claude", "web"], default="claude",
                    help="claude：单文件发布版（默认）；web：独立服务器 PWA 版（预留）")
    args = ap.parse_args()
    m = json.loads(read("build/manifest.json"))
    if args.target == "web":
        sys.exit(build_web(m))
    print("构建 --target claude")
    build_claude(m)
    print("完成")


if __name__ == "__main__":
    main()
