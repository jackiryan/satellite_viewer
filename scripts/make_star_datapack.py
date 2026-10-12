#!/usr/bin/env python3
"""
make_star_datapack.py
=====================

Regenerates the two star textures sampled by the skybox shaders:

  static/skybox/StarData_1024x1024_16bit.png   position + magnitude datapack
                                               (skySunFragment.glsl, skyFragment.glsl)
  static/skybox/2_Tmap8bit.png                 star colour texture (skyFragment.glsl only)

Both come from one placement pass, so each colour texel always belongs to the star
stored in the same datapack texel. Regenerate and replace them together.

The datapack part is a reconstruction of the lost pre-processing script, built by
decoding the committed texture and matching it against star catalogs. It reproduces
the committed texture pixel-for-pixel except for a few dozen texels where two stars of
identical magnitude collided and the original (unstable) sort placed them in the other
order. The colour texture is a new, corrected encoding (see below).

Where the stars come from
-------------------------
The committed texture was built from the HYG database (v3.5 or later), not from a
Simbad V < 7 query:

  * 117,467 stars = every HYG star with mag < 14 that has a B-V colour index, minus the
    Sun (row 0).
  * Sirius is stored as -1.44, its Hipparcos V magnitude (Simbad lists -1.46).
  * Stored sub-pixel offsets match HYG's J2000 positions to within one 16-bit step
    (about 0.03 arcsec) for 99.99% of stars.

HYG is distributed under CC BY-SA 4.0 by David Nash / astronexus.

Datapack layout (1024 x 1024, RGB, 16 bits per channel)
-------------------------------------------------------
Each star is projected onto the octahedral ("tetrahedral" in the shader) map:

    p   = (cos(dec) cos(ra), cos(dec) sin(ra), sin(dec))      # ICRS unit vector
    p'  = p / (|px| + |py| + |pz|)
    z>=0: (cx, cy) = (p'x, p'y)
    z< 0: (cx, cy) = (sign(p'x)(1-|p'y|), sign(p'y)(1-|p'x|))
    sx  = (cx + 1) / 2 * N          sy = (cy + 1) / 2 * N       # in pixels, 0..N

and written to the PNG at   row = ceil(sx) - 1,  column = ceil(sy) - 1
(top row of the file is row 0; the three.js loader flips it on upload).

    R = round((row + 0.5 - sx + 1.5) / 3 * 65535)   # pixel-centre-minus-star, in pixels
    G = round((col + 0.5 - sy + 1.5) / 3 * 65535)
    B = round((14 - V) / 15.46 * 65535)             # matches decodeMagnitude() in the shader

An all-zero texel means "no star". Stars are written brightest first; when a texel is
already taken, the star goes to the nearest free texel among its 8 neighbours, and its
offset (up to +/-1.5 px) still points back at its true position.

Colour texture layout (1024 x 1024, RGB, 8 bits per channel, same texels)
-------------------------------------------------------------------------
skyFragment.glsl renders   texel.rgb * starBrightness,   and skyboxcolor.js loads the
texture with no colour space, so each texel holds a *linear* sRGB colour that is
multiplied straight into the star's brightness. starBrightness comes from the V
magnitude, and the V band closely tracks visual luminance, so the colour must not
change a star's luminance, only its hue. Each texel is therefore:

    1. B-V -> temperature of the blackbody with that B-V colour (Ballesteros 2012):
           T = 4600 K * (1 / (0.92 (B-V) + 1.7) + 1 / (0.92 (B-V) + 0.62))
       with B-V clamped to [-0.4, 2.0] (about 21,700 K to 3,170 K). This covers 99.7%
       of the stars; the redder ones (mostly carbon stars) get the reddest colour.
    2. Planck spectrum at T -> CIE 1931 XYZ -> linear sRGB (D65 white, so a ~6,500 K
       star is white and the Sun is faintly warm).
    3. Scaled so its luminance (Y = 0.2126 R + 0.7152 G + 0.0722 B) is exactly
       COLOR_LUMINANCE = 0.5, then rounded to 8 bits.

Constant luminance needs some channels above 1 (a 21,700 K star's blue channel is 1.88x
its luminance), so the texture stores colours at half luminance. To render the coloured
stars as bright as skySunFragment.glsl renders white ones, multiply uBrightnessScale in
skyboxcolor.js by 1 / COLOR_LUMINANCE = 2.

Requirements:  pip install numpy pandas pypng
Usage:         python make_star_datapack.py                        # downloads HYG v3.8
               python make_star_datapack.py --catalog hyg_v38.csv.gz
               python make_star_datapack.py --compare static/skybox/StarData_1024x1024_16bit.png
"""

import argparse
import sys

import numpy as np
import pandas as pd
import png  # pypng: writes 16-bit RGB PNGs (Pillow cannot)

HYG_URL = "https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/v3/hyg_v38.csv.gz"

# Must match decodeMagnitude() in the fragment shaders.
MAG_BRIGHTEST = -1.46  # maxMag  -> encodes to 1.0
MAG_FAINTEST = 14.0    # minMag  -> encodes to 0.0 (0.0 also means "empty texel")

# Offsets are stored as (offset + 1.5) / 3, i.e. a +/-1.5 pixel range.
OFFSET_RANGE = 3.0

# Neighbour search order used when a star's own texel is taken.
NEIGHBOURS = np.array([[-1, 0], [1, 0], [0, -1], [0, 1],
                       [-1, -1], [1, -1], [-1, 1], [1, 1]])

# Colour texture.
BV_MIN, BV_MAX = -0.4, 2.0   # B-V clamp before converting to temperature
COLOR_LUMINANCE = 0.5        # luminance every stored colour is scaled to

# CIE XYZ -> linear sRGB (IEC 61966-2-1, D65).
XYZ_TO_LINEAR_SRGB = np.array([[3.2404542, -1.5371385, -0.4985314],
                               [-0.9692660, 1.8760108, 0.0415560],
                               [0.0556434, -0.2040259, 1.0572252]])


# --------------------------------------------------------------------------- stars

def load_stars(catalog, mag_limit):
    """Read HYG and return (ra_deg, dec_deg, vmag, b_minus_v) sorted brightest first."""
    df = pd.read_csv(catalog, usecols=["id", "ra", "dec", "mag", "ci"])
    df = df[(df["id"] != 0)            # row 0 is the Sun
            & df["ci"].notna()         # B-V needed for the colour texture
            & (df["mag"] < mag_limit)]
    # A stable sort keeps the output identical on every machine. The original used
    # pandas' default (unstable) sort, which only changes the order of equal-magnitude
    # stars and therefore which of two colliding stars keeps the home texel.
    df = df.sort_values("mag", kind="stable")
    return (df["ra"].to_numpy() * 15.0, df["dec"].to_numpy(),
            df["mag"].to_numpy(), df["ci"].to_numpy())


def octahedral_pixels(ra_deg, dec_deg, size):
    """Project RA/Dec onto the octahedral map; return continuous pixel coords (sx, sy)."""
    ra, dec = np.deg2rad(ra_deg), np.deg2rad(dec_deg)
    p = np.stack([np.cos(dec) * np.cos(ra), np.cos(dec) * np.sin(ra), np.sin(dec)], axis=1)
    p /= np.abs(p).sum(axis=1, keepdims=True)
    upper = p[:, 2] >= 0
    cx = np.where(upper, p[:, 0], np.sign(p[:, 0]) * (1 - np.abs(p[:, 1])))
    cy = np.where(upper, p[:, 1], np.sign(p[:, 1]) * (1 - np.abs(p[:, 0])))
    return (cx + 1) / 2 * size, (cy + 1) / 2 * size


def place_stars(sx, sy, size):
    """Give each star (sorted brightest first) its own texel.

    Returns per-star (rows, cols), with -1 for a star that found no free texel, plus
    the number of stars moved to a neighbouring texel.
    """
    taken = np.zeros((size, size), dtype=bool)
    rows = np.ceil(sx).astype(int) - 1
    cols = np.ceil(sy).astype(int) - 1
    relocated = 0

    for i in range(len(sx)):
        r, c = rows[i], cols[i]
        if taken[r, c]:
            alt = NEIGHBOURS + (r, c)
            # Simple wrap at the texture edge, as in the original (never triggers with HYG).
            alt[alt >= size] -= size
            alt[alt < 0] += size
            # Kept from the original for bit-compatibility: the distance is measured to
            # (index - 0.5) rather than to the texel centre (index + 0.5). It only affects
            # which free neighbour is chosen; the stored offset is still exact.
            dist = np.hypot(sx[i] - (alt[:, 0] - 0.5), sy[i] - (alt[:, 1] - 0.5))
            for k in np.argsort(dist):
                if not taken[alt[k, 0], alt[k, 1]]:
                    r, c = alt[k]
                    relocated += 1
                    break
            else:
                rows[i] = cols[i] = -1
                continue
        rows[i], cols[i] = r, c
        taken[r, c] = True

    return rows, cols, relocated


# ------------------------------------------------------------------------ datapack

def encode_offset(off):
    return np.clip(np.rint((off + OFFSET_RANGE / 2) / OFFSET_RANGE * 65535), 0, 65535)


def encode_magnitude(vmag):
    enc = (MAG_FAINTEST - vmag) / (MAG_FAINTEST - MAG_BRIGHTEST)
    return np.clip(np.rint(enc * 65535), 0, 65535)


def build_datapack(rows, cols, sx, sy, vmag, size):
    img = np.zeros((size, size, 3), dtype=np.uint16)
    ok = rows >= 0
    r, c = rows[ok], cols[ok]
    img[r, c, 0] = encode_offset(r + 0.5 - sx[ok])
    img[r, c, 1] = encode_offset(c + 0.5 - sy[ok])
    img[r, c, 2] = encode_magnitude(vmag[ok])
    return img


# -------------------------------------------------------------------------- colour

def bv_to_temperature(bv):
    """Temperature (K) of the blackbody with this B-V colour (Ballesteros 2012)."""
    bv = np.clip(bv, BV_MIN, BV_MAX)
    return 4600.0 * (1.0 / (0.92 * bv + 1.7) + 1.0 / (0.92 * bv + 0.62))


def _lobe(lam, mu, s_left, s_right):
    s = np.where(lam < mu, s_left, s_right)
    return np.exp(-0.5 * ((lam - mu) / s) ** 2)


def cie1931_cmf(lam):
    """CIE 1931 2-degree colour-matching functions, multi-lobe Gaussian fit from
    Wyman, Sloan & Shirley (2013), JCGT 2(2). Within ~1% of the tabulated CIE data for
    blackbody colours, which is below 8-bit resolution here."""
    x = (1.056 * _lobe(lam, 599.8, 37.9, 31.0) + 0.362 * _lobe(lam, 442.0, 16.0, 26.7)
         - 0.065 * _lobe(lam, 501.1, 20.4, 26.2))
    y = 0.821 * _lobe(lam, 568.8, 46.9, 40.5) + 0.286 * _lobe(lam, 530.9, 16.3, 31.1)
    z = 1.217 * _lobe(lam, 437.0, 11.8, 36.0) + 0.681 * _lobe(lam, 459.0, 26.0, 13.8)
    return np.stack([x, y, z], axis=1)


def blackbody_linear_srgb(temps):
    """Linear sRGB colour of a blackbody at each temperature, scaled to luminance 1."""
    lam_nm = np.arange(360.0, 831.0, 1.0)
    lam = lam_nm * 1e-9
    c2 = 1.4387768775e-2  # second radiation constant hc/k, m K
    spectrum = 1.0 / (lam[None, :] ** 5 * np.expm1(c2 / (lam[None, :] * temps[:, None])))
    xyz = spectrum @ cie1931_cmf(lam_nm)
    rgb = xyz @ XYZ_TO_LINEAR_SRGB.T
    return rgb / xyz[:, 1:2]


def star_colors(bv):
    """8-bit linear sRGB per star at luminance COLOR_LUMINANCE."""
    # Compute once per distinct B-V value (the catalog has ~2,500), not per star.
    uniq, inverse = np.unique(np.clip(bv, BV_MIN, BV_MAX), return_inverse=True)
    rgb = blackbody_linear_srgb(bv_to_temperature(uniq)) * COLOR_LUMINANCE
    if rgb.max() > 1.0:
        sys.exit(f"COLOR_LUMINANCE {COLOR_LUMINANCE} is too high for B-V range "
                 f"[{BV_MIN}, {BV_MAX}]: a channel reaches {rgb.max():.3f}")
    return np.rint(np.clip(rgb, 0.0, 1.0) * 255).astype(np.uint8)[inverse]


def build_color_texture(rows, cols, bv, size):
    img = np.zeros((size, size, 3), dtype=np.uint8)
    ok = rows >= 0
    img[rows[ok], cols[ok]] = star_colors(bv[ok])
    return img


# ------------------------------------------------------------------------------ io

def read_png(path):
    reader = png.Reader(filename=path)
    width, height, rows, info = reader.asDirect()
    dtype = np.uint16 if info["bitdepth"] > 8 else np.uint8
    return np.vstack([np.asarray(row, dtype=dtype) for row in rows]).reshape(height, width, info["planes"])


def write_png(path, img):
    h, w, _ = img.shape
    bitdepth = 16 if img.dtype == np.uint16 else 8
    with open(path, "wb") as f:
        png.Writer(width=w, height=h, greyscale=False, bitdepth=bitdepth).write(f, img.reshape(h, w * 3))


def compare(img, ref_path):
    ref = read_png(ref_path)[..., :3]
    if ref.shape != img.shape:
        print(f"compare: shape differs ({ref.shape} vs {img.shape})")
        return
    differ = np.any(ref != img, axis=2)
    print(f"compare: {np.count_nonzero(ref[..., 2])} stars in reference, "
          f"{np.count_nonzero(img[..., 2])} generated, {differ.sum()} texels differ")


def main():
    ap = argparse.ArgumentParser(
        description="Build the star datapack and star colour textures used by the skybox shaders.")
    ap.add_argument("--catalog", default=HYG_URL,
                    help="HYG v3.x CSV (.csv or .csv.gz), local path or URL (default: HYG v3.8 on GitHub)")
    ap.add_argument("--out", default="StarData_1024x1024_16bit.png", help="datapack PNG path")
    ap.add_argument("--color-out", default="2_Tmap8bit.png",
                    help='colour texture PNG path; pass "" to skip it')
    ap.add_argument("--size", type=int, default=1024,
                    help="texture width/height; must equal uPixelSize in skybox.js (default 1024)")
    ap.add_argument("--mag-limit", type=float, default=MAG_FAINTEST,
                    help=f"keep stars with V < this (max {MAG_FAINTEST}, the shader's minMag)")
    ap.add_argument("--compare", metavar="PNG", help="report how many texels differ from an existing datapack")
    args = ap.parse_args()

    if args.mag_limit > MAG_FAINTEST:
        sys.exit(f"--mag-limit cannot exceed {MAG_FAINTEST} without changing minMag in the shaders")

    ra, dec, vmag, bv = load_stars(args.catalog, args.mag_limit)
    if vmag.min() < MAG_BRIGHTEST:
        print(f"warning: brightest star V={vmag.min()} is brighter than the shader's maxMag "
              f"({MAG_BRIGHTEST}) and will be clipped")
    sx, sy = octahedral_pixels(ra, dec, args.size)
    rows, cols, relocated = place_stars(sx, sy, args.size)
    dropped = np.count_nonzero(rows < 0)

    datapack = build_datapack(rows, cols, sx, sy, vmag, args.size)
    write_png(args.out, datapack)
    print(f"{len(vmag)} stars (V {vmag.min():.2f} to {vmag.max():.2f}); "
          f"{relocated} moved to a neighbouring texel, {dropped} dropped -> {args.out}")

    if args.color_out:
        write_png(args.color_out, build_color_texture(rows, cols, bv, args.size))
        print(f"colours from B-V clamped to [{BV_MIN}, {BV_MAX}] "
              f"({bv_to_temperature(BV_MAX):.0f} K to {bv_to_temperature(BV_MIN):.0f} K) "
              f"-> {args.color_out}; set uBrightnessScale in skyboxcolor.js to "
              f"{1 / COLOR_LUMINANCE:g}x the white shader's value")

    if args.compare:
        compare(datapack, args.compare)


if __name__ == "__main__":
    main()