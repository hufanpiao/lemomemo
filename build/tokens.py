"""设计令牌：从 tokens.json 生成视觉稿里的四套主题变量、令牌表，以及给开发用的 tokens.css / tokens.ts（R-148）。

用法：python build/tokens.py          # 生成（改令牌只改 tokens.json，再运行这个）
      python build/tokens.py --check  # 只核对：生成结果和现有文件是否一致、有没有用了却没定义 / 定义了却没用的变量

令牌源：docs/02-设计/皮肤-v4/令牌/tokens.json
写入：  皮肤视觉稿.html 里 /* tokens:begin */ … /* tokens:end */ 之间的四行主题变量，
        <!-- tokentable:begin --> … <!-- tokentable:end --> 之间的令牌表；
        令牌/tokens.css、令牌/tokens.ts（开发时抄进 src/styles/skins 和 TS 常量）。
"""
import html
import json
import pathlib
import re
import sys

sys.stdout.reconfigure(encoding="utf-8")
ROOT = pathlib.Path(__file__).resolve().parent.parent
DIR = ROOT / "docs/02-设计/皮肤-v4"
SRC = DIR / "令牌/tokens.json"
VIS = DIR / "皮肤视觉稿.html"
OUT_CSS = DIR / "令牌/tokens.css"
OUT_TS = DIR / "令牌/tokens.ts"
LABEL = {"simple-light": "简洁·浅色", "simple-dark": "简洁·深色", "glass-light": "磨砂玻璃·浅色", "glass-dark": "磨砂玻璃·深色"}


def load():
    d = json.loads(SRC.read_text(encoding="utf-8"))
    toks = [t for g in d["groups"] for t in g["tokens"]]
    return d, toks


def theme_css(d, toks, sel):
    lines = []
    for th in d["themes"]:
        sk, md = th.split("-")
        body = ";".join(f'{t["name"]}:{t["values"][th]}' for t in toks if "scope" not in t)
        lines.append(sel(sk, md, th) + "{" + body + "}")
    return lines


def resolve(v, vals, depth=0):
    m = re.fullmatch(r"var\((--[\w-]+)\)", v.strip())
    if m and depth < 5 and m.group(1) in vals:
        return resolve(vals[m.group(1)], vals, depth + 1)
    return v


def is_color(v):
    return bool(re.match(r"\s*(#|rgba?\(|hsla?\(|linear-gradient|radial-gradient|transparent)", v))


def cell(raw, vals):
    shown = resolve(raw, vals)
    code = "柔光渐变（见 CSS）" if "gradient" in raw and not raw.startswith("var(") else raw
    sw = f'<span class="sw" style="background:{html.escape(shown, quote=True)}"></span>' if is_color(shown) else ""
    return f"<td>{sw}<code>{html.escape(code)}</code></td>"


def table(d):
    th = d["themes"]
    vals = {x: {t["name"]: t["values"][x] for g in d["groups"] for t in g["tokens"]} for x in th}
    out = ['<div class="dcard"><div class="tw"><table class="t"><tr><th>变量</th><th>用途</th>' + "".join(f"<th>{LABEL[x]}</th>" for x in th) + "</tr>"]
    for g in d["groups"]:
        out.append(f'<tr><td colspan="6" style="font-weight:800;padding-top:14px">{html.escape(g["name"])}</td></tr>')
        for t in g["tokens"]:
            out.append(f'<tr><td class="name"><code>{t["name"]}</code></td><td>{html.escape(t["desc"])}</td>' + "".join(cell(t["values"][x], vals[x]) for x in th) + "</tr>")
    out.append("</table></div></div>")
    return "".join(out)


def between(s, a, b, new):
    i, j = s.index(a) + len(a), s.index(b)
    return s[:i] + new + s[j:]


def build():
    d, toks = load()
    s = VIS.read_text(encoding="utf-8")
    lines = theme_css(d, toks, lambda sk, md, th: f'body[data-skin="{sk}"][data-theme="{md}"], body .th-{th}')
    s = between(s, "/* tokens:begin */\n", "/* tokens:end */", "\n".join(lines) + "\n")
    s = between(s, "<!-- tokentable:begin -->", "<!-- tokentable:end -->", table(d))
    css = ["/* 柠檬记 4.0.0 设计令牌（由 build/tokens.py 从 tokens.json 生成，不要手改） */"]
    css += theme_css(d, toks, lambda sk, md, th: f':root[data-skin="{sk}"][data-theme="{md}"]')
    css += [":root{" + ";".join(f'{t["name"]}:{t["values"][d["themes"][0]]}' for t in toks if "scope" in t) + "}"]
    ts = ["// 柠檬记 4.0.0 设计令牌（由 build/tokens.py 从 tokens.json 生成，不要手改）",
          f"export const themes = {json.dumps(d['themes'])} as const;",
          "export type Theme = (typeof themes)[number];",
          "export const tokens: Record<Theme, Record<string, string>> = " + json.dumps({x: {t["name"]: t["values"][x] for t in toks} for x in d["themes"]}, ensure_ascii=False, indent=2) + ";"]
    return s, "\n".join(css) + "\n", "\n".join(ts) + "\n", toks


def audit(s, toks):
    style = "\n".join(re.findall(r"<style>(.*?)</style>", s, re.S))
    used = set(re.findall(r"var\((--[\w-]+)(?![\w$-]*,)(?![$'])", s))  # 带后备值的 var(--x,…) 和模板里拼出来的 var(--p${n}) 不算
    defined = {t["name"] for t in toks} | set(re.findall(r"(--[\w-]+)\s*:", style)) | set(re.findall(r"setProperty\('(--[\w-]+)'", s))
    defined |= set(re.findall(r"(--[\w-]+):", s))  # 内联 style 里定义的局部变量
    undefined = sorted(used - defined)
    table_part = s[s.index("<!-- tokentable:begin -->"): s.index("<!-- tokentable:end -->")]
    rest = s.replace(table_part, "")
    dyn = "var(--p$" in rest  # 项目色 --p1～--p6 / --p1s～--p6s 在模板里按编号拼出来
    unused = sorted(t["name"] for t in toks if f"var({t['name']}" not in rest and not (dyn and re.fullmatch(r"--p\d+s?", t["name"])))
    return undefined, unused


def main():
    s, css, ts, toks = build()
    if "--check" in sys.argv:
        drift = [p.name for p, c in [(VIS, s), (OUT_CSS, css), (OUT_TS, ts)] if not p.exists() or p.read_text(encoding="utf-8") != c]
        for p in drift:
            print("⚠ 和 tokens.json 不一致（要重新运行 build/tokens.py）：", p)
    else:
        VIS.write_text(s, encoding="utf-8", newline="\n")
        OUT_CSS.write_text(css, encoding="utf-8", newline="\n")
        OUT_TS.write_text(ts, encoding="utf-8", newline="\n")
        drift = []
    undefined, unused = audit(s, toks)
    for n in undefined:
        print("⚠ 用了却没定义：", n)
    for n in unused:
        print("· 定义了但视觉稿没用到（开发时确认是否删）：", n)
    print(f"令牌 {len(toks)} 个；没定义 {len(undefined)}；没用到 {len(unused)}")
    return 1 if (drift or undefined) else 0


if __name__ == "__main__":
    sys.exit(main())
