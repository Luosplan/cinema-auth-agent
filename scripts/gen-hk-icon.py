import math
import os
import struct
import subprocess
import sys
import tempfile
from PIL import Image, ImageDraw, ImageFont, ImageFilter

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
BUILD_DIR = os.path.join(PROJECT_DIR, "build")
RESOURCES_DIR = os.path.join(PROJECT_DIR, "resources")

FONT_PATH = "C:/Windows/Fonts/arialbd.ttf"
BG_COLOR = (24, 144, 255, 255)
BG_TOP = (47, 128, 237, 255)
BG_BOTTOM = (24, 144, 255, 255)
TEXT_COLOR = (255, 255, 255, 255)


def _rounded_rect_mask(size, radius):
    mask = Image.new("L", size, 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle([0, 0, size[0] - 1, size[1] - 1], radius=radius, fill=255)
    return mask


def _draw_gradient_bg(draw, size, top_color, bottom_color, radius):
    w, h = size
    gradient = Image.new("RGBA", size, (0, 0, 0, 0))
    g_draw = ImageDraw.Draw(gradient)
    for y in range(h):
        t = y / max(h - 1, 1)
        r = int(top_color[0] + (bottom_color[0] - top_color[0]) * t)
        g = int(top_color[1] + (bottom_color[1] - top_color[1]) * t)
        b = int(top_color[2] + (bottom_color[2] - top_color[2]) * t)
        a = int(top_color[3] + (bottom_color[3] - top_color[3]) * t)
        g_draw.line([(0, y), (w, y)], fill=(r, g, b, a))
    mask = _rounded_rect_mask(size, radius)
    result = Image.new("RGBA", size, (0, 0, 0, 0))
    result.paste(gradient, (0, 0), mask)
    return result


def _find_font(text, target_height):
    for size in range(target_height * 2, 8, -1):
        try:
            f = ImageFont.truetype(FONT_PATH, size)
            bbox = f.getbbox(text)
            h = bbox[3] - bbox[1]
            if h <= target_height:
                return f
        except Exception:
            continue
    return ImageFont.load_default()


def _draw_shadow_text(img, text, font, color, offset=(0, 0), shadow_color=None):
    draw = ImageDraw.Draw(img)
    bbox = font.getbbox(text)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    x = (img.width - tw) // 2 - bbox[0] + offset[0]
    y = (img.height - th) // 2 - bbox[1] + offset[1]
    if shadow_color:
        for dx, dy in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
            draw.text((x + dx, y + dy), text, font=font, fill=shadow_color)
    draw.text((x, y), text, font=font, fill=color)


def create_icon(size, text="HK"):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    radius = int(size * 0.22)
    bg = _draw_gradient_bg(ImageDraw.Draw(img), (size, size), BG_TOP, BG_BOTTOM, radius)
    img = bg

    target_text_height = int(size * 0.38)
    font = _find_font(text, target_text_height)

    shadow_color = (0, 0, 0, 40) if size >= 48 else None
    _draw_shadow_text(img, text, font, TEXT_COLOR, offset=(0, int(size * 0.02)), shadow_color=shadow_color)
    return img


def save_ico(images, path):
    try:
        subprocess.run(["icotool", "--create"] + [f"--raw={p}" for p in images],
                       capture_output=True, check=False)
    except Exception:
        pass

    entries = []
    offset = 6 + 16 * len(images)

    def _ico_size(s):
        return 0 if s >= 256 else s

    for img_path in images:
        with open(img_path, "rb") as f:
            data = f.read()
        img = Image.open(img_path)
        w = _ico_size(img.width)
        h = _ico_size(img.height)
        entries.append((w, h, offset, len(data), data))
        offset += len(data)

    with open(path, "wb") as out:
        out.write(struct.pack("<HHH", 0, 1, len(entries)))
        for w, h, off, size, _ in entries:
            out.write(struct.pack("<BBBBHHII", w, h, 0, 0, 1, 32, size, off))
        for _, _, _, _, data in entries:
            out.write(data)


def save_icns(images, path):
    try:
        import PIL.IcnsImagePlugin
    except Exception:
        pass

    size_map = {
        16: b"icp4",
        32: b"icp5",
        64: b"icp6",
        128: b"icp7",
        256: b"icp8",
        512: b"icp9",
        1024: b"ic10",
    }
    with open(path, "wb") as out:
        out.write(b"icns")
        total = 8
        chunks = []
        for img_path in images:
            img = Image.open(img_path)
            size = img.width
            if size in size_map:
                with open(img_path, "rb") as f:
                    data = f.read()
                typ = size_map[size]
                length = len(data) + 8
                chunks.append((typ, length, data))
                total += length
        out.write(struct.pack(">I", total))
        for typ, length, data in chunks:
            out.write(typ)
            out.write(struct.pack(">I", length))
            out.write(data)


def main():
    os.makedirs(BUILD_DIR, exist_ok=True)
    os.makedirs(RESOURCES_DIR, exist_ok=True)

    sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
    temp_dir = tempfile.mkdtemp(prefix="hk-icons-")
    temp_pngs = []

    print("Generating HK ticket icons...")
    for s in sizes:
        icon = create_icon(s)
        tmp_path = os.path.join(temp_dir, f"icon_{s}x{s}.png")
        icon.save(tmp_path, "PNG")
        temp_pngs.append(tmp_path)
        print(f"  + {s}x{s}")

    png_512 = os.path.join(BUILD_DIR, "icon.png")
    Image.open(temp_pngs[sizes.index(512)]).save(png_512, "PNG")
    print(f"  -> {png_512}")

    res_png = os.path.join(RESOURCES_DIR, "icon.png")
    Image.open(temp_pngs[sizes.index(512)]).save(res_png, "PNG")
    print(f"  -> {res_png}")

    ico_path = os.path.join(BUILD_DIR, "icon.ico")
    ico_sizes = [16, 24, 32, 48, 64, 128, 256]
    ico_images = [temp_pngs[sizes.index(s)] for s in ico_sizes]
    save_ico(ico_images, ico_path)
    print(f"  -> {ico_path}")

    icns_path = os.path.join(BUILD_DIR, "icon.icns")
    icns_sizes = [16, 32, 64, 128, 256, 512]
    icns_images = [temp_pngs[sizes.index(s)] for s in icns_sizes]
    save_icns(icns_images, icns_path)
    print(f"  -> {icns_path}")

    import shutil
    shutil.rmtree(temp_dir, ignore_errors=True)
    print("Done! All HK ticket icons generated.")


if __name__ == "__main__":
    main()
