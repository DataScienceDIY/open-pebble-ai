#!/usr/bin/env python3
"""Generate the 720x320 marketing banner for the Rebble appstore listing.

Writes appstore/banner.png. Style: dark gradient background, Pebble Time 2
silhouette on the left, two chat bubbles on the right (user blue / AI orange)
mirroring the in-app look, "Open Pebble AI" wordmark across the top, tagline
at the bottom.
"""
import os
import sys

from PIL import Image, ImageDraw, ImageFont

W, H = 720, 320
OUT = os.path.join(os.path.dirname(__file__), "..", "appstore", "banner.png")

BG_TOP = (24, 26, 36)
BG_BOTTOM = (12, 14, 22)
TITLE_FG = (255, 255, 255)
TAGLINE_FG = (180, 188, 210)
WATCH_BODY = (40, 44, 56)
WATCH_BEZEL = (90, 96, 112)
WATCH_BUTTON = (170, 175, 190)
SCREEN_BG = (255, 255, 255)
USER_BUBBLE = (40, 110, 220)
AI_BUBBLE = (240, 145, 30)
BUBBLE_TEXT = (255, 255, 255)


def find_font(candidates, size):
    for path in candidates:
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def gradient_bg(im):
    px = im.load()
    for y in range(H):
        t = y / (H - 1)
        r = int(BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t)
        g = int(BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t)
        b = int(BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t)
        for x in range(W):
            px[x, y] = (r, g, b)


def draw_watch(d, cx, cy, scale=1.0):
    body_w = int(170 * scale)
    body_h = int(210 * scale)
    body_r = int(28 * scale)
    bezel = int(8 * scale)
    screen_w = body_w - bezel * 2
    screen_h = int(body_h * 0.62)
    screen_top = cy - body_h // 2 + bezel + int(30 * scale)

    x0 = cx - body_w // 2
    y0 = cy - body_h // 2
    d.rounded_rectangle((x0, y0, x0 + body_w, y0 + body_h),
                        radius=body_r, fill=WATCH_BODY, outline=WATCH_BEZEL,
                        width=2)

    sx = cx - screen_w // 2
    d.rounded_rectangle((sx, screen_top, sx + screen_w, screen_top + screen_h),
                        radius=int(6 * scale), fill=SCREEN_BG)

    # Two tiny chat bubbles on the watch screen for instant recognition.
    bx_pad = int(6 * scale)
    bub_h = int(18 * scale)
    bub_w_user = int(screen_w * 0.55)
    bub_w_ai = int(screen_w * 0.60)
    bub_r = int(6 * scale)

    user_x1 = sx + screen_w - bx_pad
    user_x0 = user_x1 - bub_w_user
    user_y0 = screen_top + bx_pad
    d.rounded_rectangle((user_x0, user_y0, user_x1, user_y0 + bub_h),
                        radius=bub_r, fill=USER_BUBBLE)

    ai_x0 = sx + bx_pad
    ai_x1 = ai_x0 + bub_w_ai
    ai_y0 = user_y0 + bub_h + int(6 * scale)
    d.rounded_rectangle((ai_x0, ai_y0, ai_x1, ai_y0 + bub_h),
                        radius=bub_r, fill=AI_BUBBLE)

    # Right-side SELECT button hint
    btn_x = x0 + body_w
    btn_y = cy - int(8 * scale)
    d.rounded_rectangle((btn_x - 2, btn_y, btn_x + int(8 * scale),
                         btn_y + int(20 * scale)),
                        radius=2, fill=WATCH_BUTTON)


def draw_bubble(d, x, y, w, h, fill, radius=18, tail_side=None):
    d.rounded_rectangle((x, y, x + w, y + h), radius=radius, fill=fill)
    if tail_side == "right":
        # small tail on bottom-right
        d.polygon([(x + w - 14, y + h - 2), (x + w + 4, y + h + 10),
                   (x + w - 4, y + h - 12)], fill=fill)
    elif tail_side == "left":
        d.polygon([(x + 14, y + h - 2), (x - 4, y + h + 10),
                   (x + 4, y + h - 12)], fill=fill)


def main():
    sans = ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
            "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
            "/Library/Fonts/Arial Bold.ttf"]
    sans_reg = ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
                "/usr/share/fonts/TTF/DejaVuSans.ttf",
                "/Library/Fonts/Arial.ttf"]
    f_title = find_font(sans, 56)
    f_tag = find_font(sans_reg, 22)
    f_bub = find_font(sans_reg, 22)

    im = Image.new("RGB", (W, H))
    gradient_bg(im)
    d = ImageDraw.Draw(im)

    # Watch on the left, vertically centered.
    draw_watch(d, cx=140, cy=H // 2 + 6, scale=1.0)

    # Two chat bubbles on the right, mirroring in-app layout.
    right_x = 280
    right_w = 400
    # User bubble (blue, right-aligned, tail on right side)
    user_text = "Write a haiku about clouds."
    bub_w = right_w
    bub_h = 56
    bub_y = 110
    bub_x = right_x + (right_w - bub_w)
    draw_bubble(d, bub_x, bub_y, bub_w, bub_h, USER_BUBBLE, radius=18,
                tail_side="right")
    tb = d.textbbox((0, 0), user_text, font=f_bub)
    d.text((bub_x + (bub_w - (tb[2] - tb[0])) // 2,
            bub_y + (bub_h - (tb[3] - tb[1])) // 2 - 4),
           user_text, font=f_bub, fill=BUBBLE_TEXT)

    # AI bubble (orange, left-aligned, tail on left side)
    ai_text = "White wisps drift aloft,"
    ai_w = right_w - 60
    ai_h = 56
    ai_y = bub_y + bub_h + 28
    ai_x = right_x
    draw_bubble(d, ai_x, ai_y, ai_w, ai_h, AI_BUBBLE, radius=18,
                tail_side="left")
    tb = d.textbbox((0, 0), ai_text, font=f_bub)
    d.text((ai_x + (ai_w - (tb[2] - tb[0])) // 2,
            ai_y + (ai_h - (tb[3] - tb[1])) // 2 - 4),
           ai_text, font=f_bub, fill=BUBBLE_TEXT)

    # Tagline along the bottom
    tag = "Self-hosted LLM on your wrist"
    bbox = d.textbbox((0, 0), tag, font=f_tag)
    tw = bbox[2] - bbox[0]
    d.text(((W - tw) // 2, H - 42), tag, font=f_tag, fill=TAGLINE_FG)

    # Title across the top, slightly indented from the left edge of the
    # right-hand content area.
    title = "Open Pebble AI"
    bbox = d.textbbox((0, 0), title, font=f_title)
    tw = bbox[2] - bbox[0]
    d.text((W - tw - 40, 28), title, font=f_title, fill=TITLE_FG)

    out = os.path.abspath(OUT)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    im.save(out, "PNG", optimize=True)
    print("wrote", out, im.size)


if __name__ == "__main__":
    sys.exit(main())
