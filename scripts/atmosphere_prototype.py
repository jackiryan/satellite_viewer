"""Numpy port of the Earth and atmosphere shaders, for checking colors without the app.

Mirrors src/shaders/common/atmosphere.glsl and the lighting in earthFragment.glsl one-to-one
(the same table of air columns, made the same way as src/atmosphereTable.js and read with the
same bilinear lookup; the same per-segment in-scatter and sample placement; the same twilight
sky, observer adaptation and sun glint; rays are traced to the true sphere, as the shaders do),
renders the globe with the repository's Blue Marble textures, procedural clouds (for color only;
their shapes are made up) and the Black Marble at night, and writes a PNG. See
docs/atmosphere-shader.md.

Usage:  python scripts/atmosphere_prototype.py                      # defaults -> proto.png
        python scripts/atmosphere_prototype.py '{"mieDepth": 0.15}' out.png
        python scripts/atmosphere_prototype.py '{"samples": 6}' mobile.png   # the mobile quality tier
        python scripts/atmosphere_prototype.py '{"old_model": true}' old.png   # the original haze
        python scripts/atmosphere_prototype.py twilight              # the twilight table in the docs

Parameters are the same names as in earth.js (km instead of scene units). Radiance units: a
white Lambertian surface under the overhead sun is 1.0. Requires numpy and Pillow with AVIF.
"""
import functools
import os
import sys
import numpy as np

REPO = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')

# ---------------------------------------------------------------- parameters (km, linear sRGB)
# The defaults in src/earth.js
P = dict(
    R=6371.0,
    heightScale=3.0,                 # atmosphereHeightScale: stretches the air's heights (not its optical depth)
    rayleighHeight=8.0,              # scale heights and the top, as in src/atmosphereTable.js
    mieHeight=1.2,
    top=100.0,
    rayleighDepth=np.array([0.046, 0.108, 0.265]),   # vertical optical depths, as in earth.js
    ozoneDepth=np.array([0.040, 0.015, 0.0]),        # absorption, folded into the Rayleigh profile
    mieDepth=0.04,
    mieAlbedo=0.9,
    mieG=0.76,
    multipleScattering=2.0,
    skylight=1.0,
    sunIntensity=1.0,
    exposure=1.3,                    # renderer.toneMappingExposure in viewer.js
    cloudShadowAmbient=0.3,
    glintBrightness=0.75,
    windSpeed=5.0,
    nightCloudLight=0.02,
    # the observer: how much dim, low-sun regions are brightened, the illumination above which
    # they are not, and the illumination at which the view is half day- and half night-adapted
    twilightAdaptation=0.8,
    adaptationKnee=0.3,
    nightAdaptationLevel=1e-3,
    samples=8,                       # ATMOSPHERE_SAMPLES for the globe (6 on mobile devices)
)

TWILIGHT_WIDTH = 0.02          # e-folding of the twilight sky's irradiance, in cos(sun zenith)
LUMINANCE = np.array([0.2126, 0.7152, 0.0722])


# ---------------------------------------------------------------- the table of air columns
TABLE_WIDTH, TABLE_HEIGHT = 256, 16   # as in src/atmosphereTable.js


def column_ratio(r, mu, H, n=32):
    """Column along cos(zenith) mu >= 0 from radius r to space, over the column straight up from
    r, for an exponential profile of scale height H: columnRatio() in src/atmosphereTable.js
    (the substitutions a = H t^2 and t = tc sinh(v), then n-point Gauss-Legendre)."""
    x, w = np.polynomial.legendre.leggauss(n)
    r = np.asarray(r, float)[..., None]
    mu = np.asarray(mu, float)[..., None]
    tc = np.maximum(mu * np.sqrt(r / (2 * H)), 1e-6)
    v_max = np.arcsinh(np.sqrt(40.0) / tc)
    v = 0.5 * v_max * (x + 1)
    t = tc * np.sinh(v)
    dt = tc * np.cosh(v) * 0.5 * v_max * w
    a = H * t * t
    return np.sum(dt * np.exp(-t * t) * 2 * t * (r + a) / np.sqrt(r * r * mu * mu + a * (2 * r + a)), axis=-1)


def scale_heights(p):
    return np.array([p['rayleighHeight'], p['mieHeight']]) * p['heightScale']


@functools.lru_cache(maxsize=4)
def _table(R, rayleighHeight, mieHeight, top):
    h = top * np.linspace(0, 1, TABLE_HEIGHT)
    mu = np.linspace(0, 1, TABLE_WIDTH) ** 2
    hh, mm = np.meshgrid(h, mu, indexing='ij')
    table = np.stack([column_ratio(R + hh, mm, rayleighHeight), column_ratio(R + hh, mm, mieHeight)], -1)
    return table.astype(np.float16).astype(float)        # stored as half floats


def air_column_table(p):
    """The texture: [height row, sqrt(mu) column, Rayleigh / Mie], rounded to half floats."""
    Hr, Hm = scale_heights(p)
    return _table(p['R'], Hr, Hm, p['top'] * p['heightScale'])


def air_columns_up(h, mu, p):
    """airColumnsUp() in atmosphere.glsl: columns from height h along cos(zenith) mu >= 0, in
    vertical columns from the ground, by bilinear interpolation in the table. Shape [..., 2]."""
    table = air_column_table(p)
    x = np.sqrt(np.clip(mu, 0, 1)) * (TABLE_WIDTH - 1)
    y = np.clip(h / (p['top'] * p['heightScale']), 0, 1) * (TABLE_HEIGHT - 1)
    x0 = np.minimum(np.floor(x).astype(int), TABLE_WIDTH - 2)
    y0 = np.minimum(np.floor(y).astype(int), TABLE_HEIGHT - 2)
    fx = (x - x0)[..., None]
    fy = (y - y0)[..., None]
    ratio = ((1 - fy) * ((1 - fx) * table[y0, x0] + fx * table[y0, x0 + 1])
             + fy * ((1 - fx) * table[y0 + 1, x0] + fx * table[y0 + 1, x0 + 1]))
    return ratio * np.exp(-np.maximum(h, 0)[..., None] / scale_heights(p))


def air_columns_at(h, mu, p):
    """airColumnsAt(): any direction. Below the horizon: twice the horizontal column from the
    ray's lowest point less the column up the mirror-image ray; inf where it meets the ground."""
    h = np.asarray(h, float)
    mu = np.asarray(mu, float)
    up = air_columns_up(h, np.abs(mu), p)
    lowest = (p['R'] + h) * np.sqrt(np.maximum(1 - mu * mu, 0)) - p['R']
    down = 2 * air_columns_up(np.maximum(lowest, 0), np.zeros_like(mu), p) - up
    out = np.where((mu >= 0)[..., None], up, down)
    return np.where(((mu < 0) & (lowest < 0))[..., None], np.inf, out)


def air_columns(pos, direction, p):
    r = np.linalg.norm(pos, axis=-1)
    return air_columns_at(r - p['R'], np.sum(pos * direction, axis=-1) / r, p)


def extinction(columns, p):
    """Optical depth per channel for air columns [..., 2] -> [..., 3]"""
    return ((p['rayleighDepth'] + p['ozoneDepth']) * columns[..., :1]
            + p['mieDepth'] * columns[..., 1:])


def transmittance(pos, direction, p):
    return np.exp(-extinction(air_columns(pos, direction, p), p))


# ---------------------------------------------------------------- the model
def phase_rayleigh(cosTheta):
    return 3 / (16 * np.pi) * (1 + cosTheta * cosTheta)


def phase_hg(cosTheta, g):
    return (1 - g * g) / (4 * np.pi * (1 + g * g - 2 * g * cosTheta) ** 1.5)


def scatter_along(cam, direction, t0, t1, sunDir, p, samples=8, towards_end=True):
    """Transmittance and in-scattered sunlight (display units) along the ray cam + t*direction,
    from t0 (where it enters the atmosphere) to t1. Samples are placed closer together near t1
    when towards_end (surface hits), symmetric about the middle otherwise. The camera is outside
    the atmosphere, so the first sample is t0 itself, with no air between it and the camera."""
    n = t0.shape[0]
    cosTheta = np.sum(direction * sunDir, axis=-1)[:, None]
    pR = phase_rayleigh(cosTheta) * np.pi
    pM = phase_hg(cosTheta, p['mieG']) * np.pi
    omegaR = p['rayleighDepth'] / (p['rayleighDepth'] + p['ozoneDepth'])

    s = np.linspace(0, 1, samples + 1)[1:]
    if towards_end:
        f = 1 - (1 - s) ** 2
    else:
        f = 0.5 + 2 * np.sign(s - 0.5) * (s - 0.5) ** 2
    ts = t0[:, None] + (t1 - t0)[:, None] * f[None, :]

    inscatter = np.zeros((n, 3))
    prevT = np.ones((n, 3))
    prevCols = np.zeros((n, 2))
    prevDist = t0[:, None]
    for i in range(samples):
        dist = ts[:, i:i + 1]
        cols = air_columns(cam + dist * direction, -direction, p)
        T = np.exp(-extinction(cols, p))
        seg = np.maximum(cols - prevCols, 0)
        segR = (p['rayleighDepth'] + p['ozoneDepth']) * seg[:, :1]
        segM = p['mieDepth'] * seg[:, 1:]
        tot = np.maximum(segR + segM, 1e-7)
        share = (segR * omegaR * pR + segM * p['mieAlbedo'] * pM) / tot
        Tsun = transmittance(cam + 0.5 * (prevDist + dist) * direction, sunDir, p)
        inscatter += Tsun * (prevT - T) * share
        prevT, prevCols, prevDist = T, cols, dist
    inscatter *= p['sunIntensity'] * (1 + p['multipleScattering'] * (1 - prevT))
    return prevT, inscatter


def softplus_mu(mu, w=TWILIGHT_WIDTH):
    """mu for mu >> w, decaying as w * exp(mu / w) below the horizon: the twilight sky."""
    return np.where(mu > 0, mu + w * np.log1p(np.exp(-np.abs(mu) / w)), w * np.log1p(np.exp(mu / w)))


def sun_columns(mu0, p):
    """Air columns from the ground toward the sun, or along the horizon once it has set: shared
    by the direct beam and the skylight, as in earthFragment.glsl"""
    return air_columns_at(np.zeros_like(mu0), np.maximum(mu0, 0), p)


def sky_irradiance(mu0, columns, p):
    """Diffuse skylight on the ground (per channel, relative to the overhead sun), continuing
    into twilight past the terminator. Mirrors skyIrradiance() in atmosphere.glsl."""
    scattered = 1 - np.exp(-(p['rayleighDepth'] * columns[..., :1] + p['mieDepth'] * p['mieAlbedo'] * columns[..., 1:]))
    ozone = np.exp(-0.5 * p['ozoneDepth'] * columns[..., :1])
    return p['skylight'] * 0.5 * scattered * ozone * softplus_mu(mu0)[..., None]


def ground_light(mu0, p):
    """Direct sun transmittance at the ground (0 once the sun has set) and the skylight"""
    columns = sun_columns(mu0, p)
    t_sun = np.where((mu0 > 0)[..., None], np.exp(-extinction(columns, p)), 0)
    return t_sun, sky_irradiance(mu0, columns, p)


def adaptation(irradiance, p):
    """Observer adaptation for the light on the ground: (gain for reflected sunlight, weight of
    the night lights). Mirrors observerAdaptation() in earthFragment.glsl."""
    E = irradiance @ LUMINANCE
    A = p['nightAdaptationLevel']
    gain = np.maximum(((p['adaptationKnee'] + A) / (E + A)) ** p['twilightAdaptation'], 1.0)
    night = 1 / (1 + (E / A) ** 2)
    return gain, night


def wave_shadowing(mu, slope_variance):
    """Smith shadowing of the sea's wave facets: waveShadowing() in earthFragment.glsl"""
    with np.errstate(divide='ignore', invalid='ignore'):
        a = mu / np.sqrt(slope_variance * np.maximum(1 - mu * mu, 1e-6))
        lam = (1 - 1.259 * a + 0.396 * a * a) / (3.535 * a + 2.181 * a * a)
        return np.where(mu <= 0, 0.0, np.where(a >= 1.6, 1.0, 1 / (1 + lam)))


def srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, 12.92 * c, 1.055 * c ** (1 / 2.4) - 0.055)


def to_lin(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def noise_clouds(lon, lat, seed=3):
    """Cheap procedural cloud reflectance (0..0.85) for checking colors only."""
    rng = np.random.default_rng(seed)
    v = np.zeros_like(lon)
    for k in range(5):
        f = 2.0 ** k
        a = rng.uniform(0, 2 * np.pi, 4)
        v += (np.sin(f * 3 * lon + a[0] + 2 * np.sin(f * 2 * lat + a[1]))
              * np.cos(f * 2.3 * lat + a[2] + 2 * np.sin(f * 1.7 * lon + a[3]))) / f
    v = (v - 0.15) * 1.6
    return np.clip(v, 0, 0.85)


def render(width=1000, height=800, fov=45.0, cam_latlon=(10, -65), sun_latlon=(-12.7, -120),
           distance_scale=1.0, params=P, clouds=True, out='proto.png', old_model=False, look=(0.0, 0.0)):
    """Render the globe; cam_latlon and sun_latlon are the sub-camera and subsolar points."""
    from PIL import Image
    p = params
    R = p['R']
    top = R + p['top'] * p['heightScale']

    def latlon_vec(lat, lon):
        la, lo = np.radians(lat), np.radians(lon)
        return np.array([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)])

    up_cam = latlon_vec(*cam_latlon)
    sunDir = latlon_vec(*sun_latlon)
    # the disk should fill ~86% of the height, as in the screenshot
    dist = R / np.sin(np.radians(fov / 2) * 0.86) * distance_scale
    cam = up_cam * dist
    fwd = -up_cam
    right = np.cross(fwd, np.array([0, 0, 1.0]))
    right /= np.linalg.norm(right)
    upv = np.cross(right, fwd)
    # look: turn the camera (radians right, up) away from the Earth's center, e.g. toward the limb
    fwd = fwd + right * np.tan(look[0]) + upv * np.tan(look[1])
    fwd /= np.linalg.norm(fwd)
    right = np.cross(fwd, upv)
    right /= np.linalg.norm(right)
    upv = np.cross(right, fwd)
    ys, xs = np.mgrid[0:height, 0:width]
    ndc_x = (xs + 0.5) / width * 2 - 1
    ndc_y = 1 - (ys + 0.5) / height * 2
    tanf = np.tan(np.radians(fov / 2))
    aspect = width / height
    d = fwd[None, None] + right[None, None] * (ndc_x * tanf * aspect)[..., None] + upv[None, None] * (ndc_y * tanf)[..., None]
    d /= np.linalg.norm(d, axis=-1, keepdims=True)
    d = d.reshape(-1, 3)
    camv = np.broadcast_to(cam, d.shape)

    b = np.sum(camv * d, axis=-1)
    c = np.sum(cam * cam) - R * R
    disc = b * b - c
    hit = disc > 0
    t_hit = -b - np.sqrt(np.maximum(disc, 0))
    c_top = np.sum(cam * cam) - top * top
    disc_top = b * b - c_top
    t_enter = np.maximum(-b - np.sqrt(np.maximum(disc_top, 0)), 0)
    t_exit = -b + np.sqrt(np.maximum(disc_top, 0))
    in_shell = (disc_top > 0) & ~hit

    img = np.zeros((d.shape[0], 3))

    # ------------------------------------------------------------ surface
    Ph = camv[hit] + t_hit[hit, None] * d[hit]
    n = Ph / R
    mu0 = np.sum(n * sunDir, axis=-1)
    muV = np.sum(n * -d[hit], axis=-1)
    lat = np.arcsin(np.clip(n[:, 2], -1, 1))
    lon = np.arctan2(n[:, 1], n[:, 0])
    day = np.asarray(Image.open(f'{REPO}/static/BlueMarble_2048x1024.avif').convert('RGB')).astype(float) / 255
    spec = np.asarray(Image.open(f'{REPO}/static/EarthSpec_2048x1024.avif').convert('L')).astype(float) / 255
    px = ((lon + np.pi) / (2 * np.pi) * day.shape[1]).astype(int) % day.shape[1]
    py = np.clip(((np.pi / 2 - lat) / np.pi * day.shape[0]).astype(int), 0, day.shape[0] - 1)
    albedo = to_lin(day[py, px])
    ocean = spec[py, px]

    Tsun0, e_sky = ground_light(mu0, p)
    e_direct = Tsun0 * np.maximum(mu0, 0)[:, None]

    cloudR = noise_clouds(lon, lat) if clouds else np.zeros_like(lon)
    cloudR = cloudR[:, None]
    surface = albedo * (e_direct + e_sky)
    Tcloud = 1 - cloudR
    L = cloudR * (e_direct + e_sky) + surface * Tcloud * Tcloud / (1 - cloudR * albedo)

    # glint (Cox & Munk), lit by the direct sun color, fading as the waves shade each other
    hv = sunDir[None] - d[hit]
    hv /= np.linalg.norm(hv, axis=-1, keepdims=True)
    cosTilt = np.maximum(np.sum(n * hv, axis=-1), 1e-3)
    tan2 = (1 - cosTilt ** 2) / cosTilt ** 2
    var = 0.003 + 0.00512 * p['windSpeed']
    fres = 0.02 + 0.98 * (1 - np.clip(np.sum(hv * sunDir, axis=-1), 0, 1)) ** 5
    glint = fres * np.exp(-tan2 / var) * wave_shadowing(mu0, var) / (4 * var * cosTilt ** 4 * np.maximum(muV, 0.8))
    glint = 0.9 * (1 - np.exp(-glint / 0.9)) * (muV >= 0)
    glintL = (glint * ocean * p['glintBrightness'])[:, None] * Tsun0 * Tcloud * Tcloud
    # night lights (the Black Marble is an sRGB image), shown as the view adapts to the dark
    night = np.asarray(Image.open(f'{REPO}/static/BlackMarble_2048x1024.avif').convert('RGB')).astype(float) / 255
    gain, nightWeight = adaptation(e_direct + e_sky, p)
    if old_model:
        gain = np.ones_like(gain)
        nightWeight = 1 - np.clip((mu0 + np.sin(np.radians(12))) / np.sin(np.radians(12)), 0, 1)
        nightWeight = nightWeight * nightWeight * (3 - 2 * nightWeight)
    nightL = (to_lin(night[py, px]) * Tcloud + cloudR * p['nightCloudLight'] * np.array([0.6, 0.7, 1.0])) * nightWeight[:, None]

    if old_model:
        # the original shader's haze for comparison
        k = np.array([0.133, 0.197, 0.349])
        def airMass(mu):
            r = 758.0
            mu = np.maximum(mu, 0)
            return np.sqrt(r * r * mu * mu + 2 * r + 1) - r * mu
        path = (airMass(muV) - 1)[:, None] * 3.0
        T = np.exp(-k * path)
        ins = 0.4 * (1 - np.exp(-k * path / 5))
        img[hit] = (L + glintL + nightL) * T + ins
    else:
        Tv, ins = scatter_along(camv[hit], d[hit], t_enter[hit], t_hit[hit], sunDir, p, samples=p['samples'])
        # the glint is the sun's own image: the eye doesn't adapt to it
        img[hit] = (L * gain[:, None] + glintL + nightL) * Tv + ins

    # ------------------------------------------------------------ limb glow
    Tv, ins = scatter_along(camv[in_shell], d[in_shell], t_enter[in_shell], t_exit[in_shell], sunDir, p,
                            samples=12, towards_end=False)
    img[in_shell] = ins
    img *= p['exposure']
    out_img = (srgb(img.reshape(height, width, 3)) * 255).astype(np.uint8)
    Image.fromarray(out_img).save(out)
    return img.reshape(height, width, 3)


def twilight_table(p=P, reflectance=0.7, elevations=(30, 10, 3, 0, -2, -3, -4, -6)):
    """The table in docs/atmosphere-shader.md: against the sun's elevation (degrees), a cloud's
    displayed brightness (8-bit sRGB of the luminance of a cloud of the given reflectance, at the
    renderer's exposure, leaving out the air in front of it) with one exposure and with the
    observer's adaptation, the adaptation gain, and the night lights' weight."""
    mu0 = np.sin(np.radians(np.array(elevations, float)))
    t_sun, sky = ground_light(mu0, p)
    irradiance = t_sun * np.maximum(mu0, 0)[:, None] + sky
    gain, night = adaptation(irradiance, p)

    def shown(g):
        return [int(v) for v in np.round(srgb(reflectance * (irradiance @ LUMINANCE) * g * p['exposure']) * 255)]
    return {
        'one exposure': shown(1.0),
        'adapted': shown(gain),
        'gain': [round(float(g), 1) for g in gain],
        'night lights': [f'{w:.0%}' for w in night],
    }


if __name__ == '__main__':
    import json
    if len(sys.argv) > 1 and sys.argv[1] == 'twilight':
        for name, row in twilight_table().items():
            print(f'{name:14s}', row)
        sys.exit()
    overrides = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    out = sys.argv[2] if len(sys.argv) > 2 else 'proto.png'
    p = dict(P)
    for k, v in overrides.items():
        p[k] = np.array(v) if isinstance(v, list) else v
    old = overrides.get('old_model', False)
    render(params=p, out=out, old_model=old)
    print('wrote', out)
