"""导出柠檬记图标（定稿 R-72，导出清单见 docs/02-设计/图标与命名/图标与名字-候选.html “交给开发的导出清单”）。

用法：python -I build/export_icons.py [--edge <msedge.exe 路径>]
- 源文件：src/public/icons/logo-mark.svg（主图 icL）、src/public/icons/logo-mark-small.svg（简化图 icLs）
- 规则：48 px 及以下用简化图，60 px 及以上用主图；PNG 一律方形、满底、不透明、不预切圆角
- 做法：无头 Edge 把 SVG 按 1024×1024 截图，再用 Pillow LANCZOS 缩到各尺寸
- 输出：src/public/icons/ 下的 PNG、favicon.ico、favicon.svg（= 简化图）；assets/icons/app.ico（Windows exe 用，不进网页）
可以重复运行，每次全部重新生成。
"""
import argparse
import io
import pathlib
import shutil
import struct
import subprocess
import sys
import tempfile

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
ICONS = ROOT / "src" / "public" / "icons"
MAIN_SVG = ICONS / "logo-mark.svg"
SMALL_SVG = ICONS / "logo-mark-small.svg"
APP_ICO = ROOT / "assets" / "icons" / "app.ico"
RENDER = 1024

# 文件名 → (尺寸, 用哪张)；"main" 主图、"small" 简化图
PNGS = {
    "apple-touch-icon.png": (180, "main"),
    "apple-touch-icon-167.png": (167, "main"),
    "apple-touch-icon-152.png": (152, "main"),
    "apple-touch-icon-120.png": (120, "main"),
    "icon-192.png": (192, "main"),
    "icon-512.png": (512, "main"),
    "icon-maskable-192.png": (192, "main"),
    "icon-maskable-512.png": (512, "main"),
    "favicon-32.png": (32, "small"),
    "favicon-16.png": (16, "small"),
}
FAVICON_ICO = [16, 32, 48]  # 都用简化图
APP_ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]  # ≤48 简化图，≥64 主图；256 存 PNG，其余存 BMP

EDGE_CANDIDATES = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
]


def which(size):
    return "small" if size <= 48 else "main"


def find_edge(arg):
    for p in ([arg] if arg else []) + EDGE_CANDIDATES:
        if p and pathlib.Path(p).is_file():
            return p
    sys.exit("找不到 msedge.exe，用 --edge 指定路径")


def render(edge, svg_path, tmp):
    """无头 Edge 把 SVG 画成 1024×1024，返回不透明的 RGB 图。"""
    svg = svg_path.read_text(encoding="utf-8")
    html = tmp / f"{svg_path.stem}.html"
    html.write_text(
        "<!doctype html><meta charset='utf-8'><style>html,body{margin:0;padding:0;overflow:hidden;background:#000}"
        f"svg{{display:block;width:{RENDER}px;height:{RENDER}px}}</style>{svg}",
        encoding="utf-8",
    )
    out = tmp / f"{svg_path.stem}.png"
    subprocess.run(
        [
            edge, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
            "--default-background-color=000000ff", f"--user-data-dir={tmp / 'profile'}",
            f"--window-size={RENDER},{RENDER}", f"--screenshot={out}", html.as_uri(),
        ],
        check=True, capture_output=True, timeout=120,
    )
    im = Image.open(out)
    im.load()
    if im.size != (RENDER, RENDER):
        sys.exit(f"Edge 截图尺寸不对：{im.size}")
    return im.convert("RGB")


def scaled(src, size):
    return src.resize((size, size), Image.Resampling.LANCZOS)


def _ico_entry(im, fmt):
    """用 Pillow 写一个只有一张图的 ico，取出目录项和图像数据。fmt：'bmp' 或 'png'。"""
    buf = io.BytesIO()
    kw = {"bitmap_format": "bmp"} if fmt == "bmp" else {}
    im.convert("RGBA").save(buf, "ICO", sizes=[im.size], **kw)
    raw = buf.getvalue()
    entry = raw[6:22]
    size, offset = struct.unpack("<II", entry[8:16])
    return entry[:8], raw[offset:offset + size]


def write_ico(path, frames):
    """frames：[(图, 'bmp' 或 'png')]，按尺寸从小到大。"""
    parts = [_ico_entry(im, fmt) for im, fmt in frames]
    head = struct.pack("<HHH", 0, 1, len(parts))
    offset = 6 + 16 * len(parts)
    dirs, datas = b"", b""
    for meta, data in parts:
        dirs += meta + struct.pack("<II", len(data), offset)
        datas += data
        offset += len(data)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(head + dirs + datas)


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--edge")
    args = ap.parse_args()
    edge = find_edge(args.edge)
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="lemo-icons-"))
    try:
        src = {"main": render(edge, MAIN_SVG, tmp), "small": render(edge, SMALL_SVG, tmp)}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    for name, (size, kind) in PNGS.items():
        assert which(size) == kind, f"{name}：{size} px 应当用 {which(size)}"
        scaled(src[kind], size).save(ICONS / name, "PNG", optimize=True)
        print(f"写入 src/public/icons/{name}（{size}×{size}，{'主图' if kind == 'main' else '简化图'}）")

    write_ico(ICONS / "favicon.ico", [(scaled(src["small"], s), "bmp") for s in FAVICON_ICO])
    print(f"写入 src/public/icons/favicon.ico（{'、'.join(map(str, FAVICON_ICO))}，简化图）")

    shutil.copyfile(SMALL_SVG, ICONS / "favicon.svg")
    print("写入 src/public/icons/favicon.svg（= logo-mark-small.svg）")

    write_ico(APP_ICO, [(scaled(src[which(s)], s), "png" if s == 256 else "bmp") for s in APP_ICO_SIZES])
    print(f"写入 assets/icons/app.ico（{'、'.join(map(str, APP_ICO_SIZES))}；48 及以下简化图）")


if __name__ == "__main__":
    main()
