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
    exactly.
  * "Active" is every on-orbit PAYLOAD that does not fall into a named group;
    everything else (rocket bodies, debris, unknown) becomes "Debris".
"""
import argparse
import csv
from copy import deepcopy
import json
import logging
import pathlib

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

# The only two items associated with space stations that should be displayed;
# everything else co-orbiting with a station is filtered as clutter (see below).
# These strings must match the space-track OBJECT_NAME exactly.
station_whitelist = ["ISS (ZARYA)", "CSS (TIANHE)"]

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
    if rec["name"] in station_whitelist:
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


def classify(rec: dict) -> str:
    """Return the group name a catalog record belongs to."""
    name = rec["name"]
    if name in station_whitelist:
        return "Space Stations"
    # Only payloads belong to the named groups; rocket bodies, debris and
    # unknown objects (even if their name matches a constellation) go to Debris.
    if rec["object_type"] != "PAYLOAD":
        return "Debris"
    upper = name.upper()
    for group_name, tokens in NAME_PATTERNS.items():
        if any(tok in upper for tok in tokens):
            return group_name
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
            add_satellite(rec, classify(rec))
    logger.debug(f"Filtered {filtered} station-associated objects")


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
