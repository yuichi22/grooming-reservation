#!/usr/bin/env python3
"""リッチメニュー画像を生成する（2500x843 = コンパクトサイズ）。

使い方:
  python3 functions/richmenu-image.py OUT.png
    例) python3 functions/richmenu-image.py /tmp/rm.png

⚠ 店名やロゴは入れないこと。
  リッチメニューはそのOAのトーク画面内に出るため、画面上部に店名とアイコンが
  すでに表示されている。メニュー内で繰り返すと情報が重複するうえ、
  文字を小さくせざるを得ずボタンとして押しにくくなる。
  ここは「何ができるか」だけを大きく見せる。

⚠ LINEのリッチメニュー画像はサイズが厳密。2500x1686(大) か 2500x843(小) のみ。
  ボタンを増やす場合は set-richmenu.mjs のエリア定義とこの画像の分割位置を
  必ず合わせること（ズレると押した場所と遷移先が食い違う）。
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
    d.text((cx - (b[2] - b[0]) / 2 - b[0], y - b[1]), text, font=font, fill=fill)


def main() -> None:
    out = sys.argv[1] if len(sys.argv) > 1 else "/tmp/richmenu.png"

    img = Image.new("RGB", (W, H), PAPER)
    d = ImageDraw.Draw(img)

    # 上端の罫線。メニューとトーク画面の境目をはっきりさせる
    d.rectangle((0, 0, W, 8), fill=BRAND)

    cx = W // 2
    centered(d, "予約する", ImageFont.truetype(JP_BOLD, 230), cx, 270, BRAND)
    centered(d, "24時間受付", ImageFont.truetype(JP_REG, 76), cx, 580, SUB)

    img.save(out, "PNG", optimize=True)
    print(f"{out} ({img.size[0]}x{img.size[1]})")


if __name__ == "__main__":
    main()
