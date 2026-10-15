# gibs-cloud-texture

A Cloudflare Worker that downloads every tile of one TileMatrix level of a NASA GIBS WMTS layer and stitches them into a single equirectangular PNG texture for three.js. It is set up for the NOAA-20 VIIRS Cloud Optical Thickness layer (`VIIRS_NOAA20_Cloud_Optical_Thickness`, 1km tile matrix set).

```
GET /global-texture?date=2026-10-12&tileMatrix=3&outputRes=8k&product=albedo
```

| Parameter    | Default  | Values |
|--------------|----------|--------|
| `date`       | required | `YYYY-MM-DD`. A timestamp such as `2026-10-12T00:00:00Z` is also accepted and the time of day is ignored, so the URLs `earth.js` already builds work unchanged. |
| `tileMatrix` | `3`      | `0` to `MAX_TILE_MATRIX` (5 by default) |
| `outputRes`  | `8k`     | `1k` (1024x512), `2k` (2048x1024), `4k` (4096x2048), `8k` (8192x4096) |
| `product`    | `colormap` | `colormap`: the GIBS colours as RGBA. `albedo`: greyscale cloud reflectance, used by the satellite viewer. |

`GET /` returns a JSON description of the API.

## The texture

Both products are 2:1 equirectangular PNGs: the left edge is 180°W, north is at the top, the same layout as the Blue Marble textures, so they map onto the same `SphereGeometry` UVs.

### `product=albedo`

A greyscale PNG of how much visible light the clouds reflect, ready to composite over the globe:

- Each tile colour is matched to its entry in the layer's colormap (fetched from `GIBS_COLORMAP_URL` and kept per isolate), which gives an optical thickness range and a phase. The middle of that range (geometric mean, bins are log-spaced; `< 1` counts as 0.5) becomes a reflectance with the two-stream formula for non-absorbing clouds, `R = (1 - g) τ / (2 + (1 - g) τ)`, with asymmetry parameter g = 0.86 for water and 0.75 for ice. That gives R ≈ 0.07 at τ = 1, 0.43 at τ = 10 and 0.8 at τ = 50. No data and clear sky are 0.
- Reflectance is worked out per source pixel before resampling, so neighbouring colours are never blended into colours that aren't in the colormap, and averaging reflectance is physically right for a pixel that is partly cloudy.
- Stored as `sqrt(R) * 255`, which gives thin clouds more of the 256 levels. Decode with `v * v`.

### `product=colormap`

- Colours are the GIBS colormap colours (ice phase magenta → blue → green, water phase yellow → orange → dark red). Pixels with no data (clear sky, night, gaps between orbits) are fully transparent.
- Resampling is bilinear when enlarging (level 3 is 5120x2560, so 8k is a 1.6x enlargement) and area-averaged when shrinking. It wraps across the antimeridian and is done in premultiplied alpha, so cloud edges fade out in alpha without picking up the transparent light-lavender colour GIBS stores for no-data.

Response headers describe the source: `X-Source-Date`, `X-Source-Tile-Matrix`, `X-Source-Size` (e.g. `5120x2560`), `X-Texture-Size`, `X-Texture-Product`, `X-Cache` (`HIT`/`MISS`). They are exposed to browser code through CORS.

Errors come back as JSON with a status: `400` for bad parameters, `404` for dates outside the layer's range (before 2018-02-17 or after today UTC), and `502`/`504` when GIBS fails or returns something that is not a PNG. The GIBS error text is included in `detail`.

## Deploying

The Worker needs the **Workers Paid plan**. A level 3 texture is 50 tile requests plus cache lookups, over the Free plan's 50-subrequest cap, and it takes seconds of CPU time rather than the Free plan's 10 ms. `wrangler.jsonc` raises the CPU limit to 60 s; the slowest case measured is about 14 s.

```bash
npm install
npx wrangler login
npm run deploy        # prints the workers.dev URL
npm run tail          # live logs, one line per texture built
```

### Caching

A texture is built once and then served from Cloudflare's cache (the Cache API) until it expires:

- dates in the last 4 days: 1 hour, because GIBS keeps adding data for a day after it ends;
- older dates: 30 days.

Browsers get the same `Cache-Control`. The Cache API cache is per data centre, and Cloudflare only documents it as working for Workers on a custom domain. Two ways to get that:

1. Serve the Worker from a hostname on a domain that uses Cloudflare DNS: uncomment the `routes` entry in `wrangler.jsonc`.
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

Any other daily layer in the EPSG:4326 "best" endpoint that serves PNG tiles should work by changing these.

## Using it from the satellite viewer

The globe requests `/cloud-texture?date=…&tileMatrix=3&outputRes=…&product=albedo`, with the date two days before the scene time. It asks for 2k on mobile, Safari and the landing page, and 8k elsewhere (4k if the GPU can't hold 8192-pixel textures). nginx proxies `/cloud-texture` to this Worker in production, and Vite does the same in development (`vite.config.js`). To work on the Worker itself, run `npm run dev` here (port 8787) and point that Vite proxy at `http://localhost:8787`.

The texture is uploaded as a single-channel (`RedFormat`) texture, 32 MB of GPU memory at 8k. `earthFragment.glsl` turns it into true-colour-like clouds. For cloud reflectance R, the day side shows `R + A T_sun T_view / (1 - R A)` over a surface of albedo A:
- light the cloud reflects;
- the ground, lit through the cloud between it and the sun (`T_sun`, read from the texture a little way toward the sun, which casts the shadows) and seen through the cloud above it (`T_view`);
- light bouncing between the ground and the cloud base.

Shadows come from a short ray march toward the sun over the cloud tops, treated as a height field: thin cloud is low, and opaque cloud forms flat-topped decks up to `cloudShadowHeight`. With the sun high, shadows are short. Near the terminator they stretch out along the sun's direction, and taller cloud shades lower cloud, as in geostationary GeoColor imagery. Cloud tops are also lit by their slope toward the sun. At night city lights show through and the cloud is faintly lit. The sun glint uses the Cox–Munk sea-surface model and also passes through `T_sun` and `T_view`, so clouds shadow it. The knobs are in `parameters` in `earth.js`: `cloudBrightness`, `cloudShadowHeight`, `cloudRelief`, `cloudTwilightTint` (0 removes the warm tint near the terminator), `windSpeed` and `glintBrightness`.

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

## How it works

- `src/gibs.js`: the tile grid (every GIBS EPSG:4326 set starts at 0.5625° per pixel at level 0 with 512 px tiles: level 3 is 10x5 tiles, level 4 20x10), tile requests with retries for 429/5xx, and a reader that presents a whole level as one image, row by row.
- `src/resample.js`: separable triangle-filter resampling (Pillow's BILINEAR scheme), wrapping in longitude.
- `src/png.js`: a PNG decoder (all colour types, bit depths and filters) and a streaming RGBA or greyscale encoder on the runtime's `CompressionStream`.
- `src/albedo.js`: colormap parsing and the colour → optical thickness → reflectance mapping.
- `src/texture.js`: the pipeline. Only one tile row is inflated at a time and the output is streamed, so memory stays flat even though an 8k RGBA image is 134 MB raw.
- `src/index.js`: request handling, validation, CORS and caching.

**Failure handling.** For levels up to 3 (at most 64 tiles), every tile is downloaded and checked before the response starts, so any GIBS failure becomes a proper `502`. Larger levels stream tile rows as the texture is written, so a tile that still fails after retries cuts the PNG short. A cut-short PNG can't be told apart from a complete one, so that first response is sent with `Cache-Control: no-store`, and a cached texture is only served once a completion marker has been written after it.

## Tests

```bash
npm test
```

This covers the PNG decoder and encoder, the colormap → reflectance mapping, the tile geometry (including where tiles land and the antimeridian blend), retries and errors, and the Worker's validation, caching and CORS. GIBS and the Cache API are faked.

Imagery: NASA Global Imagery Browse Services (GIBS), part of NASA's Earth Science Data and Information System (ESDIS).
