# gibs-cloud-texture

A Cloudflare Worker that downloads every tile of one TileMatrix level of a NASA GIBS WMTS layer and stitches them into a single equirectangular PNG texture for three.js. It is set up for the NOAA-20 VIIRS Cloud Optical Thickness layer (`VIIRS_NOAA20_Cloud_Optical_Thickness`, 1km tile matrix set).

```
GET /global-texture?date=2026-10-12&tileMatrix=3&outputRes=8k
```

| Parameter    | Default  | Values |
|--------------|----------|--------|
| `date`       | required | `YYYY-MM-DD`. A timestamp such as `2026-10-12T00:00:00Z` is also accepted and the time of day is ignored, so the URLs `earth.js` already builds work unchanged. |
| `tileMatrix` | `3`      | `0` to `MAX_TILE_MATRIX` (5 by default) |
| `outputRes`  | `8k`     | `1k` (1024x512), `2k` (2048x1024), `4k` (4096x2048), `8k` (8192x4096) |

`GET /` returns a JSON description of the API.

## The texture

- 2:1 equirectangular RGBA PNG: the left edge is 180°W, north is at the top, the same layout as the Blue Marble textures, so it maps onto the same `SphereGeometry` UVs.
- Colours are the GIBS colormap colours (ice phase magenta → blue → green, water phase yellow → orange → dark red). Pixels with no data (clear sky, night, gaps between orbits) are fully transparent.
- Resampling is bilinear when enlarging (level 3 is 5120x2560, so 8k is a 1.6x enlargement) and area-averaged when shrinking. It wraps across the antimeridian and is done in premultiplied alpha, so cloud edges fade out in alpha without picking up the transparent light-lavender colour GIBS stores for no-data.
- Response headers describe the source: `X-Source-Date`, `X-Source-Tile-Matrix`, `X-Source-Size` (e.g. `5120x2560`), `X-Texture-Size`, `X-Cache` (`HIT`/`MISS`). They are exposed to browser code through CORS.

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
| `MAX_TILE_MATRIX`      | `5`. Level 4 (200 tiles) already has more pixels than an 8k texture; level 5 is 800 tiles. |
| `ALLOWED_ORIGINS`      | `*`, or a comma-separated list such as `https://jackiepi.xyz,http://localhost:5173` |

Any other daily layer in the EPSG:4326 "best" endpoint that serves PNG tiles should work by changing these.

## Using it from the satellite viewer

For local development run the Worker with `npm run dev` (port 8787) and point the existing Vite proxy at it. The rewrite to `/global-texture` already matches:

```js
// vite.config.js
proxy: {
    '/api/cloud-texture': {
        target: 'http://localhost:8787',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/cloud-texture/, '/global-texture')
    }
}
```

Two small things in `earth.js`:

- Load the texture with `this.loadTexture(url, { premultiplyAlpha: 'none' })`. `loadWithImageBitmap` replaces three.js's default `premultiplyAlpha: 'none'` when it sets `imageOrientation`, which lets the browser premultiply the semi-transparent edge pixels and shift their colours away from the colormap the shader matches against.
- On mobile and Safari, where the Earth textures drop to 2048x1024, add `&outputRes=2k` too. An 8k RGBA texture takes 134 MB of GPU memory once decoded.

The response sends `Access-Control-Allow-Origin` and `Cross-Origin-Resource-Policy: cross-origin`, so it also loads cross-origin into pages served with `Cross-Origin-Embedder-Policy: require-corp`.

## Size and speed

Measured with synthetic level 3 tiles that use the real colormap, with ~63% cloud cover. GIBS itself could not be reached from the test environment. The range is between a smooth cloud field and one with per-pixel noise; real data should fall in between.

| `outputRes` | PNG size     | CPU time  |
|-------------|--------------|-----------|
| 1k          | 0.5-1 MB     | 0.7-1 s   |
| 2k          | 1.4-3.6 MB   | 1.1-1.3 s |
| 4k          | 3.7-14 MB    | 2.2-2.9 s |
| 8k          | 8-44 MB      | 4.3-8 s   |

Most of the 8k time is zlib compressing 134 MB of pixels. Levels 4 and 5 to 8k took about 10 s and 14 s. Peak memory stayed between 35 and 50 MB.

## How it works

- `src/gibs.js`: the tile grid (every GIBS EPSG:4326 set starts at 0.5625° per pixel at level 0 with 512 px tiles: level 3 is 10x5 tiles, level 4 20x10), tile requests with retries for 429/5xx, and a reader that presents a whole level as one image, row by row.
- `src/resample.js`: separable triangle-filter resampling (Pillow's BILINEAR scheme), wrapping in longitude.
- `src/png.js`: a PNG decoder (all colour types, bit depths and filters) and a streaming RGBA encoder on the runtime's `CompressionStream`.
- `src/texture.js`: the pipeline. Only one tile row is inflated at a time and the output is streamed, so memory stays flat even though an 8k RGBA image is 134 MB raw.
- `src/index.js`: request handling, validation, CORS and caching.

**Failure handling.** For levels up to 3 (at most 64 tiles), every tile is downloaded and checked before the response starts, so any GIBS failure becomes a proper `502`. Larger levels stream tile rows as the texture is written, so a tile that still fails after retries cuts the PNG short. A cut-short PNG can't be told apart from a complete one, so that first response is sent with `Cache-Control: no-store`, and a cached texture is only served once a completion marker has been written after it.

## Tests

```bash
npm test
```

This covers the PNG decoder and encoder, the tile geometry (including where tiles land and the antimeridian blend), retries and errors, and the Worker's validation, caching and CORS. GIBS and the Cache API are faked.

Imagery: NASA Global Imagery Browse Services (GIBS), part of NASA's Earth Science Data and Information System (ESDIS).
