#!/usr/bin/env python3
import argparse
import json
import logging
import os
import pathlib
import requests

logger = logging.getLogger(__name__)

satellite_groups = {
    "GLONASS": {
        "supGpName": "glonass",
        "country": "ru",
        "baseColor": "#d62718",
        "entities": {}
    },
    "GPS": {
        "supGpName": "gps",
        "country": "us",
        "baseColor": "#4b5320",
        "entities": {}
    },
    "Intelsat": {
        "supGpName": "intelsat",
        "country": "lu",
        "baseColor": "#00a4e1",
        "entities": {}
    },
    "Iridium": {
        "supGpName": "iridium",
        "country": "us",
        "baseColor": "#00a4e1",
        "entities": {}
    },
    "ISS": {
        "supGpName": "iss",
        "baseColor": "#00a4e1",
        "entities": {}
    },
    "Kuiper": {
        "supGpName": "kuiper",
        "country": "us",
        "baseColor": "#00a4e1",
        "entities": {}
    },
    "OneWeb": {
        "supGpName": "oneweb",
        "country": "gb",
        "baseColor": "#00a4e1",
        "entities": {}
    },
    "Planet Labs": {
        "supGpName": "planet",
        "country": "us",
        "baseColor": "#00a4e1",
        "entities": {}
    },
    "Starlink": {
        "supGpName": "starlink",
        "country": "us",
        "baseColor": "#00a4e1",
        "entities": {}
    },
    "Telesat": {
        "supGpName": "telesat",
        "country": "ca",
        "baseColor": "#00a4e1",
        "entities": {}
    },
    "Other": {
        "entities": {}
    }
}

special_colors = {
    "ISS (ZARYA)": "#f72091"
}

def remove_blanks(
        lines: list[str]
) -> list[str]:
    return [line for line in lines if line.strip()]

def find_group(
        norad_id: int,
        group_data: dict[str, list[int]]
) -> str:
    return next((k for k, v in group_data.items() if norad_id in v), "Other")

def get_norad_id(
        tle_line: str
) -> int:
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
        sup_gp_name = group.get("supGpName")
        if sup_gp_name is None:
            continue
        sup_gp_url = f"https://celestrak.org/NORAD/elements/supplemental/sup-gp.php?FILE={sup_gp_name}&FORMAT=csv"
        logger.debug(f"Getting supplemental group data for {sup_gp_name}...")
        sup_gp_data = download_content(sup_gp_url)
        sup_gp_lines = remove_blanks(sup_gp_data.decode("utf-8").splitlines())
        try:
            id_ndx = sup_gp_lines[0].split(",").index("NORAD_CAT_ID")
        except ValueError as e:
            logging.error(f"Failed to find NORAD_CAT_ID in group csv")
            raise e
        group_data[group_name] = [int(gp_sat.split(",")[id_ndx]) for gp_sat in sup_gp_lines[1:]]
        logger.debug(f"Found {len(sup_gp_lines)} entries for the {sup_gp_name} group.")
    return group_data

def parse_tle(
        infile: pathlib.Path,
        group_data: dict[str, list[int]],
        workdir: pathlib.Path | None,
        one_file: bool
) -> None:
    lines = infile.read_text().splitlines()
    workdir = workdir or pathlib.Path.cwd()
    tle_lines = remove_blanks(lines)
    for line_ndx, line in enumerate(tle_lines):
        match line_ndx % 3:
            case 0:
                sat_name = line.strip()
            case 1:
                tle_line1 = line.strip()
                norad_id = get_norad_id(tle_line1)
                group = find_group(norad_id, group_data)
            case 2:
                tle_line2 = line.strip()
                add_satellite(
                    sat_name,
                    tle_line1,
                    tle_line2,
                    norad_id,
                    group
                )
    try:
        if one_file:
            write_one_file(infile, workdir)
        else:
            write_group_files(workdir)
    except Exception as e:
        logging.error(f"Error writing satellite database: {e}")
        logging.debug("Satellite database is as follows:")
        logging.debug(satellite_groups)
        raise e

def write_group_files(
        workdir: pathlib.Path
) -> None:
    for group in satellite_groups.values():
        gp_name = group.get("supGpName", "other")
        outfile = workdir / f"{gp_name}.json"
        outfile.write_text(json.dumps(group, indent=2))

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
    parse_tle(args.infile, group_data, args.workdir, args.one_file)

if __name__ == "__main__":
    main()
