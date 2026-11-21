"""Draws the app icons (run: python3 tools/make-icons.py). Needs Pillow."""

from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "icons"
S = 2048  # draw large, then downscale for smooth edges


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def master(scale=1.0):
    img = Image.new("RGB", (S, S))
    top, bottom = (99, 102, 241), (67, 56, 202)
    px = ImageDraw.Draw(img)
    for y in range(S):
        px.line([(0, y), (S, y)], fill=lerp(top, bottom, y / S))
    d = ImageDraw.Draw(img, "RGBA")

    def sc(v):  # scale artwork around the centre (maskable icons need a safe zone)
        return S / 2 + (v - S / 2) * scale

    def box(x0, y0, x1, y1):
        return [sc(x0), sc(y0), sc(x1), sc(y1)]

    # calendar card with a soft shadow
    d.rounded_rectangle(box(470, 560, 1590, 1640), radius=150 * scale, fill=(20, 16, 80, 70))
    d.rounded_rectangle(box(450, 520, 1570, 1600), radius=150 * scale, fill=(255, 255, 255))
    d.rounded_rectangle(box(450, 520, 1570, 820), radius=150 * scale, fill=(199, 210, 254))
    d.rectangle(box(450, 700, 1570, 820), fill=(199, 210, 254))
    for x in (740, 1280):  # binder rings
        d.rounded_rectangle(box(x - 45, 420, x + 45, 640), radius=45 * scale, fill=(49, 46, 129))
    # day grid: two kids' colours
    colors = [(124, 58, 237), (226, 232, 240), (226, 232, 240), (226, 232, 240), (234, 88, 12), (226, 232, 240)]
    i = 0
    for row in range(2):
        for col in range(3):
            x0 = 580 + col * 300
            y0 = 930 + row * 290
            d.rounded_rectangle(box(x0, y0, x0 + 220, y0 + 210), radius=48 * scale, fill=colors[i])
            i += 1
    # clock badge
    cx, cy, r = 1560, 1560, 330
    d.ellipse(box(cx - r - 26, cy - r - 26, cx + r + 26, cy + r + 26), fill=(67, 56, 202))
    d.ellipse(box(cx - r, cy - r, cx + r, cy + r), fill=(251, 191, 36))
    d.ellipse(box(cx - r + 60, cy - r + 60, cx + r - 60, cy + r - 60), fill=(255, 251, 235))
    w = round(46 * scale)
    d.line([(sc(cx), sc(cy)), (sc(cx), sc(cy - 175))], fill=(49, 46, 129), width=w)
    d.line([(sc(cx), sc(cy)), (sc(cx + 130), sc(cy + 80))], fill=(49, 46, 129), width=w)
    d.ellipse(box(cx - 38, cy - 38, cx + 38, cy + 38), fill=(49, 46, 129))
    return img


def save(img, size, name):
    img.resize((size, size), Image.LANCZOS).save(OUT / name, optimize=True)


def main():
    OUT.mkdir(exist_ok=True)
    full = master(1.0)
    safe = master(0.78)  # keeps artwork inside the maskable safe zone
    save(full, 512, "icon-512.png")
    save(full, 192, "icon-192.png")
    save(full, 32, "favicon-32.png")
    save(safe, 180, "apple-touch-icon.png")
    save(safe, 512, "icon-maskable-512.png")
    print("icons written to", OUT)


if __name__ == "__main__":
    main()
