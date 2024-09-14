#!/usr/bin/env python3
"""processes a pre-fetched tle file and sorts it into JSON files"""
import argparse
from copy import deepcopy
import json
import logging
import pathlib
import requests

logger = logging.getLogger(__name__)

satellite_groups = {
    "GLONASS": {
        "gpName": "glo-ops",
        "country": "ru",
        "baseColor": "#d62718",
        "count": 0,
        "entities": {}
    },
    "Galileo": {
        "gpName": "galileo",
        "country": "eu",
        "baseColor": "#a294e5",
        "count": 0,
        "entities": {}
    },
    "GPS": {
        "gpName": "gps-ops",
        "country": "us",
        "baseColor": "#d9269d",
        "count": 0,
        "entities": {}
    },
    "Beidou": {
        "gpName": "beidou",
        "country": "cn",
        "baseColor": "#f6d500",
        "count": 0,
        "entities": {}
    },
    "Molniya": {
        "gpName": "molniya",
        "country": "ru",
        "baseColor": "#ed333f",
        "count": 0,
        "entities": {}
    },
    "Space Stations": {
        "gpName": "stations",
        "baseColor": "#f72091",
        "count": 0,
        "entities": {}
    },
    "Science": {
        "gpName": "science",
        "baseColor": "#4b5320",
        "count": 0,
        "entities": {}
    },
    "OneWeb": {
        "gpName": "oneweb",
        "country": "gb",
        "baseColor": "#fa1b1b",
        "count": 0,
        "entities": {}
    },
    "Weather": {
        "gpName": "weather",
        "baseColor": "#1bf91b",
        "count": 0,
        "entities": {}
    },
    "Starlink": {
        "gpName": "starlink",
        "country": "us",
        "baseColor": "#6b6b6b",
        "count": 0,
        "entities": {}
    },
    "Telesat": {
        "gpName": "telesat",
        "country": "ca",
        "baseColor": "#ffe203",
        "count": 0,
        "entities": {}
    },
    "Active": {
        "gpName": "active",
        "count": 0,
        "baseColor": "#1b1bf9",
        "entities": {}
    },
    "Debris": {
        "count": 0,
        "entities": {}
    }

}

special_colors = {
    
}

# A blacklist of active satellites that will get filtered from the "Other" group
# This helps prevent the many tracked items around space stations from clipping on top of each other
# The list is built primarily when processing the Space Station gp
filter_items = [
]

# The only two items associated with space stations that should be displayed
station_whitelist = ["ISS (ZARYA)", "CSS (TIANHE)"]

def remove_blanks(
        lines: list[str]
) -> list[str]:
    """remove blank lines from text responses"""
    return [line for line in lines if line.strip()]

def find_group(
        norad_id: int,
        group_data: dict[str, list[int]]
) -> str:
    """find the satellite group that a satellite belongs to based off its NORAD ID"""
    return next((k for k, v in group_data.items() if norad_id in v), "Active")

def get_norad_id(
        tle_line: str
) -> int:
    """get the NORAD ID of a spacecraft with hardcoded string indices from the TLE spec"""
    return int(tle_line[2:7])

def add_satellite(
        name: str,
        tle_line1: str,
        tle_line2: str,
        norad_id: int,
        group: str
) -> None:
    logger.debug(f"Adding {name} to the group {group}")
    entities = satellite_groups[group]["entities"]
    satellite_groups[group]["count"] += 1
    entities[name] = {
        "noradId": norad_id,
        "tleLine1": tle_line1,
        "tleLine2": tle_line2
    }
    entity_color = special_colors.get(name)
    if entity_color is not None:
        logger.debug(f"Setting the special entity color {entity_color} for this satellite")
        entities[name]["entityColor"] = entity_color

def download_content(
    url: str    
) -> bytes:
    try:
        response = requests.get(url)
        
        if response.status_code == 200:
            return response.content
        else:
            logger.error(f"Failed to download file at {url}. Status code: {response.status_code}")
            return bytes()
    except Exception as e:
        logger.error(f"A Python error occurred when downloading: {e}")
        raise e

def download_group_files() -> dict[str, list[int]]:
    group_data = {}
    for group_name, group in satellite_groups.items():
        gp_name = group.get("gpName")
        if gp_name is None:
            continue
        if gp_name == "molniya":
            handle_molniya()
            continue
        if gp_name == "stations":
            handle_stations()
        gp_url = f"https://celestrak.org/NORAD/elements/gp.php?GROUP={gp_name}&FORMAT=csv"
        logger.debug(f"Getting group data for {gp_name}...")
        gp_data = download_content(gp_url)
        gp_lines = remove_blanks(gp_data.decode("utf-8").splitlines())
        try:
            id_ndx = gp_lines[0].split(",").index("NORAD_CAT_ID")
        except ValueError as e:
            logging.error(f"Failed to find NORAD_CAT_ID in group csv")
            raise e
        group_data[group_name] = [int(gp_sat.split(",")[id_ndx]) for gp_sat in gp_lines[1:]]
        logger.debug(f"Found {len(gp_lines)} entries for the {gp_name} group.")
    return group_data

def handle_molniya():
    gp_name = "molniya"
    gp_url = f"https://celestrak.org/NORAD/elements/gp.php?GROUP={gp_name}&FORMAT=tle"
    logger.debug(f"Getting group data for {gp_name}...")
    gp_data = download_content(gp_url)
    gp_lines = remove_blanks(gp_data.decode("utf-8").splitlines())
    parse_tle_lines(gp_lines, hc_group="Molniya")

def handle_stations():
    gp_name = "stations"
    gp_url = f"https://celestrak.org/NORAD/elements/gp.php?GROUP={gp_name}&FORMAT=tle"
    logger.debug(f"Getting group data for {gp_name}...")
    gp_data = download_content(gp_url)
    gp_lines = remove_blanks(gp_data.decode("utf-8").splitlines())
    parse_tle_lines(gp_lines, hc_group="Space Stations")


def parse_tle_lines(
        tle_lines: list[str],
        group_data: dict[str, list[int]] | None = None,
        hc_group: str | None = None
) -> None:
    for line_ndx, line in enumerate(tle_lines):
        match line_ndx % 3:
            case 0:
                sat_name = line.strip()
            case 1:
                tle_line1 = line.strip()
                norad_id = get_norad_id(tle_line1)
                if group_data:
                    group = find_group(norad_id, group_data)
                else:
                    group = hc_group
            case 2:
                tle_line2 = line.strip()
                if hc_group == "Space Stations" and sat_name not in station_whitelist:
                    filter_items.append(norad_id)
                # Short circuit if an item is on the blacklist (mostly station parts)
                if norad_id in filter_items:
                    continue
                add_satellite(
                    sat_name,
                    tle_line1,
                    tle_line2,
                    norad_id,
                    group
                )
                filter_items.append(norad_id)


def parse_other_sats(
        cat_lines: list[str],
        group_data: dict[str, list[int]] | None = None,
        hc_group: str | None = None
) -> None:
    entityMap: dict[str, str] = satellite_groups["Debris"]["entities"]
    for line_ndx, line in enumerate(cat_lines):
        match line_ndx % 3:
            case 0:
                sat_name = line.strip()
            case 1:
                tle_line1 = line.strip()
                norad_id = get_norad_id(tle_line1)
                group = hc_group or "Debris"
            case 2:
                tle_line2 = line.strip()
                if norad_id in filter_items:
                    logging.debug(f"Skipping {sat_name} as it has already been added")
                    continue
                if sat_name in entityMap.keys():
                    sat_name = f"{sat_name} ({str(norad_id)})"
                add_satellite(
                    sat_name,
                    tle_line1,
                    tle_line2,
                    norad_id,
                    group
                )


def parse_tle(
        infile: pathlib.Path,
        catalog: pathlib.Path,
        group_data: dict[str, list[int]],
        workdir: pathlib.Path | None,
        one_file: bool,
        is_dev: bool
) -> None:
    lines = infile.read_text().splitlines()
    workdir = workdir or pathlib.Path.cwd()
    tle_lines = remove_blanks(lines)
    parse_tle_lines(tle_lines, group_data)
    catalog_lines = catalog.read_text().splitlines()
    parse_other_sats(catalog_lines, group_data)
    try:
        if one_file:
            write_one_file(infile, workdir)
        else:
            write_group_files(workdir, is_dev)
    except Exception as e:
        logging.error(f"Error writing satellite database: {e}")
        logging.debug("Satellite database is as follows:")
        logging.debug(satellite_groups)
        raise e

def write_group_files(
        workdir: pathlib.Path,
        is_dev: bool
) -> None:
    # Write index.json which will be used to find uris to other group json files
    index_file = workdir / "index.json"
    group_index = deepcopy(satellite_groups)
    for k, v in satellite_groups.items():
        gp_name = v.get("gpName", "debris")
        outfile = workdir / f"{gp_name}.json"
        outfile.write_text(json.dumps(v, indent=2))
        # Replace the entities tag in the group_index with the uri to the group json
        if is_dev:
            group_index[k]["entities"] = f"./groups/{gp_name}.json"
        else:
            group_index[k]["entities"] = f"https://jackiepi.xyz/groups/{gp_name}.json"
    index_file.write_text(json.dumps(group_index, indent=2))

def write_one_file(
        infile: pathlib.Path,
        workdir: pathlib.Path
) -> None:
    outfile = workdir / f"{infile.stem}.json"
    outfile.write_text(json.dumps(satellite_groups, indent=2))

def setup_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "infile",
        type=pathlib.Path,
        metavar="FILE",
        help="input text file containing TLEs from Celestrak"
    )
    parser.add_argument(
        "catalog",
        type=pathlib.Path,
        metavar="FILE",
        help="full catalog file containing TLEs from Celestrak"
    )
    parser.add_argument(
        "-w",
        "--workdir",
        type=pathlib.Path,
        help="working directory, default is cwd"
    )
    parser.add_argument(
        "--one-file",
        action="store_true",
        help="Store output to a single file instead of one group"
    )
    parser.add_argument(
        "--dev",
        action="store_true",
        help="Use relative urls for groups in index.json (for dev)"
    )
    return parser

def main() -> None:
    logging.basicConfig(
        level=logging.DEBUG,
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
        filename="getSatellites_service.log",
        filemode="w"
    )
    parser = setup_parser()
    args = parser.parse_args()

    group_data = download_group_files()
    parse_tle(args.infile, args.catalog, group_data, args.workdir, args.one_file, args.dev)

if __name__ == "__main__":
    main()
