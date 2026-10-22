#!/usr/bin/env python3
"""Makes the in-between sizes of the globe's day and night textures.

The satellite viewer starts with the 2048 x 1024 textures and loads larger ones only when the
screen or the zoom level needs them (Earth.updateDetail in src/earth.js). The steps are
2048 -> 4096 -> 8192 wide, so a high-DPI screen at the default view gets the 4096 textures
instead of the 8192 ones: a quarter of the decoding and GPU upload, and well under half the
download. This writes static/BlueMarble_4096x2048.avif and static/BlackMarble_4096x2048.avif
from the 8192 x 4096 files, or from other sources given on the command line (better, if you
still have the uncompressed originals, since that avoids compressing the images twice).

Needs Pillow 11.3 or later, whose wheels can read and write AVIF:
    pip install "pillow>=11.3"
    python scripts/make_earth_texture_sizes.py
    python scripts/make_earth_texture_sizes.py --blue path/to/bluemarble.tif --black path/to/blackmarble.tif
"""
import argparse
import pathlib

from PIL import Image, features

STATIC = pathlib.Path(__file__).resolve().parent.parent / "static"

# AVIF quality for the outputs. At 60 the 4096 textures come out within about a decibel (PSNR)
# of the existing 2048 ones, measured against a Lanczos reduction of the 8192 ones.
QUALITY = 60


def make_size(source: pathlib.Path, name: str, width: int) -> None:
    out = STATIC / f"{name}_{width}x{width // 2}.avif"
    with Image.open(source) as image:
        image = image.convert("RGB").resize((width, width // 2), Image.Resampling.LANCZOS)
        image.save(out, "AVIF", quality=QUALITY, speed=4, subsampling="4:2:0")
    print(f"wrote {out} ({out.stat().st_size / 1024:.0f} KiB)")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--blue", type=pathlib.Path, default=STATIC / "BlueMarble_8192x4096.avif",
                        help="source of the day texture (default: the 8192 x 4096 AVIF)")
    parser.add_argument("--black", type=pathlib.Path, default=STATIC / "BlackMarble_8192x4096.avif",
                        help="source of the night texture (default: the 8192 x 4096 AVIF)")
    parser.add_argument("--width", type=int, default=4096, help="width of the textures to make")
    args = parser.parse_args()

    if not features.check("avif"):
        raise SystemExit("This Pillow can't write AVIF; install Pillow 11.3 or later")
    make_size(args.blue, "BlueMarble", args.width)
    make_size(args.black, "BlackMarble", args.width)


if __name__ == "__main__":
    main()
