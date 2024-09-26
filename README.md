# jackiepi.xyz: Personal website with 3D Satellite Viewer and more

This repository contains the code for [jackiepi.xyz](https://jackiepi.xyz/), my personal website where I am hosting a couple of demos showcasing a 3D satellite telemetry visualization using threeJS. While the code in this project is primarily intended for use in my own website, some components -- in particular the WebGL shaders -- may be useful to other developers. I primarily write data science code in Python and C++, so some of the JavaScript and CSS in this repo may appear idiosyncratic.

These are the primary components:
* **landing.html**: A landing page with a rotating globe in the left third of the page, links to other parts of the site, and a brief summary of who I am. Developers may find the way I keep the globe in the same part of the canvas regardless of window geometry interesting.
* **satellites.html**: The primary feature of this project, an interactive webapp showing all satellites in the SATCAT database provided by [celestrak.org](https://celestrak.org/) in real time. Additional controls in the drop down menu on the right side of the window (the downward pointing arrow below the clock) enable the user to adjust the simulation speed, enable/disable the starry sky background layer, and show or hide all groups of satellites in the scene. Some aspects of this experience are still a work-in-progress and will be updated over the coming weeks.
* **nightsky.html**: This is an extra webpage intended to showcase the unique way I am rendering the stars in this application. The page is set up in the style of a threejs example and allows the user to adjust physical parameters of the star mapping shader to get a sense of how the stars are being displayed in the scene.
* **Pre-processing scripts**: Additional Python pre-processing scripts used to convert data from public databases into the format used by this project. GetStars.py and ImageGen.py are currently in a WIP state and not intended to be used by others.

## Installation
If you wish to install this project locally, first clone this repository, then run `npm install` from within the repository's top-level directory:
```bash
npm install
```

## Building & Running
### Prerequisite
This repository does not contain several .json files that are required for full functionality of the satellite viewing demo (satellites.html), but they can be generated automatically using the provided pre-processing script, tle_parser.py. Run the following commands in the top-level directory of this repository:
```bash
wget -O active_satellites.txt "https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle"
wget -O full_catalog.txt "https://celestrak.org/NORAD/elements/catalog.txt"
scripts/tle_parser.py active_satellites.txt full_catalog.txt  -w static/groups --dev
```

This step is handled nightly by a script (not included in this repository) that gets initiated by a systemd timer on my VPS.

### Dev Setup
This is a vite project, so to run the project locally, simply run the script `npm run dev` and your browser should automatically open a tab on [localhost:5173](http://localhost:5173/):
```bash
npm run dev
```
Note that because the satellite viewing application uses the Shared Array Buffer (SAB) feature of JavaScript to handle updating the satellite transformation matrices in a Web Worker, some settings have been added to the Vite config to add the required headers related to Cross Origin Opener Policy (COOP) and Cross Origin Embedder Policy (COEP). This may cause some simpler dev servers, like the live-server plugin for VsCode, to not be able to load the page on localhost.

### Building
This project is deployed to a Virtual Private Server (VPS) as fully-built artifact, rather than deployed to a serverless cloud provider like Vercel, so it is not guaranteed to work in a serverless context. I have a separate script that is not version controlled in this repository for building and deploying, but you can preview what a built version of the site would look like by running `npm run build`.
