"""Check the Chapman-function fit in src/shaders/common/atmosphere.glsl (chapman()) against a
direct numerical integration of an exponential atmosphere, for the Rayleigh (8 km) and aerosol
(1.2 km) scale heights. The fit is exact at the zenith and the horizon and within about 6%
between; the exponent 1.05 was chosen to minimise that error."""
import numpy as np

R = 6371.0


def od_numeric(h, mu, H, n=200000):
    """Optical depth (in units of vertical OD) from altitude h along cos(zenith)=mu to space."""
    r0 = R + h
    # ray: p(s) = (0, r0) + s*(sin, cos) ; altitude = |p| - R
    s_max = 4000.0 if mu < 0.2 else 1500.0
    s = np.linspace(0, s_max, n)
    sin = np.sqrt(max(1 - mu * mu, 0))
    r = np.sqrt((s * sin) ** 2 + (r0 + s * mu) ** 2)
    alt = r - R
    if alt.min() < 0:
        return np.inf
    rho = np.exp(-alt / H)
    return np.trapezoid(rho, s) / H


def chapman_approx(h, mu, H):
    X = (R + h) / H
    c = np.sqrt(np.pi * X / 2)
    if mu >= 0:
        return c / ((c - 1) * mu ** 1.05 + 1) * np.exp(-h / H)
    sin = np.sqrt(1 - mu * mu)
    rt = (R + h) * sin
    ht = rt - R
    if ht < 0:
        return np.inf
    Xt = rt / H
    ct = np.sqrt(np.pi * Xt / 2)
    return 2 * ct * np.exp(-ht / H) - c / ((c - 1) * (-mu) ** 1.05 + 1) * np.exp(-h / H)


for H in (8.0, 1.2):
    print(f"H = {H} km")
    for h in (0.0, 5.0, 20.0):
        for mu in (1.0, 0.5, 0.2, 0.1, 0.05, 0.0, -0.02, -0.05):
            a = od_numeric(h, mu, H)
            b = chapman_approx(h, mu, H)
            err = (b / a - 1) * 100 if np.isfinite(a) and np.isfinite(b) else float('nan')
            print(f"  h={h:4.0f} mu={mu:6.2f}  numeric {a:10.3f}  approx {b:10.3f}  err {err:6.1f}%")
