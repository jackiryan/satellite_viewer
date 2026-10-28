/* atmosphereTable.js - the shape of the air, and the table of air columns the atmosphere shaders
 * look up (common/atmosphere.glsl).
 *
 * The air is two exponential profiles: air molecules (Rayleigh scattering and ozone), with a
 * scale height of 8 km, and aerosol haze (Mie), with 1.2 km. How much of each lies along a
 * straight ray from a point to space (its column, in units of the vertical column from the
 * ground) depends only on the point's height h and the cosine mu of the ray's angle from the
 * vertical: this is the Chapman function. The shaders need it about 20 times per pixel, so it is
 * worked out here once, by numerical integration, for heights from the ground to the top of the
 * atmosphere and mu from 0 (horizontal) to 1 (straight up). The shader builds rays that point
 * below the horizon from two lookups.
 *
 * A texel holds the column divided by exp(-h / H), the column straight up from that height. That
 * ratio is 1 straight up and grows smoothly toward the horizon (to ~20 for air molecules and ~50
 * for aerosol with the default atmosphereHeightScale), and it barely changes with height, so a
 * small table interpolates it to within 0.1%. The column itself falls by a factor e every scale
 * height, too fast to interpolate between rows, so the shader multiplies the exponential back in.
 * Columns run along the texture's width, spaced by the square root of mu so they are closest
 * together near the horizon, where the column changes fastest; heights run evenly up its height.
 * scripts/chapman_check.py checks the table against direct integration.
 */
import * as THREE from 'three';

const EARTH_RADIUS_KM = 6371;
// Scale heights of the two profiles, and the height above which so little air is left that the
// atmosphere is cut off, in km; atmosphereHeightScale stretches all three
const RAYLEIGH_SCALE_HEIGHT_KM = 8;
const MIE_SCALE_HEIGHT_KM = 1.2;
const ATMOSPHERE_TOP_KM = 100;

// Texels across (mu) and down (height). The ratio changes so little with height that 16 rows
// interpolate it as well as 64.
const TABLE_WIDTH = 256;
const TABLE_HEIGHT = 16;

// The atmosphere's dimensions in scene units for a globe of the given radius:
//   top                  radius of the top of the atmosphere
//   inverseScaleHeights  1 / scale height of the Rayleigh and Mie profiles
export function atmosphereShape(radius, heightScale) {
    const kmToScene = radius / EARTH_RADIUS_KM * heightScale;
    return {
        top: radius + ATMOSPHERE_TOP_KM * kmToScene,
        inverseScaleHeights: new THREE.Vector2(
            1 / (RAYLEIGH_SCALE_HEIGHT_KM * kmToScene),
            1 / (MIE_SCALE_HEIGHT_KM * kmToScene))
    };
}

// The table for a globe of the given radius and atmosphereHeightScale, as a half-float RG texture
// (red: Rayleigh profile, green: Mie). It takes a few milliseconds.
export function createAirColumnTable(radius, heightScale) {
    const { top, inverseScaleHeights } = atmosphereShape(radius, heightScale);
    const scaleHeights = [1 / inverseScaleHeights.x, 1 / inverseScaleHeights.y];
    const [nodes, weights] = gaussLegendre(32);
    const data = new Uint16Array(TABLE_WIDTH * TABLE_HEIGHT * 2);
    for (let row = 0; row < TABLE_HEIGHT; row++) {
        const r = radius + (top - radius) * row / (TABLE_HEIGHT - 1);
        for (let column = 0; column < TABLE_WIDTH; column++) {
            const u = column / (TABLE_WIDTH - 1);
            const mu = u * u;
            const texel = (row * TABLE_WIDTH + column) * 2;
            data[texel] = THREE.DataUtils.toHalfFloat(columnRatio(r, mu, scaleHeights[0], nodes, weights));
            data[texel + 1] = THREE.DataUtils.toHalfFloat(columnRatio(r, mu, scaleHeights[1], nodes, weights));
        }
    }
    const texture = new THREE.DataTexture(data, TABLE_WIDTH, TABLE_HEIGHT, THREE.RGFormat, THREE.HalfFloatType);
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    return texture;
}

// Column along cos(zenith) mu >= 0 from radius r, over the column straight up from r, for an
// exponential profile of scale height H. With a the height gained along the ray, the column is
// the integral of exp(-a / H) ds / H. Substituting a = H t^2 turns that into the integral over t
// of 2 t (r + a) / sqrt(r^2 mu^2 + a (2 r + a)) exp(-t^2), which is 1 straight up and
// sqrt(pi r / 2 H) along the horizon. Near the horizon the first factor climbs from 0 to its full
// value within t ~ tc = mu sqrt(r / 2 H), and t = tc sinh(v) spreads that over the integration
// points, so 32-point Gauss-Legendre in v is good to a few parts per million at every mu.
// The integral stops at t^2 = 40, where the density is down by e^-40.
function columnRatio(r, mu, H, nodes, weights) {
    const tc = Math.max(mu * Math.sqrt(r / (2 * H)), 1e-6);
    const vMax = Math.asinh(Math.sqrt(40) / tc);
    let sum = 0;
    for (let i = 0; i < nodes.length; i++) {
        const v = 0.5 * vMax * (nodes[i] + 1);
        const t = tc * Math.sinh(v);
        const dt = tc * Math.cosh(v) * 0.5 * vMax * weights[i];
        const a = H * t * t;
        sum += dt * Math.exp(-t * t) * 2 * t * (r + a) / Math.sqrt(r * r * mu * mu + a * (2 * r + a));
    }
    return sum;
}

// Nodes and weights of n-point Gauss-Legendre quadrature on [-1, 1] (Newton's method on the
// Legendre polynomial P_n)
function gaussLegendre(n) {
    const nodes = new Float64Array(n);
    const weights = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        let x = Math.cos(Math.PI * (i + 0.75) / (n + 0.5));
        let derivative = 1;
        for (let iteration = 0; iteration < 100; iteration++) {
            let previous = 1;
            let p = x;
            for (let k = 2; k <= n; k++) {
                const next = ((2 * k - 1) * x * p - (k - 1) * previous) / k;
                previous = p;
                p = next;
            }
            derivative = n * (x * p - previous) / (x * x - 1);
            const step = p / derivative;
            x -= step;
            if (Math.abs(step) < 1e-15) break;
        }
        nodes[i] = x;
        weights[i] = 2 / ((1 - x * x) * derivative * derivative);
    }
    return [nodes, weights];
}
