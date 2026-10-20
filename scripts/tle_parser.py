#!/usr/bin/env python3
"""Sorts a space-track GP catalog export into per-group JSON files.

Group membership is derived entirely from the space-track data itself -- object
name patterns, orbital parameters (for GLONASS) and object type -- so no
CelesTrak requests are made. The parser reads a single CSV export of the `gp`
class (see update_satellites.sh for the exact query) and writes one JSON file
per group plus an index.json, matching the previous CelesTrak-based output.

Caveats of the space-track-only approach:
  * space-track has no notion of "operational" satellites, so the GPS and
    GLONASS groups include every on-orbit satellite of that constellation, not
    just CelesTrak's operational subset.
  * "Weather" and "Science" are curated multi-operator groups on CelesTrak with
    no single defining attribute; here they are approximated by a best-effort
    union of well-known object-name patterns and will not match CelesTrak
    exactly. Science also takes the NASA A-Train and other civil-agency
    sun-synchronous Earth-observation satellites, by NORAD id or, for series
    that keep growing (Sentinel, Landsat, Gaofen, ...), by name plus a
    sun-synchronous orbit check.
  * Space stations are matched by NORAD id, since their names differ between
    catalogs.
  * "Active" is every on-orbit PAYLOAD that does not fall into a named group;
    everything else (rocket bodies, debris, unknown) becomes "Debris".
"""
import argparse
import csv
from copy import deepcopy
import json
import logging
import math
import pathlib
import re

logger = logging.getLogger(__name__)

satellite_groups = {
    "GLONASS": {
        "gpName": "glo-ops",
        "country": "ru",
        "baseColor": "#d62718",
        "count": 0,
        "entities": {},
    },
    "Galileo": {
        "gpName": "galileo",
        "country": "eu",
        "baseColor": "#a294e5",
        "count": 0,
        "entities": {},
    },
    "GPS": {
        "gpName": "gps-ops",
        "country": "us",
        "baseColor": "#d9269d",
        "count": 0,
        "entities": {},
    },
    "Beidou": {
        "gpName": "beidou",
        "country": "cn",
        "baseColor": "#f6d500",
        "count": 0,
        "entities": {},
    },
    "Molniya": {
        "gpName": "molniya",
        "country": "ru",
        "baseColor": "#ed333f",
        "count": 0,
        "entities": {},
    },
    "Planet Labs": {
        "gpName": "planet",
        "country": "planet",
        "baseColor": "#029da4",
        "count": 0,
        "entities": {},
    },
    "Space Stations": {
        "gpName": "stations",
        "baseColor": "#f72091",
        "count": 0,
        "entities": {},
    },
    "Science": {
        "gpName": "science",
        "baseColor": "#4b5320",
        "count": 0,
        "entities": {},
    },
    "OneWeb": {
        "gpName": "oneweb",
        "country": "gb",
        "baseColor": "#fa1b1b",
        "count": 0,
        "entities": {},
    },
    "Weather": {
        "gpName": "weather",
        "baseColor": "#1bf91b",
        "count": 0,
        "entities": {},
    },
    "Starlink": {
        "gpName": "starlink",
        "country": "us",
        "baseColor": "#6b6b6b",
        "count": 0,
        "entities": {},
    },
    "Telesat": {
        "gpName": "telesat",
        "country": "ca",
        "baseColor": "#ffe203",
        "count": 0,
        "entities": {},
    },
    "Active": {"gpName": "active", "count": 0, "baseColor": "#1b1bf9", "entities": {}},
    "Debris": {"count": 0, "entities": {}},
}

special_colors = {}

# The only objects associated with space stations that should be displayed, by NORAD
# catalog id, with the name shown in the viewer. Everything else co-orbiting with a
# station is filtered as clutter (see below). Matched by id rather than name because
# catalogs name the stations differently: space-track calls Tianhe "CSS (TIANHE-1)",
# while CelesTrak calls it "CSS (TIANHE)".
STATION_NORAD_IDS = {
    25544: "ISS (ZARYA)",
    48274: "CSS (TIANHE)",
}

# Objects deployed from / docking with a station clutter the view around it.
# We drop them entirely (keeping only the whitelist above). ISS-deployed objects
# share the 1998-067 international designator; docked/visiting vehicles are
# matched by name for both the ISS and the Chinese Space Station.
STATION_CLUTTER_DESIGNATORS = ("1998-067",)
STATION_CLUTTER_NAMES = [
    "PROGRESS",
    "CYGNUS",
    "DRAGON",
    "SOYUZ",
    "TIANZHOU",
    "SHENZHOU",
    "WENTIAN",   # CSS modules docked to Tianhe
    "MENGTIAN",
    "STARLINER",
    "CST-100",
]

# OBJECT_NAME substrings (matched case-insensitively) that place a PAYLOAD into a
# named group. Ordered by priority: the first group whose token matches wins.
# GLONASS is handled separately because its members are named "COSMOS ..." which
# is ambiguous, so it is disambiguated by orbit instead of name.
NAME_PATTERNS = {
    "Starlink": ["STARLINK"],
    "OneWeb": ["ONEWEB"],
    "Beidou": ["BEIDOU", "COMPASS"],
    "Galileo": ["GALILEO"],
    "GPS": ["NAVSTAR"],
    "Molniya": ["MOLNIYA"],
    "Planet Labs": ["FLOCK", "SKYSAT", "SUPERDOVE", "DOVE", "PELICAN", "TANAGER"],
    "Telesat": ["TELESAT"],
    # Weather and Science are curated mixes on CelesTrak; these unions are a
    # best-effort approximation and will not match CelesTrak exactly.
    "Weather": [
        "NOAA",
        "GOES",
        "METEOSAT",
        "METOP",
        "FENGYUN",
        "FY-",
        "DMSP",
        "HIMAWARI",
        "METEOR",
        "SENTINEL-3",
        "INSAT",
        "ELEKTRO",
        "ARKTIKA",
        "GEO-KOMPSAT",
        "GK-2",
        "MTG",
        "GOMS",
    ],
    "Science": [
        "HUBBLE",
        "SWIFT",
        "FERMI",
        "FGST",
        "XMM-NEWTON",
        "SWARM",
        "HINODE",
        "IXPE",
        "CALIPSO",
        "CLOUDSAT",
        "NUSTAR",
        "INTEGRAL",
        "CHEOPS",
        "TIMED",
        "GEOTAIL",
        "THEMIS",
    ],
}

# Jackie note: This is so overengineered..... they weren't kidding about Opus 5.5
# Sun-synchronous Earth-observation satellites of the major civil space agencies, added
# to Science by NORAD catalog id (names vary between catalogs, and short names like
# AQUA or TERRA are too generic to match on). Ids checked against keeptrack.space.
SCIENCE_NORAD_IDS = {
    # NASA A-Train: OCO-2, GCOM-W1 (JAXA) and Aura fly in formation; Aqua left in 2022
    # but is still operating. CloudSat and CALIPSO are matched by name above.
    40059: "OCO 2",
    38337: "GCOM-W1 (SHIZUKU)",
    28376: "AURA",
    27424: "AQUA",
    # NASA, with USGS and ISRO partners (Landsat is matched by name below)
    25994: "TERRA",
    40376: "SMAP",
    58928: "PACE",
    65053: "NISAR",
    # ESA (Sentinels are matched by name below; Sentinel-3 is in Weather)
    36036: "SMOS",
    59908: "EARTHCARE",
    63772: "BIOMASS",
    # JAXA
    43065: "GCOM-C (SHIKISAI)",
    39766: "ALOS-2 (DAICHI-2)",
    60182: "ALOS-4 (DAICHI-4)",
    33492: "GOSAT (IBUKI)",
    43672: "GOSAT-2 (IBUKI-2)",
    64694: "GOSAT-GW (IBUKI-GW)",
    # ISRO
    37387: "RESOURCESAT-2",
    41877: "RESOURCESAT-2A",
    51656: "EOS-04",
    54361: "EOS-06 (OCEANSAT-3)",
    # CSA: the RADARSAT Constellation Mission and RADARSAT-2
    44322: "RCM-1",
    44324: "RCM-2",
    44323: "RCM-3",
    32382: "RADARSAT-2",
}

# Earth-observation series that keep adding satellites, matched by name and added to
# Science only when the orbit is sun-synchronous (which leaves out, for example, the
# geostationary Gaofen-4 and Gaofen-13). Names are compared with everything but
# letters and digits removed, so "SENTINEL-2A", "SENTINEL 2A" and "SENTINEL2A" match.
SUN_SYNCHRONOUS_SCIENCE_FAMILIES = [
    "SENTINEL1",   # ESA C-band radar
    "SENTINEL2",   # ESA multispectral imagers
    "SENTINEL5P",  # ESA atmospheric composition
    "LANDSAT",     # NASA/USGS
    "GAOFEN",      # CNSA China High-resolution Earth Observation System
    "CBERS",       # CNSA/INPE China-Brazil Earth Resources Satellites
    "KANOPUSV",    # Roscosmos
    "RESURSP",     # Roscosmos
]
# Allowed difference between a satellite's inclination and the sun-synchronous
# inclination for its altitude. Operational sun-synchronous satellites are within about
# 0.1 deg; this leaves room for older satellites that no longer maintain their orbit.
SUN_SYNCHRONOUS_TOLERANCE_DEG = 1.0

EARTH_MU = 398600.4418           # km^3/s^2
EARTH_EQUATORIAL_RADIUS = 6378.137  # km
EARTH_J2 = 1.08262668e-3
# Nodal precession that keeps the orbit fixed relative to the Sun: 360 deg per year
SUN_SYNCHRONOUS_PRECESSION = 2 * math.pi / (365.2422 * 86400)  # rad/s

# Operational GLONASS satellites sit in ~64.8-degree semi-synchronous MEO
# (mean motion ~2.13 rev/day). This separates them from the many other Russian
# "COSMOS" satellites, including the ~63.4-degree Molniya-orbit ones (mean
# motion ~2.0 rev/day).
GLONASS_INCLINATION = (63.0, 66.0)
GLONASS_MEAN_MOTION = (2.10, 2.20)


def _to_float(value: str | None) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def is_station_clutter(rec: dict) -> bool:
    """True if the object is station-associated clutter that should be dropped."""
    if rec["norad_id"] in STATION_NORAD_IDS:
        return False
    if rec["object_id"].startswith(STATION_CLUTTER_DESIGNATORS):
        return True
    upper = rec["name"].upper()
    return any(tok in upper for tok in STATION_CLUTTER_NAMES)


def is_glonass_orbit(rec: dict) -> bool:
    inc, mm = rec["inclination"], rec["mean_motion"]
    if inc is None or mm is None:
        return False
    return (
        GLONASS_INCLINATION[0] <= inc <= GLONASS_INCLINATION[1]
        and GLONASS_MEAN_MOTION[0] <= mm <= GLONASS_MEAN_MOTION[1]
    )


def sun_synchronous_inclination(mean_motion: float) -> float | None:
    """Inclination (deg) that makes a circular orbit with this mean motion (rev/day)
    sun-synchronous, or None if no inclination can (orbits above ~6,000 km altitude)."""
    n = mean_motion * 2 * math.pi / 86400  # rad/s
    a = (EARTH_MU / (n * n)) ** (1 / 3)
    # J2 nodal precession: dOmega/dt = -1.5 n J2 (R/a)^2 cos(i), for a circular orbit
    cos_i = -SUN_SYNCHRONOUS_PRECESSION / (1.5 * n * EARTH_J2 * (EARTH_EQUATORIAL_RADIUS / a) ** 2)
    if cos_i < -1:
        return None
    return math.degrees(math.acos(cos_i))


def is_sun_synchronous(rec: dict) -> bool:
    inc, mm = rec["inclination"], rec["mean_motion"]
    if inc is None or not mm:
        return False
    target = sun_synchronous_inclination(mm)
    return target is not None and abs(inc - target) <= SUN_SYNCHRONOUS_TOLERANCE_DEG


def is_sun_synchronous_science(rec: dict) -> bool:
    """True for a member of SUN_SYNCHRONOUS_SCIENCE_FAMILIES in a sun-synchronous orbit."""
    compact = re.sub(r"[^A-Z0-9]", "", rec["name"].upper())
    return any(family in compact for family in SUN_SYNCHRONOUS_SCIENCE_FAMILIES) and is_sun_synchronous(rec)


def classify(rec: dict) -> str:
    """Return the group name a catalog record belongs to."""
    if rec["norad_id"] in STATION_NORAD_IDS:
        return "Space Stations"
    # Only payloads belong to the named groups; rocket bodies, debris and
    # unknown objects (even if their name matches a constellation) go to Debris.
    if rec["object_type"] != "PAYLOAD":
        return "Debris"
    if rec["norad_id"] in SCIENCE_NORAD_IDS:
        return "Science"
    upper = rec["name"].upper()
    for group_name, tokens in NAME_PATTERNS.items():
        if any(tok in upper for tok in tokens):
            return group_name
    if is_sun_synchronous_science(rec):
        return "Science"
    if "COSMOS" in upper and is_glonass_orbit(rec):
        return "GLONASS"
    return "Active"


def add_satellite(rec: dict, group: str) -> None:
    entities = satellite_groups[group]["entities"]
    name = rec["name"]
    # JSON object keys must be unique; disambiguate name collisions (common in
    # the Debris group) with the NORAD id.
    if name in entities:
        name = f"{name} ({rec['norad_id']})"
    logger.debug(f"Adding {name} to the group {group}")
    satellite_groups[group]["count"] += 1
    entities[name] = {
        "noradId": rec["norad_id"],
        "tleLine1": rec["line1"],
        "tleLine2": rec["line2"],
    }
    entity_color = special_colors.get(name)
    if entity_color is not None:
        logger.debug(
            f"Setting the special entity color {entity_color} for this satellite"
        )
        entities[name]["entityColor"] = entity_color


def parse_catalog(catalog: pathlib.Path) -> None:
    """Read the space-track GP CSV export and sort every object into a group."""
    filtered = 0
    found_ids = set()
    with catalog.open(newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        required = {"OBJECT_NAME", "NORAD_CAT_ID", "TLE_LINE1", "TLE_LINE2"}
        missing = required - set(reader.fieldnames or [])
        if missing:
            raise ValueError(
                f"Catalog CSV is missing required columns: {sorted(missing)}"
            )
        for row in reader:
            name = (row.get("OBJECT_NAME") or "").strip()
            line1 = (row.get("TLE_LINE1") or "").strip()
            line2 = (row.get("TLE_LINE2") or "").strip()
            if not (name and line1 and line2):
                continue
            try:
                norad_id = int(row["NORAD_CAT_ID"])
            except (KeyError, ValueError):
                logger.debug(f"Skipping {name}: missing/invalid NORAD id")
                continue
            rec = {
                "name": name,
                "line1": line1,
                "line2": line2,
                "norad_id": norad_id,
                "object_type": (row.get("OBJECT_TYPE") or "").strip().upper(),
                "object_id": (row.get("OBJECT_ID") or "").strip(),
                "inclination": _to_float(row.get("INCLINATION")),
                "mean_motion": _to_float(row.get("MEAN_MOTION")),
            }
            if is_station_clutter(rec):
                logger.debug(f"Filtering station-associated object {name}")
                filtered += 1
                continue
            # show the stations under a consistent name whatever the catalog calls them
            if norad_id in STATION_NORAD_IDS:
                rec["name"] = STATION_NORAD_IDS[norad_id]
            found_ids.add(norad_id)
            add_satellite(rec, classify(rec))
    logger.debug(f"Filtered {filtered} station-associated objects")
    for norad_id, name in STATION_NORAD_IDS.items():
        if norad_id not in found_ids:
            logger.warning(f"Space station {name} ({norad_id}) is not in the catalog")
    for norad_id, name in SCIENCE_NORAD_IDS.items():
        if norad_id not in found_ids:
            logger.info(f"Science satellite {name} ({norad_id}) is not in the catalog")


def write_group_files(workdir: pathlib.Path) -> None:
    # Write index.json which will be used to find uris to other group json files
    index_file = workdir / "index.json"
    group_index = deepcopy(satellite_groups)
    for k, v in satellite_groups.items():
        gp_name = v.get("gpName", "debris")
        outfile = workdir / f"{gp_name}.json"
        outfile.write_text(json.dumps(v, indent=2))
        # Replace the entities tag in the group_index with the uri to the group json
        group_index[k]["entities"] = f"/groups/{gp_name}.json"
    index_file.write_text(json.dumps(group_index, indent=2))


def write_one_file(catalog: pathlib.Path, workdir: pathlib.Path) -> None:
    outfile = workdir / f"{catalog.stem}.json"
    outfile.write_text(json.dumps(satellite_groups, indent=2))


def setup_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "catalog",
        type=pathlib.Path,
        metavar="FILE",
        help="space-track gp catalog export in CSV format",
    )
    parser.add_argument(
        "-w", "--workdir", type=pathlib.Path, help="working directory, default is cwd"
    )
    parser.add_argument(
        "--one-file",
        action="store_true",
        help="Store output to a single file instead of one per group",
    )
    return parser


def main() -> None:
    logging.basicConfig(
        level=logging.DEBUG,
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
        filename="getSatellites_service.log",
        filemode="w",
    )
    parser = setup_parser()
    args = parser.parse_args()
    workdir = args.workdir or pathlib.Path.cwd()

    parse_catalog(args.catalog)
    for name, group in satellite_groups.items():
        logger.debug(f"{name}: {group['count']} entities")
    try:
        if args.one_file:
            write_one_file(args.catalog, workdir)
        else:
            write_group_files(workdir)
    except Exception as e:
        logging.error(f"Error writing satellite database: {e}")
        raise e


if __name__ == "__main__":
    main()
