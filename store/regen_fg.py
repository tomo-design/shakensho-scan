from PIL import Image, ImageDraw, ImageFont, ImageFilter
import os
os.chdir(os.path.join(os.path.dirname(__file__), ".."))
W, H = 1024, 500
top = (20, 58, 110); bot = (38, 120, 190)
img = Image.new("RGB", (W, H)); px = img.load()
for y in range(H):
    t = y / H; row = tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(3))
    for x in range(W): px[x, y] = row
img = img.convert("RGBA")
# icon: crop off outer white ring, round-mask, soft shadow
ic = Image.open("icons/icon-512.png").convert("RGBA")
S = ic.width
inset = 14
ic2 = ic.crop((inset, inset, S - inset, S - inset))
s = ic2.width
mask = Image.new("L", (s, s), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.20), fill=255)
ic2.putalpha(mask)
sz = 360
ic2 = ic2.resize((sz, sz), Image.LANCZOS)
sh = Image.new("RGBA", (W, H), (0, 0, 0, 0))
shm = Image.new("L", (sz, sz), 0)
ImageDraw.Draw(shm).rounded_rectangle([0, 0, sz - 1, sz - 1], radius=int(sz * 0.20), fill=110)
ix, iy = 60, (H - sz) // 2
sh.paste((0, 0, 0, 110), (ix + 6, iy + 12), shm)
sh = sh.filter(ImageFilter.GaussianBlur(12))
img = Image.alpha_composite(img, sh)
img.paste(ic2, (ix, iy), ic2)
d = ImageDraw.Draw(img)
def font(sz, bold=True):
    names = ["C:/Windows/Fonts/meiryob.ttc", "C:/Windows/Fonts/YuGothB.ttc"] if bold else ["C:/Windows/Fonts/meiryo.ttc", "C:/Windows/Fonts/YuGothR.ttc"]
    for name in names:
        try: return ImageFont.truetype(name, sz)
        except Exception: pass
    return ImageFont.load_default()
tx = 470; MAXW = W - tx - 30
def fit(text, y, start, color, bold=True):
    ss = start
    while ss > 16 and d.textlength(text, font=font(ss, bold)) > MAXW: ss -= 2
    d.text((tx, y), text, font=font(ss, bold), fill=color)
fit("メカノAI", 150, 92, (255, 255, 255))
fit("車検証スキャン × AI整備サポート", 265, 34, (205, 228, 255))
fit("諸元・締付トルク・故障診断を現場で即表示", 322, 28, (182, 212, 246), False)
img.convert("RGB").save("store/feature-graphic-1024x500.png")
print("ok")
