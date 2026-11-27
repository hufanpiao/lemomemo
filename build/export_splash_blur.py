"""导出启动画面（R-251、R-254 方向 B“在听”）用的四张小图：三张预模糊图代替实时高斯模糊，一张深色底代替 CSS 渐变。

用法：python -I build/export_splash_blur.py [--edge <msedge.exe 路径>]
- 为什么要：logo-mark.svg 的 bgL（柠檬光背景，stdDeviation 70）、markL 的玻璃圆片底（stdDeviation 120）和投影（stdDeviation 40）
  都是大半径高斯模糊，启动画面第一帧就要画；设计稿 docs/02-设计/草图-v4/启动画面-三方向.html“取舍”一节建议
  用几 KB 的预模糊图代替实时模糊，免得旧 iPhone 第一帧变慢。模糊半径大，缩到几十像素再放大看不出差别。
- 图源：和 build/export_splash.py 同一份 src/public/icons/logo-mark.svg（用它的 pieces() 取 defs、bgL、markL，不另抄一份）；
  只把带滤镜的三块单独拿出来，用无头 Edge 按 1024 原尺寸渲染，再用 Pillow 缩小：
  - splash-bg.png：bgL 整块（1024 方框），64×64，不透明；页面里按 cover、居中铺满（和启动图一样是正方形按屏高裁两边）
  - splash-disk.png：玻璃圆片底（#f3f2ea 底 + 模糊光斑 + 40% 白），取 1024 方框里 208～816 那一块（圆片外接正方形），
    48×48，不透明；页面里再用 SVG clipPath 切成圆（边缘保持锐利）
  - splash-shadow.png：圆片下面的投影，取 x 128～896、y 672～1024，96×44，带透明
  - splash-dark.png：深色那一屏的底（设计稿：A、B 两个方向深色时都用 glass 深色的 --scr-bg，柠檬光压暗），
    值直接从 src/styles/skins/glass.css 的 glass 深色那一行读（令牌只改 tokens.json，改了以后重跑本脚本），
    按 390×844 画、缩成 60×130，页面里按 100% 100% 拉伸铺满（径向渐变的位置和半径都是百分比，拉伸后形状不变）。
    为什么用图：A24 不准在组件样式里写 rgba() 等颜色函数，App 的皮肤变量在 React 之前也还没按 glass 深色生效
  白圈、高光弧和三根竖条没有滤镜，直接写成 src/index.html 里的内联 SVG（竖条要单独做 scaleY 起伏）。
- 输出：src/styles/splash/*.png，由 src/styles/splash.css 和 src/index.html 用相对路径引用，Vite 打包成带哈希的 assets/
  （assetsInlineLimit 为 0，不会内联成 data:）。
可以重复运行，每次全部重新生成。改了 logo-mark.svg 的 bgL / markL 以后要重跑。
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
from export_icons import ROOT, find_edge  # noqa: E402
from export_splash import pieces  # noqa: E402

OUT = ROOT / "src" / "styles" / "splash"

# (文件名, 取 1024 方框里的哪一块 (左, 上, 右, 下), 输出尺寸, 是否带透明)
PARTS = {
    "bg": ("splash-bg.png", (0, 0, 1024, 1024), (64, 64), False),
    "disk": ("splash-disk.png", (208, 208, 816, 816), (48, 48), False),
    "shadow": ("splash-shadow.png", (128, 672, 896, 1024), (96, 44), True),
}
DARK = ("splash-dark.png", (390, 844), (60, 130))
GLASS_CSS = ROOT / "src" / "styles" / "skins" / "glass.css"


def glass_dark_scr_bg():
    css = GLASS_CSS.read_text(encoding="utf-8")
    m = re.search(r'\[data-skin="glass"\]\[data-theme="dark"\]\{[^}]*?--scr-bg:([^;]+);', css)
    if not m:
        sys.exit("src/styles/skins/glass.css 里找不到 glass 深色的 --scr-bg")
    return m.group(1).strip()


def split_mark(mark):
    """从 markL 里拆出投影（ellipse）和玻璃圆片底（clip-path 那个 g 的内容）。"""
    shadow = re.search(r"<ellipse[^>]*filter=\"url\(#shB\)\"[^>]*/>", mark)
    disk = re.search(r"<g clip-path=\"url\(#clipL\)\">(.*?)</g>\s*<circle", mark, re.S)
    if not shadow or not disk:
        sys.exit("logo-mark.svg 的 markL 里找不到投影 ellipse 或 clipL 那一段，版式改了要同步改本脚本")
    return shadow.group(0), disk.group(1)


def svg_page(defs, body, transparent):
    bg = "transparent" if transparent else "#ffffff"
    return f"""<!doctype html><meta charset="utf-8"><style>
html,body{{margin:0;padding:0;overflow:hidden;width:1024px;height:1024px;background:{bg}}}
svg{{display:block}}
</style>
<svg width="1024" height="1024" viewBox="0 0 1024 1024" overflow="visible">{defs}{body}</svg>
"""


def render(edge, tmp, name, html, transparent, size=(1024, 1024)):
    page = tmp / f"{name}.html"
    page.write_text(html, encoding="utf-8")
    shot = tmp / f"{name}.png"
    subprocess.run(
        [
            edge, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
            f"--default-background-color={'00000000' if transparent else 'ffffffff'}", f"--user-data-dir={tmp / 'profile'}",
            f"--window-size={size[0]},{size[1]}", f"--screenshot={shot}", page.as_uri(),
        ],
        check=True, capture_output=True, timeout=120,
    )
    im = Image.open(shot)
    im.load()
    if im.size != size:
        sys.exit(f"Edge 截图尺寸不对：{im.size}，应当是 {size[0]}x{size[1]}")
    return im


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--edge")
    args = ap.parse_args()
    edge = find_edge(args.edge)
    defs, bg, mark = pieces()
    shadow, disk = split_mark(mark)
    bodies = {"bg": bg, "disk": disk, "shadow": shadow}
    OUT.mkdir(parents=True, exist_ok=True)
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="lemo-splash-blur-"))
    try:
        for key, (fname, box, size, transparent) in PARTS.items():
            im = render(edge, tmp, key, svg_page(defs, bodies[key], transparent), transparent)
            im = im.convert("RGBA" if transparent else "RGB").crop(box).resize(size, Image.Resampling.LANCZOS)
            if transparent and im.getchannel("A").getextrema()[1] == 0:
                sys.exit(f"{fname} 整张全透明：Edge 没按透明底截图，检查 --default-background-color")
            dest = OUT / fname
            im.save(dest, "PNG", optimize=True)
            print(f"写入 src/styles/splash/{fname}：{im.size[0]}×{im.size[1]}，{dest.stat().st_size} 字节")
        fname, (w, h), size = DARK
        html = f"""<!doctype html><meta charset="utf-8"><style>
html,body{{margin:0;padding:0;overflow:hidden;width:{w}px;height:{h}px}}
div{{width:{w}px;height:{h}px;background:{glass_dark_scr_bg()}}}
</style><div></div>
"""
        im = render(edge, tmp, "dark", html, False, (w, h)).convert("RGB").resize(size, Image.Resampling.LANCZOS)
        dest = OUT / fname
        im.save(dest, "PNG", optimize=True)
        print(f"写入 src/styles/splash/{fname}：{size[0]}×{size[1]}，{dest.stat().st_size} 字节")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
