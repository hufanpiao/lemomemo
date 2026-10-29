"""生成启动画面用的 Noto Sans SC 子集字库（R-253；和 iOS 启动图 R-243 同一份字形）。

用法：python -I build/make_splash_font.py [--verify] [--edge <msedge.exe 路径>]
- 文字：直接取 build/export_splash.py 的 NAME、NAME2、FOOT（“柠檬记”“Lemo”“说一句，清清爽爽记下来”），
  再加 KO_TEXT（韩文版文字；现在启动图没有韩文版，为空）和空格、常用标点 PUNCT。改了启动图文字就重跑本脚本
- 字源：export_splash.py 在 Windows 上用无头 Edge 渲染，字体栈落到本机的 Noto Sans SC。本机装了两套同名字体
  （系统自带的可变字体 C:/Windows/Fonts/NotoSansSC-VF.ttf 2.04，和用户字体目录里 Google Fonts 的静态字重 2.004），
  2026-10-29 用 Edge 逐像素实测 Edge 实际取哪一个：400 取系统的可变字体（按 wght=400 取实例），
  800 取用户目录的 NotoSansSC-ExtraBold.ttf。所以两个字重各用各的源文件；--verify 会再核一次
  （换了电脑、装卸了字体、重出启动图之后一定要跑）
- 400 保留可变字体的变化表，不先固定成 wght=400 的静态字：实测用 fontTools instancer 固定以后坐标和步进取整，
  Edge 画出来和本机字体有 1372 个像素不同（最大差 54/255）；保留变化表则逐像素相同，代价是文件大约多 6 KB。
  浏览器按 @font-face 的 font-weight（400）自动取 wght=400
- 输出：src/styles/fonts/splash/noto-sans-sc-splash-<字重>.woff2，每个字重一个文件，两个文件含同一组字；
  OFL.txt（许可证全文）是固定文件，脚本只核对它第一行的版权和字体里写的一致，不一致就停下
- 为什么不放 src/public/fonts/：public/fonts/ 整个目录不进 SW 预缓存（src/sw/routes.ts 的 excludedFromPrecache，
  架构 0.38 第 65 条），留给 R-128 可选字体的分片；启动画面离线冷启动也要有字库。照 Manrope 的做法（架构 5.9c）：
  放在源码里，由样式里的 @font-face 用相对路径引用，Vite 打包成 assets/*-<hash>.woff2、随 assets/ 进预缓存
  （vite.config.ts 的 assetsInlineLimit 为 0，不会被内联成 data:，CSP 的 font-src 'self' 不用放宽）
- 名称表全部保留（含版权、许可证说明和网址，OFL 要求随字体带上）；子集属于 OFL 的“修改版”，
  字体内部名字仍是 Noto Sans SC，不含保留字体名 “Source”
- 只留横排用的 OpenType 特性（pyftsubset 默认那组去掉竖排），启动画面没有竖排
可以重复运行，每次全部重新生成；同样的输入生成的文件逐字节相同（不改写 head 的修改时间）。
"""
import argparse
import hashlib
import pathlib
import shutil
import subprocess
import sys
import tempfile

from fontTools import subset
from fontTools.ttLib import TTFont

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from export_icons import ROOT, find_edge  # noqa: E402
from export_splash import FOOT, NAME, NAME2  # noqa: E402

OUT = ROOT / "src" / "styles" / "fonts" / "splash"
OFL = OUT / "OFL.txt"

# 韩文版启动图的文字（现在 export_splash.py 只出中文版；以后出韩文版时把韩文写在这里，或改成从 export_splash 取）
KO_TEXT = ""
# 空格和常用标点（中文全角、ASCII 半角）
PUNCT = " \u3000，。、！？：；“”‘’（）《》〈〉【】…—·～" + ",.!?:;'\"()-~/"

SYS_FONTS = pathlib.Path("C:/Windows/Fonts")
USER_FONTS = pathlib.Path.home() / "AppData/Local/Microsoft/Windows/Fonts"
# (字重, 源文件, 是否可变字体)
FACES = [
    (400, SYS_FONTS / "NotoSansSC-VF.ttf", True),
    (800, USER_FONTS / "NotoSansSC-ExtraBold.ttf", False),
]
DROP_FEATURES = ("vert", "vrt2", "vrtr", "vkna")


def out_name(weight):
    return f"noto-sans-sc-splash-{weight}.woff2"


def splash_text():
    return "".join(sorted(set(NAME + NAME2 + FOOT + KO_TEXT + PUNCT)))


def load_source(path, variable):
    if not path.is_file():
        sys.exit(f"找不到字体源文件 {path}：export_splash.py 渲染时用的就是它，先装好再跑")
    font = TTFont(str(path), recalcTimestamp=False)
    if ("fvar" in font) != variable:
        sys.exit(f"{path.name} {'不是' if variable else '是'}可变字体，和 FACES 里写的不符")
    return font


def check_ofl(font):
    if not OFL.is_file():
        sys.exit(f"缺 {OFL.relative_to(ROOT).as_posix()}：OFL 要求随字体带许可证全文")
    first = OFL.read_text(encoding="utf-8").splitlines()[0]
    # 两份源文件分别写 “© 2014-2021 …” 和 “(c) 2014-2021 …”，OFL.txt 写 “Copyright 2014-2021 …”
    line = font["name"].getDebugName(0).replace("\u00a9", "Copyright").replace("(c)", "Copyright")
    if line not in first:
        sys.exit(f"OFL.txt 第一行的版权和字体里写的不一致，字体里是：{line}")


def make_subset(font, text):
    opts = subset.Options()
    opts.flavor = "woff2"
    opts.name_IDs = ["*"]  # 版权（0）、许可证说明（13）、许可证网址（14）都留着
    opts.name_languages = ["*"]
    opts.notdef_outline = True
    opts.layout_features = [f for f in opts.layout_features if f not in DROP_FEATURES]
    sub = subset.Subsetter(options=opts)
    sub.populate(text=text)
    sub.subset(font)


def build():
    text = splash_text()
    OUT.mkdir(parents=True, exist_ok=True)
    for weight, path, variable in FACES:
        font = load_source(path, variable)
        cmap = font.getBestCmap()
        missing = [c for c in text if ord(c) not in cmap]
        if missing:
            sys.exit(f"{path.name} 没有这些字：{''.join(missing)}")
        check_ofl(font)
        make_subset(font, text)
        dest = OUT / out_name(weight)
        font.save(str(dest), reorderTables=True)
        data = dest.read_bytes()
        print(
            f"写入 {dest.relative_to(ROOT).as_posix()}：{len(data)} 字节，{len(font.getGlyphOrder())} 个字形，"
            f"sha256 {hashlib.sha256(data).hexdigest()[:16]}（源 {path.name}）"
        )
    print(f"共 {len(text)} 个字符：{text}")


def shot(edge, tmp, name, css_face, family, weight):
    """按启动图的字号（390 屏宽：名字 31.2px、Lemo 13.52px、底部那句 13.26px）和 3 倍率截一张，外加大字和标点。"""
    html = tmp / f"{name}.html"
    html.write_text(
        f"""<!doctype html><meta charset="utf-8"><style>{css_face}
html,body{{margin:0;background:#fff;overflow:hidden}}
div{{font-family:{family};font-weight:{weight};color:#141518;line-height:1.2;white-space:nowrap;padding:4px 10px}}
</style>
<div style="font-size:31.2px;letter-spacing:.02em">{NAME}</div><div style="font-size:13.52px">{NAME2}</div>
<div style="font-size:13.26px">{FOOT}</div><div style="font-size:64px">{NAME}{NAME2}{FOOT}{KO_TEXT}</div>
<div style="font-size:24px">{PUNCT}</div>""",
        encoding="utf-8",
    )
    out = tmp / f"{name}.png"
    subprocess.run(
        [
            edge, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=3",
            f"--user-data-dir={tmp / 'profile'}", "--window-size=1100,300", f"--screenshot={out}", html.as_uri(),
        ],
        check=True, capture_output=True, timeout=120,
    )
    return out


def verify(edge):
    """用 Edge 分别按本机字体（export_splash.py 的做法）和子集字库各画一遍，逐像素比较。"""
    from PIL import Image, ImageChops

    tmp = pathlib.Path(tempfile.mkdtemp(prefix="lemo-splash-font-"))
    bad = False
    try:
        for weight, _, _ in FACES:
            src = OUT / out_name(weight)
            shutil.copy(src, tmp / src.name)
            face = f"@font-face{{font-family:SplashSubset;src:url({src.name}) format('woff2');font-weight:{weight}}}"
            a = Image.open(shot(edge, tmp, f"local-{weight}", "", '"Noto Sans SC"', weight)).convert("RGB")
            b = Image.open(shot(edge, tmp, f"subset-{weight}", face, "SplashSubset", weight)).convert("RGB")
            box = ImageChops.difference(a, b).getbbox()
            if box:
                bad = True
                print(f"不一致：{weight} 字重，子集和本机 Noto Sans SC 画出来不同（差异范围 {box}）")
            else:
                print(f"一致：{weight} 字重，子集和本机 Noto Sans SC 逐像素相同")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    if bad:
        sys.exit("本机字体和 FACES 写的不一样了：查清 Edge 现在用哪个文件，改 FACES 后重跑")


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--verify", action="store_true", help="生成后用无头 Edge 逐像素核对和本机字体（启动图）一致")
    ap.add_argument("--edge")
    args = ap.parse_args()
    build()
    if args.verify:
        verify(find_edge(args.edge))


if __name__ == "__main__":
    main()
