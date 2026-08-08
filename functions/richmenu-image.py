#!/usr/bin/env python3
"""リッチメニュー画像を生成する（2500x843 = コンパクトサイズ）。

使い方:
  python3 functions/richmenu-image.py OUT.png [店名]
    共有OA用（店名なし） : python3 functions/richmenu-image.py /tmp/rm.png
    拠点OA用（店名あり） : python3 functions/richmenu-image.py /tmp/rm.png "GROOM HAUS"

⚠ 共有OA（複数テナントが相乗り）には店名を入れないこと。
  特定の店名を入れると、他店の顧客にその名前が表示されてしまう。
  拠点OA（テナント専用）だけ店名を入れてよい。

⚠ LINEのリッチメニュー画像はサイズが厳密。2500x1686(大) か 2500x843(小) のみ。
  ボタンを増やす場合は set-richmenu.mjs のエリア定義とこの画像の分割位置を
  必ず合わせること（ズレると押した場所と遷移先が食い違う）。
"""
import sys
from PIL import Image, ImageDraw, ImageFont

W, H = 2500, 843
TOP = (51, 159, 163)      # 背景グラデ 上
BOTTOM = (26, 110, 114)   # 背景グラデ 下
WHITE = (255, 255, 255)
PILL_TEXT = (31, 122, 126)
JP_BOLD = "/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc"
JP_REG = "/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc"
EN = "/System/Library/Fonts/Supplemental/Futura.ttc"


def gradient(img: Image.Image) -> None:
    d = ImageDraw.Draw(img)
    for y in range(H):
        t = y / (H - 1)
        d.line(
            [(0, y), (W, y)],
            fill=tuple(round(TOP[i] + (BOTTOM[i] - TOP[i]) * t) for i in range(3)),
        )


def paw(img: Image.Image, cx: int, cy: int, scale: float) -> None:
    """肉球の透かし。背景より少し明るい白を薄く重ねる。"""
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    ink = (255, 255, 255, 28)
    pad_r = int(120 * scale)
    d.ellipse((cx - pad_r, cy - pad_r + int(40 * scale), cx + pad_r, cy + pad_r + int(40 * scale)), fill=ink)
    toe = int(52 * scale)
    for dx, dy in ((-150, -110), (-55, -170), (55, -170), (150, -110)):
        x, y = cx + int(dx * scale), cy + int(dy * scale)
        d.ellipse((x - toe, y - toe, x + toe, y + toe), fill=ink)
    img.alpha_composite(layer)


def centered(d, text, font, cx, top, fill):
    b = d.textbbox((0, 0), text, font=font)
    d.text((cx - (b[2] - b[0]) / 2 - b[0], top - b[1]), text, font=font, fill=fill)


def main() -> None:
    out = sys.argv[1] if len(sys.argv) > 1 else "/tmp/richmenu.png"
    store = sys.argv[2] if len(sys.argv) > 2 else ""

    img = Image.new("RGBA", (W, H), TOP)
    gradient(img)
    paw(img, 330, 330, 1.0)

    d = ImageDraw.Draw(img)
    cx = W // 2

    if store:
        # 拠点OA: 店名 ＋ 用途
        # index=0 は Futura Medium（正体）。1 は Italic なので使わない
        centered(d, store, ImageFont.truetype(EN, 96, index=0), cx, 150, WHITE)
        centered(d, "トリミングのご予約", ImageFont.truetype(JP_BOLD, 132), cx, 270, WHITE)
        pill_top = 530
    else:
        # 共有OA: 用途のみ（店名は入れない）
        centered(d, "トリミングのご予約", ImageFont.truetype(JP_BOLD, 148), cx, 210, WHITE)
        pill_top = 490

    # 白いピルボタン
    pw, ph = 1120, 175
    x0, y0 = cx - pw // 2, pill_top
    d.rounded_rectangle((x0, y0, x0 + pw, y0 + ph), radius=ph // 2, fill=WHITE)
    label = "予約する  ＞"
    f = ImageFont.truetype(JP_BOLD, 74)
    b = d.textbbox((0, 0), label, font=f)
    d.text(
        (cx - (b[2] - b[0]) / 2 - b[0], y0 + ph / 2 - (b[3] - b[1]) / 2 - b[1]),
        label,
        font=f,
        fill=PILL_TEXT,
    )

    img.convert("RGB").save(out, "PNG", optimize=True)
    print(f"{out} ({W}x{H}) store={store or '(なし=共有OA用)'}")


if __name__ == "__main__":
    main()
