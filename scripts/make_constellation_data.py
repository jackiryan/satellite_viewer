#!/usr/bin/env python3
"""
make_constellation_data.py
==========================

Builds static/skybox/constellations.json, the data behind the constellation highlights
on the star map page (src/constellations.js).

Sources
-------
* Constellation figures, names and IAU boundaries: Stellarium's "modern_iau" sky culture
  (skycultures/modern_iau/index.json, CC BY-SA 4.0, Stellarium's team). Its figures are the
  ones Alan MacRobert drew for the IAU and Sky & Telescope, the same figures as NASA SVS's
  Deep Star Maps 2020 constellation overlay. The boundaries are the IAU's (Delporte 1930),
  in B1875 coordinates.
* Star positions and magnitudes: HYG v3.8 (CC BY-SA 4.0, David Nash / astronexus), the
  catalog the star datapack (make_star_datapack.py) was built from. Taking the line
  endpoints from the same catalog puts them exactly on the stars the shader draws.

Output format
-------------
    stars           { "<HIP>": [ra_deg, dec_deg, vmag] }      J2000 / ICRS
    constellations  [ { abbr, name, meaning, segments: [[HIP, HIP], ...] } ]
                    name is the Latin name, meaning its English translation (or null)
    boundaries      { epoch: "B1875", fromJ2000: 3x3 row-major matrix,
                      edges: [[ra_start_deg, ra_end_deg, dec_deg, abbr], ...] }

Every IAU boundary runs along a line of constant RA or constant Dec in B1875 coordinates.
"edges" lists the constant-Dec ones, sorted by Dec, each with the constellation directly
south of it. To find the constellation containing a J2000 direction:

    1. Rotate it to B1875 with fromJ2000 (precession) and take its RA and Dec.
    2. Find the first edge, in list order, with dec_deg > Dec whose RA range contains RA.
       The RA range runs east from ra_start_deg to ra_end_deg, and may wrap through 0.
    3. The answer is that edge's constellation, or Ursa Minor if no edge is above
       (Ursa Minor contains the north celestial pole).

This is the method of Roman (1987, PASP 99, 695). The script checks it against the
constellation HYG lists for each of its stars.

Requirements:  pip install numpy pandas
Usage:         python make_constellation_data.py            # downloads both sources
               python make_constellation_data.py --skyculture index.json --catalog hyg_v38.csv.gz
"""

import argparse
import json
import sys
import urllib.request
from functools import lru_cache

import numpy as np
import pandas as pd

# Pinned so the output only changes when this script does.
SKYCULTURE_URL = ("https://raw.githubusercontent.com/Stellarium/stellarium/"
                  "dc5679c9723685585196c4d6ecd7ffd33da59ecd/skycultures/modern_iau/index.json")
HYG_URL = "https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/v3/hyg_v38.csv.gz"

# Figure stars that HYG lists without a Hipparcos number, mapped to their HD number.
HIP_TO_HD = {
    55203: 98231,  # xi UMa (Alula Australis), a close double; HYG keeps it under HD only
}

# Corrections to the English names in the sky culture.
MEANING_FIXES = {
    "Bernice's Hair": "Berenice's Hair",
    "Mariner Compass": "Mariner's Compass",
}

# Constellation regions that the boundary data splits in two.
REGION_ALIASES = {"SER1": "Ser", "SER2": "Ser"}

# Julian date of the B1875.0 epoch, the epoch of the IAU boundaries.
JD_B1875 = 2405889.258550475


# ------------------------------------------------------------------------- sources

def load_json(source):
    if source.startswith(("http://", "https://")):
        with urllib.request.urlopen(source) as response:
            return json.load(response)
    with open(source, encoding="utf-8") as f:
        return json.load(f)


def load_catalog(catalog):
    df = pd.read_csv(catalog, usecols=["id", "hip", "hd", "ra", "dec", "mag", "ci", "con"])
    return df[df["id"] != 0]  # row 0 is the Sun


def star_lookup(df):
    """Return a function mapping a HIP number to (ra_deg, dec_deg, vmag)."""
    by_hip = df[df["hip"].notna()].set_index(df["hip"].dropna().astype(int))
    by_hd = df[df["hd"].notna()].set_index(df["hd"].dropna().astype(int))

    def lookup(hip):
        if hip in by_hip.index:
            row = by_hip.loc[hip]
        elif hip in HIP_TO_HD:
            row = by_hd.loc[HIP_TO_HD[hip]]
        else:
            sys.exit(f"HIP {hip} is not in the catalog; add it to HIP_TO_HD")
        return round(float(row["ra"]) * 15.0, 5), round(float(row["dec"]), 5), round(float(row["mag"]), 2)

    return lookup


# ------------------------------------------------------------------ constellations

def build_constellations(skyculture, lookup):
    stars, constellations = {}, []
    for entry in skyculture["constellations"]:
        abbr = entry["id"].split()[-1]
        names = entry["common_name"]
        name = names["native"]
        meaning = names.get("english")
        if meaning == name:
            meaning = names.get("byname")
        meaning = MEANING_FIXES.get(meaning, meaning)

        # The polylines retrace some segments (Ursa Major goes 50801 -> 50372 -> 50801);
        # a translucent segment drawn twice would look brighter, so keep each one once.
        segments, seen = [], set()
        for polyline in entry["lines"]:
            for a, b in zip(polyline, polyline[1:]):
                key = (min(a, b), max(a, b))
                if a == b or key in seen:
                    continue
                seen.add(key)
                segments.append([a, b])
                for hip in (a, b):
                    if str(hip) not in stars:
                        stars[str(hip)] = list(lookup(hip))

        constellations.append({"abbr": abbr, "name": name, "meaning": meaning, "segments": segments})
    return stars, constellations


# ---------------------------------------------------------------------- boundaries

def precession_matrix(jd):
    """IAU 1976 precession (Lieske et al. 1977) from J2000 to the mean equator of jd."""
    t = (jd - 2451545.0) / 36525.0
    arcsec = np.pi / (180.0 * 3600.0)
    zeta = (2306.2181 * t + 0.30188 * t ** 2 + 0.017998 * t ** 3) * arcsec
    z = (2306.2181 * t + 1.09468 * t ** 2 + 0.018203 * t ** 3) * arcsec
    theta = (2004.3109 * t - 0.42665 * t ** 2 - 0.041833 * t ** 3) * arcsec

    def rot_z(a):
        c, s = np.cos(a), np.sin(a)
        return np.array([[c, s, 0.0], [-s, c, 0.0], [0.0, 0.0, 1.0]])

    def rot_y(a):
        c, s = np.cos(a), np.sin(a)
        return np.array([[c, 0.0, -s], [0.0, 1.0, 0.0], [s, 0.0, c]])

    return rot_z(-z) @ rot_y(theta) @ rot_z(-zeta)


def parse_hours(text):
    h, m, s = text.split(":")
    return (int(h) + int(m) / 60 + float(s) / 3600) * 15.0


def parse_degrees(text):
    sign = -1.0 if text.startswith("-") else 1.0
    d, m, s = text.lstrip("+-").split(":")
    return sign * (int(d) + int(m) / 60 + float(s) / 3600)


def in_ra_range(ra, start, end):
    """True if ra lies east of start and west of end (the range may wrap through 0)."""
    if start < end:
        return start <= ra < end
    return ra >= start or ra < end


def build_boundaries(skyculture, abbrs):
    """Keep the constant-Dec edges and work out which constellation is south of each."""
    if skyculture.get("edges_epoch") != "B1875":
        sys.exit(f"expected B1875 boundaries, got {skyculture.get('edges_epoch')}")
    to_abbr = {a.upper(): a for a in abbrs}
    to_abbr.update(REGION_ALIASES)

    parallels = []
    for line in skyculture["edges"]:
        # "001:002 P+ 22:52:00 +52:30:00 23:20:00 +52:30:00 AND CAS"
        f = line.split()
        if f[1][0] != "P":
            continue  # constant-RA edges are not needed for the lookup
        if f[1] != "P+":
            sys.exit(f"unexpected edge direction: {line}")
        start, dec, end = parse_hours(f[2]), parse_degrees(f[3]), parse_hours(f[4])
        parallels.append((start, end, dec, to_abbr[f[6]], to_abbr[f[7]]))
    parallels.sort(key=lambda e: e[2])

    def edge_above(ra, dec):
        for i, (start, end, edge_dec, _, _) in enumerate(parallels):
            if edge_dec > dec and in_ra_range(ra, start, end):
                return i
        return None

    @lru_cache(maxsize=None)
    def south_of(i):
        # Walk north from the middle of the edge: the first edge above has this edge's
        # northern neighbour on its south side. With no edge above, that is Ursa Minor.
        start, end, dec, a, b = parallels[i]
        mid = (start + ((end - start) % 360.0) / 2.0) % 360.0
        above = edge_above(mid, dec)
        north = "UMi" if above is None else south_of(above)
        if north not in (a, b):
            sys.exit(f"inconsistent boundary near RA {mid:.3f}, Dec {dec:.3f}: "
                     f"{north} is north of an edge between {a} and {b}")
        return b if north == a else a

    edges = [[round(start, 4), round(end, 4), round(dec, 4), south_of(i)]
             for i, (start, end, dec, _, _) in enumerate(parallels)]
    return edges, edge_above


def check_boundaries(df, edges, edge_above, matrix):
    """Compare the lookup with the constellation HYG lists for each star."""
    stars = df[df["con"].notna()]
    ra, dec = np.radians(stars["ra"].to_numpy() * 15.0), np.radians(stars["dec"].to_numpy())
    v = np.stack([np.cos(dec) * np.cos(ra), np.cos(dec) * np.sin(ra), np.sin(dec)])
    x, y, z = matrix @ v
    ra_b = np.degrees(np.arctan2(y, x)) % 360.0
    dec_b = np.degrees(np.arcsin(np.clip(z, -1.0, 1.0)))

    found = []
    for r, d in zip(ra_b, dec_b):
        i = edge_above(r, d)
        found.append("UMi" if i is None else edges[i][3])
    found = np.array(found)
    expected = stars["con"].to_numpy()
    wrong = found != expected
    print(f"boundary check: {len(found) - wrong.sum()} of {len(found)} HYG stars land in the "
          f"constellation HYG lists ({wrong.sum()} differ)")
    for (r, d), got, want in list(zip(zip(ra_b[wrong], dec_b[wrong]), found[wrong], expected[wrong]))[:10]:
        print(f"    B1875 RA {r:9.4f}  Dec {d:+8.4f}: lookup {got}, HYG {want}")
    return wrong.sum()


# ---------------------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description="Build the constellation data for the star map page.")
    ap.add_argument("--skyculture", default=SKYCULTURE_URL,
                    help="Stellarium modern_iau index.json, local path or URL (default: pinned GitHub copy)")
    ap.add_argument("--catalog", default=HYG_URL,
                    help="HYG v3.x CSV (.csv or .csv.gz), local path or URL (default: HYG v3.8 on GitHub)")
    ap.add_argument("--out", default="static/skybox/constellations.json", help="output JSON path")
    args = ap.parse_args()

    skyculture = load_json(args.skyculture)
    df = load_catalog(args.catalog)

    stars, constellations = build_constellations(skyculture, star_lookup(df))
    matrix = precession_matrix(JD_B1875)
    edges, edge_above = build_boundaries(skyculture, [c["abbr"] for c in constellations])
    mismatches = check_boundaries(df, edges, edge_above, matrix)
    if mismatches > 0.001 * len(df):
        sys.exit("too many boundary mismatches; refusing to write the output")

    data = {
        "about": ("Constellation figures, names and IAU boundaries from Stellarium's modern_iau "
                  "sky culture (CC BY-SA 4.0, Stellarium's team; figures by Alan MacRobert for "
                  "the IAU and Sky & Telescope). Star positions from the HYG database v3.8 "
                  "(CC BY-SA 4.0, David Nash / astronexus). Built by scripts/make_constellation_data.py."),
        "license": "CC BY-SA 4.0",
        "stars": stars,
        "constellations": constellations,
        "boundaries": {
            "epoch": "B1875",
            "fromJ2000": [round(float(x), 12) for x in matrix.ravel()],
            "edges": edges,
        },
    }
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")

    n_segments = sum(len(c["segments"]) for c in constellations)
    print(f"{len(constellations)} constellations, {n_segments} segments between {len(stars)} stars, "
          f"{len(edges)} boundary edges -> {args.out}")


if __name__ == "__main__":
    main()
