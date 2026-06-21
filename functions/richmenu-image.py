import sys, glob
from PIL import Image, ImageDraw, ImageFont

out = sys.argv[1] if len(sys.argv) > 1 else "/tmp/richmenu.png"
W, H = 2500, 843

# --- font 解決（日本語対応の太め優先） ---
candidates = [
    "/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc",
    "/System/Library/Fonts/ヒラギノ角ゴシック W5.ttc",
    "/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
]
candidates += sorted(glob.glob("/System/Library/Fonts/ヒラギノ角ゴシック*.ttc"))
fontpath = next((c for c in candidates if glob.os.path.exists(c)), None)
if not fontpath:
    raise SystemExit("no JP font found")

def font(sz):
    try:
        return ImageFont.truetype(fontpath, sz)
    except Exception:
        return ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Unicode.ttf", sz)

# --- 背景: ティールの縦グラデーション ---
top, bot = (52, 160, 164), (26, 110, 114)  # #34A0A4 -> #1A6E72
img = Image.new("RGB", (W, H), bot)
d = ImageDraw.Draw(img)
for y in range(H):
    t = y / H
    d.line([(0, y), (W, y)], fill=tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(3)))

# --- 肉球アイコン（白・半透明）左側に装飾 ---
paw = Image.new("RGBA", (W, H), (0, 0, 0, 0))
pd = ImageDraw.Draw(paw)
cx, cy, c = 360, 430, (255, 255, 255, 38)
pd.ellipse([cx - 120, cy - 60, cx + 120, cy + 150], fill=c)            # pad
for dx, dy in [(-150, -150), (-50, -210), (60, -210), (160, -150)]:    # toes
    pd.ellipse([cx + dx - 55, cy + dy - 55, cx + dx + 55, cy + dy + 55], fill=c)
img = Image.alpha_composite(img.convert("RGBA"), paw).convert("RGB")
d = ImageDraw.Draw(img)

def center(text, y, fnt, fill):
    bb = d.textbbox((0, 0), text, font=fnt)
    d.text(((W - (bb[2] - bb[0])) / 2 - bb[0], y), text, font=fnt, fill=fill)

# --- テキスト ---
center("GROOM HAUS", 110, font(110), (255, 255, 255))
center("トリミングのご予約", 250, font(150), (255, 255, 255))

# 白い丸角ボタン
bw, bh, by = 1100, 180, 540
bx = (W - bw) // 2
d.rounded_rectangle([bx, by, bx + bw, by + bh], radius=90, fill=(255, 255, 255))
bf = font(96)
bb = d.textbbox((0, 0), "予約する ＞", font=bf)
d.text(((W - (bb[2] - bb[0])) / 2 - bb[0], by + (bh - (bb[3] - bb[1])) / 2 - bb[1]),
       "予約する ＞", font=bf, fill=(26, 110, 114))

img.save(out, "PNG", optimize=True)
import os
print(f"saved {out}  {img.size}  {os.path.getsize(out)} bytes  font={fontpath}")
