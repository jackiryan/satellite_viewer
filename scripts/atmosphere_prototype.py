"""Numpy port of the Earth and atmosphere shaders, for checking colours without the app.

Mirrors src/shaders/common/atmosphere.glsl and the lighting in earthFragment.glsl one-to-one
(same Chapman fit, same per-segment in-scatter, same sample placement), renders the globe with
the repository's Blue Marble textures, procedural clouds (for colour only; their shapes are
made up) and the Black Marble at night, and writes a PNG. See docs/atmosphere-shader.md.

Usage:  python scripts/atmosphere_prototype.py                      # defaults -> proto.png
        python scripts/atmosphere_prototype.py '{"mieDepth": 0.15}' out.png
        python scripts/atmosphere_prototype.py '{"old_model": true}' old.png   # the previous haze

Parameters are the same names as in earth.js (km instead of scene units). Radiance units: a
white Lambertian surface under the overhead sun is 1.0. Requires numpy and Pillow with AVIF.
"""
import os
import sys
import numpy as np
from PIL import Image

REPO = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')

# ---------------------------------------------------------------- parameters (km, linear sRGB)
P = dict(
    R=6371.0,
    heightScale=3.0,                 # inflates the atmosphere's thickness (not its optical depth)
    rayleighHeight=8.0,
    mieHeight=1.2,
    top=100.0,                        # where the atmosphere is cut off
    rayleighDepth=np.array([0.051, 0.099, 0.238]),   # vertical OD at the sRGB primaries' wavelengths
    ozoneDepth=np.array([0.040, 0.015, 0.0]),      # absorption, folded into the Rayleigh profile
    mieDepth=0.08,
    mieAlbedo=0.9,
    mieG=0.76,
    multipleScattering=1.0,
    skylight=1.0,
    sunIntensity=1.0,
    exposure=1.3,
    cloudShadowAmbient=0.3,
    glintBrightness=0.75,
    windSpeed=7.5,
)


def chapman(h, mu, H, R):
    """Optical depth from altitude h along cos(zenith) mu to space, in units of the vertical OD.
    Vectorised; returns inf where the ray hits the ground."""
    h = np.asarray(h, dtype=float)
    mu = np.asarray(mu, dtype=float)
    X = (R + h) / H
    c = np.sqrt(np.pi * X / 2)
    p = 1.05
    up = c / ((c - 1) * np.abs(mu) ** p + 1) * np.exp(-h / H)
    sin = np.sqrt(np.clip(1 - mu * mu, 0, 1))
    rt = (R + h) * sin
    ht = rt - R
    ct = np.sqrt(np.pi * rt / H / 2)
    down = 2 * ct * np.exp(-np.maximum(ht, 0) / H) - up
    res = np.where(mu >= 0, up, np.where(ht >= 0, down, np.inf))
    return res


def depths(pos, direction, p):
    """Optical depth (per channel) from pos along direction to space: Rayleigh+ozone, Mie."""
    r = np.linalg.norm(pos, axis=-1)
    h = r - p['R']
    mu = np.sum(pos * direction, axis=-1) / r
    hs = p['heightScale']
    chR = chapman(h, mu, p['rayleighHeight'] * hs, p['R'])[..., None]
    chM = chapman(h, mu, p['mieHeight'] * hs, p['R'])[..., None]
    dR = (p['rayleighDepth'] + p['ozoneDepth']) * chR
    dM = p['mieDepth'] * chM
    return dR, dM


def transmittance(pos, direction, p):
    dR, dM = depths(pos, direction, p)
    return np.exp(-(dR + dM))


def phase_rayleigh(cosTheta):
    return 3 / (16 * np.pi) * (1 + cosTheta * cosTheta)


def phase_hg(cosTheta, g):
    return (1 - g * g) / (4 * np.pi * (1 + g * g - 2 * g * cosTheta) ** 1.5)


def scatter_along(cam, direction, t0, t1, sunDir, p, samples=8, towards_end=True):
    """Transmittance and in-scattered sunlight (display units) along the ray cam + t*direction,
    from t0 to t1 (t1 nearer the end of the ray). Samples are placed closer together near the
    end of the segment when towards_end (surface hits), symmetric about the middle otherwise."""
    n = t0.shape[0]
    cosTheta = np.sum(direction * sunDir, axis=-1)[:, None]
    pR = phase_rayleigh(cosTheta) * np.pi
    pM = phase_hg(cosTheta, p['mieG']) * np.pi
    omegaR = p['rayleighDepth'] / (p['rayleighDepth'] + p['ozoneDepth'])
    # optical depth from the camera itself (nonzero only if it is inside the atmosphere)
    dRcam, dMcam = depths(cam, -direction, p)

    s = np.linspace(0, 1, samples + 1)
    if towards_end:
        f = 1 - (1 - s) ** 2
    else:
        f = 0.5 + 0.5 * np.sign(s - 0.5) * (2 * np.abs(s - 0.5)) ** 2
    ts = t0[:, None] + (t1 - t0)[:, None] * f[None, :]

    inscatter = np.zeros((n, 3))
    prevT = np.ones((n, 3))
    prevDR = None
    for i in range(samples + 1):
        pos = cam + ts[:, i:i + 1] * direction
        dR, dM = depths(pos, -direction, p)
        dR = np.maximum(dR - dRcam, 0)
        dM = np.maximum(dM - dMcam, 0)
        T = np.exp(-(dR + dM))
        if i > 0:
            mid = cam + 0.5 * (ts[:, i - 1:i] + ts[:, i:i + 1]) * direction
            Tsun = transmittance(mid, sunDir, p)
            segR = dR - prevDR
            segM = dM - prevDM
            tot = np.maximum(segR + segM, 1e-9)
            wR = segR / tot
            wM = segM / tot
            inscatter += Tsun * (prevT - T) * (wR * omegaR * pR + wM * p['mieAlbedo'] * pM)
        prevT, prevDR, prevDM = T, dR, dM
    Tview = prevT
    inscatter *= p['sunIntensity'] * (1 + p['multipleScattering'] * (1 - Tview))
    return Tview, inscatter


def srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, 12.92 * c, 1.055 * c ** (1 / 2.4) - 0.055)


def to_lin(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def noise_clouds(lon, lat, seed=3):
    """Cheap procedural cloud reflectance (0..0.85) for checking colours only."""
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
           distance_scale=1.0, params=P, clouds=True, out='proto.png', old_model=False):
    """Render the globe; cam_latlon and sun_latlon are the sub-camera and subsolar points."""
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

    Tsun0 = transmittance(Ph, sunDir, p)
    Tsun0 = np.where(mu0[:, None] > 0, Tsun0, 0)
    # sky irradiance: half the sunlight scattered out of the direct beam, times the cosine
    scatDepth = p['rayleighDepth'] + p['mieDepth'] * p['mieAlbedo']
    chs = chapman(0.0, np.maximum(mu0, 0), p['rayleighHeight'] * p['heightScale'], R)[:, None]
    e_sky = p['skylight'] * 0.5 * (1 - np.exp(-scatDepth * chs)) * np.maximum(mu0, 0)[:, None]
    e_direct = Tsun0 * np.maximum(mu0, 0)[:, None]

    cloudR = noise_clouds(lon, lat) if clouds else np.zeros_like(lon)
    cloudR = cloudR[:, None]
    surface = albedo * (e_direct + e_sky)
    Tcloud = 1 - cloudR
    L = cloudR * (e_direct + e_sky) + surface * Tcloud * Tcloud / (1 - cloudR * albedo)

    # glint (Cox & Munk), lit by the direct sun colour
    hv = sunDir[None] - d[hit]
    hv /= np.linalg.norm(hv, axis=-1, keepdims=True)
    cosTilt = np.maximum(np.sum(n * hv, axis=-1), 1e-3)
    tan2 = (1 - cosTilt ** 2) / cosTilt ** 2
    var = 0.003 + 0.00512 * p['windSpeed']
    fres = 0.02 + 0.98 * (1 - np.clip(np.sum(hv * sunDir, axis=-1), 0, 1)) ** 5
    glint = fres * np.exp(-tan2 / var) / (4 * var * cosTilt ** 4 * np.maximum(muV, 0.8))
    glint = 0.9 * (1 - np.exp(-glint / 0.9)) * (mu0 > 0)
    L += (glint * ocean * p['glintBrightness'])[:, None] * Tsun0 * Tcloud * Tcloud
    # night lights, fading in past the terminator (the Black Marble is an sRGB image)
    night = np.asarray(Image.open(f'{REPO}/static/BlackMarble_2048x1024.avif').convert('RGB')).astype(float) / 255
    nightMix = 1 - np.clip((mu0 + np.sin(np.radians(12))) / np.sin(np.radians(12)), 0, 1)
    nightMix = nightMix * nightMix * (3 - 2 * nightMix)
    L += to_lin(night[py, px]) * Tcloud * nightMix[:, None]

    if old_model:
        # the current shader's haze for comparison
        k = np.array([0.133, 0.197, 0.349])
        def airMass(mu):
            r = 758.0
            mu = np.maximum(mu, 0)
            return np.sqrt(r * r * mu * mu + 2 * r + 1) - r * mu
        path = (airMass(muV) - 1)[:, None] * 3.0
        T = np.exp(-k * path)
        ins = 0.4 * (1 - np.exp(-k * path / 5))
        img[hit] = L * T + ins
    else:
        Tv, ins = scatter_along(camv[hit], d[hit], t_enter[hit], t_hit[hit], sunDir, p, samples=8)
        img[hit] = L * Tv + ins

    # ------------------------------------------------------------ limb glow
    Tv, ins = scatter_along(camv[in_shell], d[in_shell], t_enter[in_shell], t_exit[in_shell], sunDir, p,
                            samples=12, towards_end=False)
    img[in_shell] = ins
    img *= p['exposure']
    out_img = (srgb(img.reshape(height, width, 3)) * 255).astype(np.uint8)
    Image.fromarray(out_img).save(out)
    return img.reshape(height, width, 3)


if __name__ == '__main__':
    import json
    overrides = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    out = sys.argv[2] if len(sys.argv) > 2 else 'proto.png'
    p = dict(P)
    for k, v in overrides.items():
        p[k] = np.array(v) if isinstance(v, list) else v
    old = overrides.get('old_model', False)
    render(params=p, out=out, old_model=old)
    print('wrote', out)
