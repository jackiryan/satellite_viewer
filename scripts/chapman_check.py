"""Check the table of air columns (src/atmosphereTable.js, read by airColumnsAt() in
src/shaders/common/atmosphere.glsl) against a direct numerical integration of an exponential
atmosphere, for the air-molecule (8 km) and aerosol (1.2 km) profiles, both stretched by the
default atmosphereHeightScale. The table is made and read as in scripts/atmosphere_prototype.py,
which mirrors the shader: the same integral, half-float storage and bilinear lookup, and rays
below the horizon from two lookups. Expect errors under about 0.1%.

Usage:  python scripts/chapman_check.py
"""
import numpy as np
import atmosphere_prototype as ap

P = ap.P
R = P['R']


def column_numeric(h, mu, H, n=200000):
    """Column from height h along cos(zenith) mu to space, in vertical columns from the ground,
    by the trapezoid rule along the ray out to where the air is down by e^-40 (inf if the ray
    meets the ground)."""
    r0 = R + h
    s_max = -r0 * mu + np.sqrt(r0 * r0 * mu * mu + (r0 + 40 * H) ** 2 - r0 * r0)
    s = np.linspace(0, s_max, n)
    altitude = np.sqrt(r0 * r0 + s * s + 2 * r0 * s * mu) - R
    if altitude.min() < 0:
        return np.inf
    return np.trapezoid(np.exp(-altitude / H), s) / H


if __name__ == '__main__':
    top = P['top'] * P['heightScale']
    worst = 0.0
    for profile, H in (('air molecules', P['rayleighHeight']), ('aerosol', P['mieHeight'])):
        H *= P['heightScale']
        index = 0 if profile == 'air molecules' else 1
        print(f'{profile}: scale height {H:g} km, top {top:g} km')
        for h in (0.0, 5.0, 30.0, 150.0):
            for mu in (1.0, 0.5, 0.2, 0.1, 0.05, 0.02, 0.0, -0.02, -0.05, -0.1, -0.2):
                exact = column_numeric(h, mu, H)
                table = float(ap.air_columns_at(np.array(h), np.array(mu), P)[index])
                if np.isfinite(exact):
                    err = (table / exact - 1) * 100
                    # (far above the ground the column is negligible, so its error doesn't matter)
                    if exact > 1e-4:
                        worst = max(worst, abs(err))
                    print(f'  h={h:5.0f} mu={mu:5.2f}  numeric {exact:11.5g}  table {table:11.5g}  err {err:6.3f}%')
                else:
                    print(f'  h={h:5.0f} mu={mu:5.2f}  meets the ground (table: {table:g})')
    print(f'largest error where the column is over 1e-4: {worst:.3f}%')
