"""导出 iOS 启动图（apple-touch-startup-image，只出竖屏；R-72 定稿版式，R-232 定字体）。

用法：python -I build/export_splash.py [--edge <msedge.exe 路径>]
- 版式出处：docs/02-设计/图标与命名/图标与名字-候选.html 的“iOS 启动图”一节和定稿 L 的启动画面
  （满底柠檬黄光 bgL、正中偏上的玻璃圆片 markL、“柠檬记 / Lemo”、底部一句话，字色 #141518）
- 版式规则（定稿页原文）：玻璃圆片直径取屏幕宽度的 42%，圆心在屏幕高度 40% 处；名字字号取屏幕宽度的 8%；
  底部那句话距底边 6%、字号取屏幕宽度的 3.4%；文字左右各留 10% 安全边距
  定稿页没写的两处照启动画面样张的比例：英文名字号 = 名字的 13/30、透明度 .7；名字在图标下方 14/390 屏宽；底部那句话透明度 .6
- 图源：src/public/icons/logo-mark.svg 里 <!-- bgL --> 和 <!-- markL --> 两段（不另抄一份，改图只改那一个文件）
- 字体：iPhone 系统字体 -apple-system / "PingFang SC"；Windows 上渲染时这两个都没有，回退到 Noto Sans SC（SIL OFL，可商用），
  渲染前检查本机装了 Noto Sans SC，没有就停下
- 做法：和 build/export_icons.py 同一套：无头 Edge 按 CSS 尺寸、设备倍率截图，Pillow 存不透明 PNG
- 输出：src/public/icons/startup/startup-<宽>x<高>.png；src/index.html 里的 12 条 link 要手动照 link_tag() 的写法改，
  由 src/app/__tests__/startup-image.test.ts 用文本解析这里的 DEVICES（每行一个元组，改写法要同步改测试），
  核对它和定稿页表格、index.html 的 12 条 link 逐条一致（含顺序）
可以重复运行，每次全部重新生成。深色模式不单独出（R-232：待真机实测能不能单独指定）。
"""
import argparse
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

from PIL import Image

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from export_icons import MAIN_SVG, ROOT, find_edge  # noqa: E402

OUT = ROOT / "src" / "public" / "icons" / "startup"
INK = "#141518"
FONT_STACK = '-apple-system, "PingFang SC", "Noto Sans SC", sans-serif'
NAME, NAME2, FOOT = "柠檬记", "Lemo", "说一句，清清爽爽记下来"

# (图片宽, 图片高, CSS 宽, CSS 高, 倍率, 机型)：定稿页“iOS 启动图”表格原样
DEVICES = [
    (1320, 2868, 440, 956, 3, "iPhone 17 Pro Max、16 Pro Max"),
    (1260, 2736, 420, 912, 3, "iPhone Air"),
    (1206, 2622, 402, 874, 3, "iPhone 17、17 Pro、16 Pro"),
    (1290, 2796, 430, 932, 3, "iPhone 16 Plus、15 Plus、15 Pro Max、14 Pro Max"),
    (1179, 2556, 393, 852, 3, "iPhone 16、15、15 Pro、14 Pro"),
    (1284, 2778, 428, 926, 3, "iPhone 14 Plus、13 Pro Max、12 Pro Max"),
    (1170, 2532, 390, 844, 3, "iPhone 14、13、13 Pro、12、12 Pro"),
    (1080, 2340, 360, 780, 3, "iPhone 13 mini、12 mini"),
    (1125, 2436, 375, 812, 3, "iPhone 11 Pro、XS、X"),
    (1242, 2688, 414, 896, 3, "iPhone 11 Pro Max、XS Max"),
    (828, 1792, 414, 896, 2, "iPhone 11、XR"),
    (750, 1334, 375, 667, 2, "iPhone SE（第 2、3 代）、8"),
]

GLASS_R = 304  # markL 里玻璃圆片的半径（1024 坐标）


def file_name(w, h):
    return f"startup-{w}x{h}.png"


def link_tag(w, h, cw, ch, dpr):
    media = (
        f"(device-width: {cw}px) and (device-height: {ch}px) and "
        f"(-webkit-device-pixel-ratio: {dpr}) and (orientation: portrait)"
    )
    return f'<link rel="apple-touch-startup-image" media="{media}" href="/app/icons/startup/{file_name(w, h)}" />'


def pieces():
    """从 logo-mark.svg 取 defs、bgL、markL 三段。"""
    svg = MAIN_SVG.read_text(encoding="utf-8")
    defs = re.search(r"<defs>.*?</defs>", svg, re.S).group(0)
    m = re.search(r"<!-- bgL -->(.*?)<!-- markL -->(.*)</g>\s*</svg>", svg, re.S)
    if not m:
        sys.exit("logo-mark.svg 里找不到 <!-- bgL --> / <!-- markL --> 两段")
    return defs, m.group(1), m.group(2)


def page(cw, ch):
    defs, bg, mark = pieces()
    glass_d = 0.42 * cw  # 玻璃圆片直径
    box = glass_d * 1024 / (2 * GLASS_R)  # markL 整个 1024 方框画多大
    cy = 0.40 * ch
    name_top = cy + box / 2 + 14 / 390 * cw
    name_px, name2_px, foot_px = 0.08 * cw, 0.08 * cw * 13 / 30, 0.034 * cw
    return f"""<!doctype html><meta charset="utf-8"><style>
html,body{{margin:0;padding:0;overflow:hidden;width:{cw}px;height:{ch}px;background:#F0E289}}
body{{position:relative;font-family:{FONT_STACK};color:{INK}}}
svg{{position:absolute;display:block}}
.t{{position:absolute;left:{0.1 * cw}px;right:{0.1 * cw}px;text-align:center;white-space:nowrap;line-height:1.2}}
</style>
<svg width="{ch}" height="{ch}" style="left:{(cw - ch) / 2}px;top:0" viewBox="0 0 1024 1024">{defs}{bg}</svg>
<svg width="{box}" height="{box}" style="left:{(cw - box) / 2}px;top:{cy - box / 2}px" viewBox="0 0 1024 1024" overflow="visible">{defs}{mark}</svg>
<div class="t" style="top:{name_top}px;font-size:{name_px}px;font-weight:800;letter-spacing:.02em">{NAME}</div>
<div class="t" style="top:{name_top + name_px * 1.2 + 2 / 390 * cw}px;font-size:{name2_px}px;opacity:.7">{NAME2}</div>
<div class="t" style="bottom:{0.06 * ch}px;font-size:{foot_px}px;opacity:.6">{FOOT}</div>
"""


def check_font():
    dirs = [pathlib.Path("C:/Windows/Fonts"), pathlib.Path.home() / "AppData/Local/Microsoft/Windows/Fonts"]
    if not any(any(d.glob("NotoSansSC*")) for d in dirs if d.is_dir()):
        sys.exit("本机没有 Noto Sans SC：Windows 上 -apple-system、PingFang SC 都没有，会掉到雅黑等不可商用字体，先装 Noto Sans SC")


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--edge")
    args = ap.parse_args()
    edge = find_edge(args.edge)
    check_font()
    OUT.mkdir(parents=True, exist_ok=True)
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="lemo-splash-"))
    try:
        for w, h, cw, ch, dpr, model in DEVICES:
            assert (cw * dpr, ch * dpr) == (w, h), f"{w}x{h} 和 {cw}x{ch}@{dpr}x 对不上"
            html = tmp / f"{w}x{h}.html"
            html.write_text(page(cw, ch), encoding="utf-8")
            shot = tmp / f"{w}x{h}.png"
            subprocess.run(
                [
                    edge, "--headless=new", "--disable-gpu", "--hide-scrollbars", f"--force-device-scale-factor={dpr}",
                    "--default-background-color=000000ff", f"--user-data-dir={tmp / 'profile'}",
                    f"--window-size={cw},{ch}", f"--screenshot={shot}", html.as_uri(),
                ],
                check=True, capture_output=True, timeout=120,
            )
            im = Image.open(shot)
            im.load()
            if im.size != (w, h):
                sys.exit(f"Edge 截图尺寸不对：{im.size}，应当是 {w}x{h}")
            im.convert("RGB").save(OUT / file_name(w, h), "PNG", optimize=True)
            print(f"写入 src/public/icons/startup/{file_name(w, h)}（{model}）")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
