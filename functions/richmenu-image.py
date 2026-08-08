#!/usr/bin/env python3
"""リッチメニュー画像を生成する（2500x843 = コンパクトサイズ）。

使い方:
  python3 functions/richmenu-image.py OUT.png "店舗名" [MARK.png]
    例) python3 functions/richmenu-image.py /tmp/rm.png "GROOM HAUS" ~/groom-site/public/logo-mark.png

⚠ LINEのリッチメニュー画像はサイズが厳密。2500x1686(大) か 2500x843(小) のみ。
  ここでは小(1段)を使う。ボタンを増やす場合は set-richmenu.mjs のエリア定義と
  この画像の分割位置を必ず合わせること（ズレると押した場所と遷移先が食い違う）。
"""
import sys
from PIL import Image, ImageDraw, ImageFont

W, H = 2500, 843
PAPER = (250, 248, 244)   # --color-paper
BRAND = (67, 57, 44)      # --color-brand-800
SUB = (133, 113, 79)      # --color-brand-500
JP_BOLD = "/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc"
JP_REG = "/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc"


def centered(d, text, font, cx, y, fill):
    b = d.textbbox((0, 0), text, font=font)
    d.text((cx - (b[2] - b[0]) / 2 - b[0], y), text, font=font, fill=fill)
    return b[3] - b[1]


def main() -> None:
    out = sys.argv[1] if len(sys.argv) > 1 else "/tmp/richmenu.png"
    store = sys.argv[2] if len(sys.argv) > 2 else "GROOM HAUS"
    mark_path = sys.argv[3] if len(sys.argv) > 3 else None

    img = Image.new("RGB", (W, H), PAPER)
    d = ImageDraw.Draw(img)

    # 上下に細い罫線（メニューとトーク画面の境目をはっきりさせる）
    d.rectangle((0, 0, W, 8), fill=BRAND)

    cx = W // 2
    # マーク（任意）。透過PNGを想定し、紙色の上に合成する
    if mark_path:
        try:
            mark = Image.open(mark_path).convert("RGBA")
            mh = 250
            mw = round(mark.width * mh / mark.height)
            mark = mark.resize((mw, mh), Image.LANCZOS)
            img.paste(mark, (cx - mw // 2, 110), mark)
        except Exception as e:  # 画像が無くても文字だけで成立させる
            print(f"mark skipped: {e}")

    f_main = ImageFont.truetype(JP_BOLD, 150)
    f_sub = ImageFont.truetype(JP_REG, 58)
    centered(d, "予約する", f_main, cx, 400, BRAND)
    centered(d, f"{store}　24時間受付", f_sub, cx, 610, SUB)

    img.save(out, "PNG", optimize=True)
    print(f"{out} ({img.size[0]}x{img.size[1]})")


if __name__ == "__main__":
    main()
