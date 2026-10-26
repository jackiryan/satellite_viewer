# gibs-cloud-texture

A Cloudflare Worker that downloads every tile of one TileMatrix level of a NASA GIBS WMTS layer and stitches them into a single equirectangular PNG texture for three.js. It is set up for the NOAA-20 VIIRS Cloud Optical Thickness layer (`VIIRS_NOAA20_Cloud_Optical_Thickness`, 1km tile matrix set).

It also serves a [sea ice concentration texture](#sea-ice-concentration) made from the NSIDC Sea Ice Index's daily Arctic and Antarctic grids, in the same layout.

```
GET /global-texture?date=2026-10-12&tileMatrix=4&outputRes=8k&product=albedo
```

| Parameter    | Default  | Values |
|--------------|----------|--------|
| `date`       | required | `YYYY-MM-DD`. A timestamp such as `2026-10-12T00:00:00Z` is also accepted and the time of day is ignored. For dates in the last 4 days, the newest date GIBS has published at or before it is served (see [Caching](#caching)). |
| `tileMatrix` | `4` for `8k`, `3` otherwise | `0` to `MAX_TILE_MATRIX` (5 by default). The default is the lowest level with at least as many pixels as the texture: level 3 is 5120x2560, level 4 10240x5120. |
| `outputRes`  | `8k`     | `1k` (1024x512), `2k` (2048x1024), `4k` (4096x2048), `8k` (8192x4096) |
| `product`    | `colormap` | `colormap`: the GIBS colors as RGBA. `albedo`: greyscale cloud reflectance, used by the satellite viewer. |

`GET /` returns a JSON description of the API.

## The texture

Both products are 2:1 equirectangular PNGs: the left edge is 180°W, north is at the top, the same layout as the Blue Marble textures, so they map onto the same `SphereGeometry` UVs.

### `product=albedo`

A greyscale PNG of how much visible light the clouds reflect, ready to composite over the globe:

- Each tile color is matched to its entry in the layer's colormap (fetched from `GIBS_COLORMAP_URL` and kept per isolate), which gives an optical thickness range and a phase. The middle of that range (geometric mean, bins are log-spaced; `< 1` counts as 0.5) becomes a reflectance with the two-stream formula for non-absorbing clouds, `R = (1 - g) τ / (2 + (1 - g) τ)`, with asymmetry parameter g = 0.86 for water and 0.75 for ice. That gives R ≈ 0.07 at τ = 1, 0.43 at τ = 10 and 0.8 at τ = 50. No data and clear sky are 0.
- Reflectance is worked out per source pixel before resampling, so neighbouring colors are never blended into colors that aren't in the colormap, and averaging reflectance is physically right for a pixel that is partly cloudy.
- Stored as `sqrt(R) * 255`, which gives thin clouds more of the 256 levels. Decode with `v * v`.

### `product=colormap`

- colors are the GIBS colormap colors (ice phase magenta → blue → green, water phase yellow → orange → dark red). Pixels with no data (clear sky, night, gaps between orbits) are fully transparent.
- Resampling is bilinear when enlarging and area-averaged when shrinking (the default levels only ever shrink: level 3 is 5120x2560 and level 4, used for 8k, 10240x5120). It wraps across the antimeridian and is done in premultiplied alpha, so cloud edges fade out in alpha without picking up the transparent light-lavender color GIBS stores for no-data.

Response headers describe the source: `X-Requested-Date`, `X-Source-Date` (the date actually shown), `X-Source-Tile-Matrix`, `X-Source-Size` (e.g. `5120x2560`), `X-Texture-Size`, `X-Texture-Product`, `X-Cache` (`HIT` from R2, `MISS` when made for this request). They are exposed to browser code through CORS.

Errors come back as JSON with a status: `400` for bad parameters, `404` for dates outside the layer's range (before 2018-02-17 or after today UTC), and `502`/`504` when GIBS fails or returns something that is not a PNG. The GIBS error text is included in `detail`.

## Sea ice concentration

```
GET /sea-ice-texture?date=2026-10-17&outputRes=4k
```

| Parameter   | Default         | Values |
|-------------|-----------------|--------|
| `date`      | required        | `YYYY-MM-DD` (or a timestamp, as above), from 1978-10-26. The newest date NSIDC has published at or before it is served, looking back up to 7 days (see below). |
| `outputRes` | `4k`            | `1k`, `2k`, `4k`, `8k`, as above. The grids are 25 km, so a 4k texture (about 10 km per texel north to south) already shows all their detail; 8k only interpolates further. |
| `product`   | `concentration` | the only one for now |

The source is the [Sea Ice Index, Version 4](https://nsidc.org/data/g02135/versions/4) (G02135), which NSIDC serves without authentication. Each request uses two daily GeoTIFFs:

```
https://noaadata.apps.nsidc.org/NOAA/G02135/north/daily/geotiff/2026/10_Oct/N_20261017_concentration_v4.0.tif   EPSG:3411, 304x448
https://noaadata.apps.nsidc.org/NOAA/G02135/south/daily/geotiff/2026/10_Oct/S_20261017_concentration_v4.0.tif   EPSG:3412, 316x332
```

### The texture

A 2:1 equirectangular greyscale PNG with the same layout as the cloud textures (west edge at 180°W, north at the top), one byte per texel: `round(concentration * 255)`. 0 is open water and anything without data (land, and everywhere outside the two grids); 255 is 100% ice. Decode with `v / 255`, which is what sampling an 8-bit texture gives in a shader anyway.

Each GeoTIFF is a single band of 16-bit values with the land mask mixed into it (user guide, table 5). Only the concentration is kept:

| Value     | Meaning | In the texture |
|-----------|---------|----------------|
| 0         | open water | 0 |
| 1–1000    | concentration × 10 (803 = 80.3%) | `value / 1000`; under 150 (15%) counts as open water, as NSIDC recommends |
| 2510      | pole hole (no satellite coverage around the North Pole) | filled from the ice around it |
| 2530      | coastline (the black border in QGIS) | filled from the ocean cells next to it |
| 2540      | land | filled 2 cells (50 km) in from the coast, no data beyond |
| 2550      | missing (rare in version 4) | filled from the cells around it |

Filling works a ring at a time, each cell taking the mean of its neighbours that already have a value. Filling the coastline cells matters most in places like the Canadian Arctic Archipelago, where most channels are coastline cells. Carrying the ice a little way onto land means the texture reaches the coast wherever the globe's own, much sharper, land/ocean mask puts it, so **the shader should multiply the ice by that ocean mask** (`EarthSpec`), rather than relying on the 25 km grid's coastline. Viewed on its own, the texture shows ice spilling about 50 km onto land.

Each texel is reprojected exactly: its latitude and longitude go through the ellipsoidal polar stereographic projection (Hughes 1980 ellipsoid, true scale at 70°, matching PROJ to well under a millimetre) to grid coordinates, and the grid is sampled bilinearly from only the cells that have data. Where a texel covers more than one grid cell (only at 1k, toward the edges of the grids) it averages up to 4×4 samples. The projection and georeferencing are read from each file's GeoKeys and tie points, whether they give an EPSG code or spell out the projection's parameters, so a change of grid would still land in the right place. The Arctic grid reaches about 31°N and the Antarctic one 39°S; the rows between are 0.

Response headers are as for clouds: `X-Requested-Date`, `X-Source-Date`, `X-Source-Layer`, `X-Source-Size` (`N 304x448, S 316x332`), `X-Texture-Size`, `X-Texture-Product` and `X-Cache` (`HIT`, `MISS`, or `STALE`, below).

### Dates

NSIDC publishes a day's grids the following day, recomputes it the day after, and before 20 August 1987 there is only one every other day. A request is served the newest date at or before the one asked for, at most 7 days earlier, for which both GeoTIFFs exist, found by asking NSIDC for the files' headers (`HEAD`, or a one-byte `GET` if a server refuses `HEAD`). The answer is remembered for 10 minutes for recent dates and 4 hours for older ones. A stand-in for a recent date that isn't out yet is sent with a 15-minute `Cache-Control`; otherwise lifetimes are as for clouds. With nothing in the 7 days (3 December 1987 to 12 January 1988 has no data at all), the response is a `404`.

### Storage and failures

Sea ice textures are stored in the same R2 bucket under `sea-ice-texture/`, and a stored texture for the date asked for is served without contacting NSIDC. Because NSIDC recomputes recent days, a stored texture for a date under 4 days old is remade once it is `PREWARM_REFRESH_HOURS` old; if NSIDC can't be reached then, the old copy is served with `X-Cache: STALE` and a 15-minute lifetime. Both GeoTIFFs are downloaded and checked before the response starts, so NSIDC failures are always a proper `502` or `504` with NSIDC's status in `upstreamStatus`, and a texture that starts streaming can't be cut short.

The GeoTIFFs are read by a small dependency-free reader (`src/geotiff.js`) that handles what GDAL writes: strips or tiles, no compression, LZW, Deflate or PackBits, the horizontal predictor, either byte order, 8/16/32-bit samples. BigTIFF, JPEG and multi-band files are rejected with a clear error rather than misread.

## Deploying

The Worker needs the **Workers Paid plan**. A level 3 texture is 50 tile requests (level 4, the default for 8k, is 200), over the Free plan's 50-subrequest cap, and it takes seconds of CPU time rather than the Free plan's 10 ms. `wrangler.jsonc` raises the CPU limit to 60 s; the slowest case measured is about 14 s.

```bash
npm install
npx wrangler login
npx wrangler r2 bucket create gibs-textures   # once, for stored textures
npm run deploy        # prints the workers.dev URL and the hourly schedule
npm run tail          # live logs: one line per texture made, one per hourly run
```

### Caching

Finished textures are stored in an R2 bucket (binding `TEXTURES`) and served from there in a few milliseconds. Unlike Cloudflare's cache, R2 keeps them until they are deleted, however little traffic the site gets. A texture is only stored once it has been made in full.

**Hourly job.** A Cron Trigger (`7 * * * *`, `prewarm.js`) makes the textures the site will ask for before anyone does:

- It works out the dates pages will request (UTC, 1 and 2 days back; the globe asks for 2 days back, and 1 day back becomes that at the next UTC midnight).
- For each, it asks GIBS for the newest published date at or before it, and makes any missing textures at 2k, 4k and 8k. Textures for dates under 4 days old are remade after 6 hours, in case GIBS has filled in more of that day.
- It deletes textures stored more than 30 days ago, and ones left over from an older version of the Worker. Everything it stores is under `cloud-texture/` and `sea-ice-texture/` in the bucket, and the clean-up only touches those folders, so the bucket can hold other data too.
- It does the same for sea ice textures, at 2k and 4k for 1 and 2 days back (each date's GeoTIFFs are downloaded once for both sizes), after the clouds. A failure in one doesn't stop the other.
- The settings are the `PREWARM_*`, `SEA_ICE_PREWARM_*` and `STORE_RETAIN_DAYS` vars below.

**Unpublished dates.** GIBS publishes this layer about two days late, so early in the UTC day the date the globe asks for often isn't out yet. For dates under 4 days old, the Worker serves the newest published date at or before the one asked for, with `X-Source-Date` saying which. It checks with GIBS's list of published dates (WMTS DescribeDomains), remembered for 10 minutes. That fallback is sent with a 15-minute `Cache-Control`, so caches pick up the right date soon after GIBS publishes it.

**Cache lifetimes.** Responses tell browsers and proxies to keep a texture for 1 hour if its date is under 4 days old, and for 30 days otherwise.

**Testing the job locally.** It doesn't run by itself under `npm run dev`. Trigger it with `curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=7+*+*+*+*"`.

**From your own domain.** To serve the Worker from your own domain, either:

1. Uncomment the `routes` entry in `wrangler.jsonc`, for a domain that uses Cloudflare DNS.
2. Keep the `workers.dev` URL and proxy it from your VPS, which also keeps the texture same-origin (no CORS involved):

   ```nginx
   # in the http { } block (not inside server { }): where cached textures are kept on disk
   proxy_cache_path /var/cache/nginx/clouds levels=1:2 keys_zone=clouds:10m
                    max_size=2g inactive=30d use_temp_path=off;

   # in the server { } block
   location = /cloud-texture {
       proxy_pass https://gibs-cloud-texture.<your-subdomain>.workers.dev/global-texture;
       proxy_ssl_server_name on;
       proxy_read_timeout 2m;
       proxy_cache clouds;
       proxy_cache_lock on;                      # one Worker request per texture on a miss
       proxy_cache_lock_timeout 2m;
       proxy_cache_use_stale error timeout updating;
       add_header X-Proxy-Cache $upstream_cache_status always;
   }
   ```

   nginx keeps each texture for as long as the Worker's `Cache-Control` says. Don't copy `proxy_set_header Host $host` from other locations: the request has to reach workers.dev under its own host name. If the location isn't `/api/cloud-texture`, change the URL in `earth.js` (and the Vite proxy) to match.

   The sea ice texture goes through the same way, in the same `server { }` block (Vite's dev server already proxies `/sea-ice-texture` to the Worker):

   ```nginx
   location = /sea-ice-texture {
       proxy_pass https://gibs-cloud-texture.<your-subdomain>.workers.dev/sea-ice-texture;
       proxy_ssl_server_name on;
       proxy_read_timeout 1m;
       proxy_cache clouds;
       proxy_cache_lock on;
       proxy_cache_use_stale error timeout updating;
       add_header X-Proxy-Cache $upstream_cache_status always;
   }
   ```

### Settings (`vars` in `wrangler.jsonc`)

| Variable               | Default |
|------------------------|---------|
| `GIBS_BASE_URL`        | `https://gibs.earthdata.nasa.gov/wmts/epsg4326/best` |
| `GIBS_LAYER`           | `VIIRS_NOAA20_Cloud_Optical_Thickness` |
| `GIBS_TILE_MATRIX_SET` | `1km` |
| `GIBS_EARLIEST_DATE`   | `2018-02-17` (first day in GetCapabilities) |
| `GIBS_COLORMAP_URL`    | `https://gibs.earthdata.nasa.gov/colormaps/v1.3/MODIS_VIIRS_Cloud_Optical_Thickness.xml` (used by `product=albedo`) |
| `MAX_TILE_MATRIX`      | `5`. Level 4 (200 tiles) already has more pixels than an 8k texture; level 5 is 800 tiles. |
| `ALLOWED_ORIGINS`      | `*`, or a comma-separated list such as `https://jackiepi.xyz,http://localhost:5173` |
| `PREWARM_DAYS_BACK`    | `1,2`: days before today (UTC) the hourly job keeps textures ready for |
| `PREWARM_RESOLUTIONS`  | `2k,4k,8k` |
| `PREWARM_PRODUCT`      | `albedo` |
| `PREWARM_TILE_MATRIX`  | `2k:3,4k:3,8k:4`: the GIBS level for each resolution. A bare number such as `3` applies to all of them; resolutions left out use the `tileMatrix` default. |
| `PREWARM_REFRESH_HOURS`| `6`: remake textures for dates under 4 days old once they are this old |
| `STORE_RETAIN_DAYS`    | `30`: delete stored textures this long after they were made |
| `SEA_ICE_BASE_URL`     | `https://noaadata.apps.nsidc.org/NOAA/G02135` |
| `SEA_ICE_FILE_VERSION` | `4.0`, the version in the file names. Stored sea ice textures are kept per version, so changing it starts afresh and the old ones are cleaned up. |
| `SEA_ICE_EARLIEST_DATE`| `1978-10-26` |
| `SEA_ICE_PREWARM_DAYS_BACK` | `1,2`; `none` turns the hourly sea ice job off |
| `SEA_ICE_PREWARM_RESOLUTIONS` | `2k,4k`; `none` turns the hourly sea ice job off |

Any other daily layer in the EPSG:4326 "best" endpoint that serves PNG tiles should work by changing these.

## Using it from the satellite viewer

The globe requests `/cloud-texture?date=…&tileMatrix=…&outputRes=…&product=albedo`, with the date two days before the scene time. It asks for 2k on mobile, Safari and the landing page, and 8k elsewhere (4k if the GPU can't hold 8192-pixel textures), from level 3 for 2k and 4k and level 4 for 8k, so the 8k texture is shrunk from 10240x5120 tiles rather than enlarged 1.6x from level 3. nginx proxies `/cloud-texture` to this Worker in production, and Vite does the same in development (`vite.config.js`). To work on the Worker itself, run `npm run dev` here (port 8787) and point that Vite proxy at `http://localhost:8787`.

The texture is uploaded as a single-channel (`RedFormat`) texture, 32 MB of GPU memory at 8k. `earthFragment.glsl` turns it into true-color-like clouds. For cloud reflectance R, the day side shows `R + A T_sun T_view / (1 - R A)` over a surface of albedo A:
- light the cloud reflects;
- the ground, lit through the cloud between it and the sun (`T_sun`, read from the texture a little way toward the sun, which casts the shadows) and seen through the cloud above it (`T_view`);
- light bouncing between the ground and the cloud base.

Shadows come from a short ray march toward the sun over the cloud tops, treated as a height field: thin cloud is low, and opaque cloud forms flat-topped decks up to `cloudShadowHeight`. With the sun high, shadows are short. Near the terminator they stretch out along the sun's direction, and taller cloud shades lower cloud, as in geostationary GeoColor imagery. Cloud tops are also lit by their slope toward the sun. At night city lights show through and the cloud is faintly lit. The sun glint uses the Cox–Munk sea-surface model and also passes through `T_sun` and `T_view`, so clouds shadow it. The knobs are in `parameters` in `earth.js`: `cloudBrightness`, `cloudShadowHeight`, `cloudRelief`, `cloudTwilightTint` (0 removes the warm tint near the terminator), `windSpeed` and `glintBrightness`. The atmosphere is drawn the same way: haze over the globe whitens toward the limb (`atmosphereHaze`, `atmosphereBrightness`), and the glow beyond the limb uses the same scattering (`haloScaleHeight`), with the shared maths in `src/shaders/common/atmosphere.glsl`.

The response sends `Access-Control-Allow-Origin` and `Cross-Origin-Resource-Policy: cross-origin`, so it also loads cross-origin into pages served with `Cross-Origin-Embedder-Policy: require-corp`.

## Size and speed

Measured with synthetic level 3 tiles that use the real colormap, with ~63% cloud cover. GIBS itself could not be reached from the test environment. The range is between a smooth cloud field and one with per-pixel noise; real data should fall in between.

| `outputRes` | `colormap` size | CPU time  | `albedo` size | CPU time |
|-------------|-----------------|-----------|---------------|----------|
| 1k          | 0.5-1 MB        | 0.7-1 s   | 0.3 MB        | 0.6 s    |
| 2k          | 1.4-3.6 MB      | 1.1-1.3 s | 0.5-1.2 MB    | 0.7-0.8 s |
| 4k          | 3.7-14 MB       | 2.2-2.9 s | 5 MB          | 1.1 s    |
| 8k          | 8-44 MB         | 4.3-8 s   | 3.2-17 MB     | 2.6 s    |

Most of the time is zlib compressing the pixels; `albedo` has a quarter as many bytes per pixel. Levels 4 and 5 to 8k took about 10 s and 14 s. Peak memory stayed between 35 and 50 MB.

Sea ice textures are far cheaper: two GeoTIFFs of a few hundred kB, decoded in tens of milliseconds, and texels outside the grids cost nothing. Measured under `wrangler dev` with synthetic grids laid out like NSIDC's (real land mask, pole hole, palette, LZW; NSIDC could not be reached from the test environment either):

| `outputRes` | size    | CPU time |
|-------------|---------|----------|
| 1k          | 15 KB   | 0.06 s   |
| 2k          | 43 KB   | 0.14 s   |
| 4k          | 115 KB  | 0.25-0.4 s |
| 8k          | 310 KB  | 1.1 s    |

## How it works

- `src/gibs.js`: the tile grid (every GIBS EPSG:4326 set starts at 0.5625° per pixel at level 0 with 512 px tiles: level 3 is 10x5 tiles, level 4 20x10), tile requests with retries for 429/5xx, and a reader that presents a whole level as one image, row by row.
- `src/resample.js`: separable triangle-filter resampling (Pillow's BILINEAR scheme), wrapping in longitude.
- `src/png.js`: a PNG decoder (all color types, bit depths and filters) and a streaming RGBA or greyscale encoder on the runtime's `CompressionStream`.
- `src/albedo.js`: colormap parsing and the color → optical thickness → reflectance mapping.
- `src/texture.js`: the pipeline. Only one tile row is inflated at a time and the output is streamed, so memory stays flat even though an 8k RGBA image is 134 MB raw.
- `src/store.js`: R2 keys, metadata, and a streaming multipart upload that only completes once the whole texture has been written.
- `src/availability.js`: the dates GIBS has published (WMTS DescribeDomains), and which one to serve for a request.
- `src/prewarm.js`: the hourly job.
- `src/index.js`: request handling, validation, CORS, serving from R2, and the scheduled entry point.
- `src/seaice.js`: the sea ice texture: NSIDC URLs and which dates are published, cleaning up the grids (flags, filling), and the reprojection into the equirectangular PNG.
- `src/geotiff.js`: the GeoTIFF reader (TIFF structure, LZW/Deflate/PackBits, predictor, georeferencing and GeoKeys).
- `src/polarstereo.js`: the ellipsoidal polar stereographic projection (EPSG:3411/3412/3413/3976 or parameters from GeoKeys).

**Failure handling.** For levels up to 3 (at most 64 tiles), every tile is downloaded and checked before the response starts, so any GIBS failure becomes a proper `502`. Larger levels stream tile rows as the texture is written, so a tile that still fails after retries cuts the PNG short. A cut-short PNG can't be told apart from a complete one, so that first response is sent with `Cache-Control: no-store`, and nothing is stored: the R2 upload is aborted.

## Tests

```bash
npm test
```

This covers the PNG decoder and encoder, the colormap → reflectance mapping, the tile geometry (including where tiles land and the antimeridian blend), retries and errors, the Worker's validation, R2 storage, date fallback, hourly job and CORS. GIBS and R2 are faked.

For sea ice it covers the GeoTIFF reader (every layout and compression above, against GeoTIFFs written by an independent writer in `test/tiff-helpers.js`), the projection against reference points from PROJ, the flag handling and filling, that ice lands at its own latitude and longitude in both hemispheres, date fallback, failures, stale textures and the hourly job. NSIDC is faked.

Imagery: NASA Global Imagery Browse Services (GIBS), part of NASA's Earth Science Data and Information System (ESDIS).

Sea ice: Sea Ice Index, Version 4 (G02135), NOAA@NSIDC, National Snow and Ice Data Center.
