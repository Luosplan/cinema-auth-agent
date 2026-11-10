#!/usr/bin/env python3
"""
生成应用图标（与侧栏 logo 同一套图形：深色圆角底 + 白色票根）。

用法：python scripts/make-icons.py
输出：resources/icon.png、build/icon.png、build/icon.ico、build/icon.icns

远端没有矢量渲染器，所以按 24 网格的坐标用 PIL 直接画，
再 4 倍超采样降下来。改图形时改下面的常量即可。
"""
import os
import struct
from PIL import Image, ImageDraw

# ---- 24 网格上的图形定义（与 Sidebar/index.vue 里的 SVG 一致）----
INK = (23, 24, 26, 255)
PAPER = (255, 255, 255, 255)

SQUARE_R = 6.5
TICKET = (5.4, 8.3, 18.6, 15.7)   # x0, y0, x1, y1
TICKET_R = 1.5
NOTCH_R = 1.45
NOTCH_Y = 12.0
PERF_X = 12.0
PERF_SEGMENTS = [(9.2, 10.7), (11.25, 12.75), (13.3, 14.8)]
PERF_W = 1.0

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SUPER = 4


def render(size: int) -> Image.Image:
    """按 24 网格画一张 size×size 的 RGBA 图标。"""
    s = size * SUPER
    k = s / 24.0
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    def box(x0, y0, x1, y1):
        return [x0 * k, y0 * k, x1 * k, y1 * k]

    # 底色：整块圆角方
    d.rounded_rectangle(box(0, 0, 24, 24), radius=SQUARE_R * k, fill=INK)

    # 票根
    d.rounded_rectangle(
        box(TICKET[0], TICKET[1], TICKET[2], TICKET[3]), radius=TICKET_R * k, fill=PAPER
    )

    # 左右两个半圆缺口
    for cx in (TICKET[0], TICKET[2]):
        d.ellipse(
            box(cx - NOTCH_R, NOTCH_Y - NOTCH_R, cx + NOTCH_R, NOTCH_Y + NOTCH_R), fill=INK
        )

    # 中间的骑缝线
    for y0, y1 in PERF_SEGMENTS:
        d.rounded_rectangle(
            box(PERF_X - PERF_W / 2, y0, PERF_X + PERF_W / 2, y1), radius=PERF_W / 2 * k, fill=INK
        )

    return img.resize((size, size), Image.LANCZOS)


def write_icns(path, pngs):
    """手搓 icns 容器：每个 type 直接塞 PNG 数据段。"""
    body = b""
    for type_code, data in pngs:
        body += type_code + struct.pack(">I", len(data) + 8) + data
    with open(path, "wb") as f:
        f.write(b"icns" + struct.pack(">I", len(body) + 8) + body)


def main():
    master = render(1024)

    png_512 = master.resize((512, 512), Image.LANCZOS)
    for rel in ("resources/icon.png", "build/icon.png"):
        dst = os.path.join(ROOT, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        png_512.save(dst, "PNG")
        print("png ", rel)

    ico_sizes = [16, 24, 32, 48, 64, 128, 256]
    ico_path = os.path.join(ROOT, "build/icon.ico")
    master.resize((256, 256), Image.LANCZOS).save(ico_path, sizes=[(n, n) for n in ico_sizes])
    print("ico  build/icon.ico", ico_sizes)

    icns_sizes = [
        (b"icp4", 16),
        (b"icp5", 32),
        (b"icp6", 64),
        (b"ic07", 128),
        (b"ic08", 256),
        (b"ic09", 512),
        (b"ic10", 1024),
        (b"ic11", 32),
        (b"ic12", 64),
        (b"ic13", 256),
        (b"ic14", 512),
    ]
    import io

    pngs = []
    for code, n in icns_sizes:
        buf = io.BytesIO()
        master.resize((n, n), Image.LANCZOS).save(buf, "PNG")
        pngs.append((code, buf.getvalue()))
    write_icns(os.path.join(ROOT, "build/icon.icns"), pngs)
    print("icns build/icon.icns", [n for _, n in icns_sizes])


if __name__ == "__main__":
    main()
