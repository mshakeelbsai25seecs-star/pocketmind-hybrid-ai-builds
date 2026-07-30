"""
Build PocketMind icons from two sources:
  - In-app mark: original logo (sidebar / UI)
  - Taskbar / window: sharp logo (icon.ico + tauri PNG sizes)
"""
from __future__ import annotations

from io import BytesIO
from pathlib import Path
import struct
import sys

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / "src-tauri" / "icons"
PUBLIC = ROOT / "public"
ASSETS = ROOT / "src" / "assets"

INAPP_SRC = ASSETS / "pocketmind-logo.png"
# Taskbar / title-bar only (transparent). Prefer assets copy.
TASKBAR_CANDIDATES = (
    ASSETS / "pocketmind-logo-transparent-v3.png",
    ASSETS / "pocketmind-logo-sharp.png",
)


def load_source(path: Path) -> Image.Image:
    im = Image.open(path).convert("RGBA")
    px = im.load()
    w, h = im.size

    def is_content(x: int, y: int) -> bool:
        r, g, b, a = px[x, y]
        if a < 8:
            return False
        return max(r, g, b) > 8

    l, t, r, b = w, h, 0, 0
    found = False
    for y in range(h):
        for x in range(w):
            if is_content(x, y):
                found = True
                l = min(l, x)
                t = min(t, y)
                r = max(r, x)
                b = max(b, y)
    if not found:
        return im
    pad = 2
    return im.crop((max(0, l - pad), max(0, t - pad), min(w, r + 1 + pad), min(h, b + 1 + pad)))


def contain_resize(im: Image.Image, box: int) -> Image.Image:
    scale = min(box / im.width, box / im.height)
    nw = max(1, int(round(im.width * scale)))
    nh = max(1, int(round(im.height * scale)))
    return im.resize((nw, nh), Image.Resampling.LANCZOS)


def make_square(im: Image.Image, size: int, pad_ratio: float = 0.02) -> Image.Image:
    render = max(size * 4, 512)
    canvas = Image.new("RGBA", (render, render), (0, 0, 0, 0))
    inner = max(1, int(render * (1 - pad_ratio * 2)))
    fitted = contain_resize(im, inner)
    x = (render - fitted.width) // 2
    y = (render - fitted.height) // 2
    canvas.paste(fitted, (x, y), fitted)
    if render != size:
        canvas = canvas.resize((size, size), Image.Resampling.LANCZOS)
    return canvas


def write_png_ico(path: Path, images: dict[int, Image.Image]) -> None:
    sizes = sorted(images)
    entries: list[tuple[int, bytes]] = []
    for size in sizes:
        buf = BytesIO()
        images[size].save(buf, format="PNG", optimize=True)
        entries.append((size, buf.getvalue()))

    offset = 6 + 16 * len(entries)
    header = struct.pack("<HHH", 0, 1, len(entries))
    directory = bytearray()
    blobs = bytearray()
    for size, blob in entries:
        w = 0 if size >= 256 else size
        h = 0 if size >= 256 else size
        directory += struct.pack("<BBBBHHII", w, h, 0, 0, 1, 32, len(blob), offset)
        blobs += blob
        offset += len(blob)
    path.write_bytes(header + directory + blobs)


def resolve_taskbar_src() -> Path:
    for path in TASKBAR_CANDIDATES:
        if path.exists():
            return path
    raise FileNotFoundError(
        "pocketmind-logo-transparent-v3.png not found. "
        "Copy it to D:\\downs\\pocketmind-logo-transparent-v3.png"
    )


def main() -> None:
    if not INAPP_SRC.exists():
        print("missing in-app logo:", INAPP_SRC, file=sys.stderr)
        sys.exit(1)
    try:
        taskbar_src = resolve_taskbar_src()
    except FileNotFoundError as err:
        print(err, file=sys.stderr)
        sys.exit(1)

    # Keep a stable copy under src/assets for rebuilds.
    assets_taskbar = ASSETS / "pocketmind-logo-transparent-v3.png"
    if taskbar_src.resolve() != assets_taskbar.resolve():
        ASSETS.mkdir(parents=True, exist_ok=True)
        assets_taskbar.write_bytes(taskbar_src.read_bytes())
        taskbar_src = assets_taskbar

    inapp = load_source(INAPP_SRC)
    taskbar = load_source(taskbar_src)
    print("in-app source", inapp.size, INAPP_SRC.name)
    print("taskbar source", taskbar.size, taskbar_src.name)

    # In-app sidebar mark only (original / previous logo)
    mark = make_square(inapp, 128, pad_ratio=0.0)
    for path in (ASSETS / "pocketmind-logo-mark.png", PUBLIC / "pocketmind-logo-mark.png"):
        path.parent.mkdir(parents=True, exist_ok=True)
        mark.save(path)

    # Taskbar / window chrome icons from sharp logo only
    png32 = make_square(taskbar, 32)
    png128 = make_square(taskbar, 128)
    png256 = make_square(taskbar, 256)
    png32.save(ICONS / "32x32.png")
    png128.save(ICONS / "128x128.png")
    png256.save(ICONS / "128x128@2x.png")
    png256.save(ICONS / "icon.png")
    make_square(taskbar, 512).save(ICONS / "app-icon-master.png")

    ico_images = {
        size: make_square(taskbar, size)
        for size in (16, 20, 24, 32, 40, 48, 64, 128, 256)
    }
    write_png_ico(ICONS / "icon.ico", ico_images)

    for size in (16, 32, 48, 128):
        print(f"taskbar {size}x{size}: bbox={ico_images[size].getbbox()}")
    print("in-app mark bytes", (PUBLIC / "pocketmind-logo-mark.png").stat().st_size)
    print("icon.ico bytes", (ICONS / "icon.ico").stat().st_size)


if __name__ == "__main__":
    main()
