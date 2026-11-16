/* atmosphere.glsl - the atmosphere model shared by the Earth and atmosphere shaders.
 *
 * Everything that gives the globe its color from space is derived from one description of
 * the air: how much of it there is at each height, and how strongly it scatters and absorbs
 * each color. Three things are computed from it, all with the same code so they agree:
 *
 *   sunTransmittance()   how much sunlight (per color) reaches a point, after the air above it
 *   skyIrradiance()      the diffuse skylight falling on the ground, including the twilight
 *                        that still lights it for a few degrees after sunset
 *   scatterAlong()       for a view ray: how much of the light at its far end survives the air
 *                        in between (transmittance), and how much sunlight the air along it
 *                        scatters toward the camera (in-scatter). This is what makes the limb
 *                        blue-white and the ocean blue.
 *
 * The model is single scattering (sunlight scattered once toward the camera) in an atmosphere
 * of three parts, each with its own vertical optical depth per color channel:
 *   Rayleigh   air molecules, scale height 8 km, scatter ~ 1/wavelength^4 (blue most)
 *   Mie        aerosol haze, scale height 1.2 km, grey, scatters mostly forward
 *   ozone      absorbs (mainly red here, the Chappuis band); given the Rayleigh profile
 * Light scattered more than once is added as a boost proportional to how much of the view
 * path's light was scattered at all (multipleScattering), which is where it matters: at the limb.
 *
 * Units: distances are scene units; radiance is in units where a white Lambertian surface under
 * overhead sunlight is 1.0 (so a texture albedo lit by sunColor = (1,1,1) at mu0 = 1 shows
 * unchanged). The in-scatter integral is therefore multiplied by pi.
 *
 * The amount of air along a ray to space (the Chapman function of an exponential atmosphere on
 * a sphere) comes from a table, airColumnTable, which src/atmosphereTable.js makes once by
 * integrating along each ray, so there is no inner loop over the path to the sun. The in-scatter
 * integral is done per segment: the transmittance across a segment is exact (from differences
 * of air columns) and the scattered light is the light that segment removes from the view path,
 * times the sun's transmittance at its middle. That keeps extinction and in-scatter consistent
 * with each other.
 *
 * Uniforms are declared here, so both shaders get the same set (earth.js fills them from
 * `parameters`, see docs/atmosphere-shader.md).
 */

uniform vec3 sunDirection;          // unit vector toward the sun (scene frame)
uniform vec3 sunColor;              // color and strength of sunlight at the top of the atmosphere
uniform float earthRadius;          // scene units
uniform float atmosphereTop;        // radius of the top of the atmosphere (set by atmosphereHeightScale)
uniform vec2 inverseScaleHeights;   // 1 / scale height of the Rayleigh and Mie profiles, per scene unit
uniform sampler2D airColumnTable;   // air columns along rays to space (src/atmosphereTable.js)
uniform vec2 airColumnTableSize;    // its width and height in texels (cheaper than textureSize())
uniform vec3 rayleighDepth;         // vertical optical depth of Rayleigh scattering, per channel
uniform vec3 ozoneDepth;            // vertical optical depth of ozone absorption, per channel
uniform float mieDepth;             // vertical optical depth of aerosol (grey)
uniform float mieAlbedo;            // fraction of the light aerosols take from a beam that they scatter rather than absorb
uniform float mieAnisotropy;        // Henyey-Greenstein g of the aerosol phase function (0 = even, 1 = all forward)
uniform float multipleScattering;   // extra light from light scattered more than once, relative to single scattering
uniform float skylight;             // scales the diffuse skylight on the ground
uniform float airglowRadius;        // radius of the peak of the airglow layer
uniform float airglowWidth;         // its thickness (one standard deviation of a Gaussian in height)
uniform vec3 airglowEmission;       // its light per scene unit of path at the peak (earth.js: airglowEmission())
uniform float airglowFade;          // sine of the sun's depression at which the airglow is at full strength

const float PI = 3.14159265;

// Air columns from height h along cos(zenith angle) mu >= 0 to space, in units of the vertical
// column from the ground (1 straight up from the ground, about 20 along the horizon for air
// molecules): x for the Rayleigh profile (air molecules and ozone), y for the aerosol profile.
// The table holds each column over exp(-h / H), the column straight up from h, in rows evenly
// spaced in height and columns spaced by sqrt(mu); the lookup puts the ground, the top, the
// horizon and the zenith on texel centers.
vec2 airColumnsUp(float h, float mu) {
    vec2 size = airColumnTableSize;
    vec2 coord = vec2(sqrt(clamp(mu, 0.0, 1.0)), clamp(h / (atmosphereTop - earthRadius), 0.0, 1.0));
    vec2 ratio = textureLod(airColumnTable, (coord * (size - 1.0) + 0.5) / size, 0.0).rg;
    return ratio * exp(-max(h, 0.0) * inverseScaleHeights);
}

// The same in any direction. A ray pointing below the horizon descends to its lowest point and
// climbs out again, so its column is twice the horizontal column from that lowest point, less
// the column up the mirror-image ray from h. One that reaches the ground gets a huge column (no
// light gets through).
vec2 airColumnsAt(float h, float mu) {
    if (mu >= 0.0) {
        return airColumnsUp(h, mu);
    }
    float lowest = (earthRadius + h) * sqrt(max(1.0 - mu * mu, 0.0)) - earthRadius;
    if (lowest < 0.0) {
        return vec2(1e9);
    }
    return 2.0 * airColumnsUp(lowest, 0.0) - airColumnsUp(h, -mu);
}

// Air columns along the ray from `position` in direction `dir` to space
vec2 airColumns(vec3 position, vec3 dir) {
    float r = length(position);
    return airColumnsAt(r - earthRadius, dot(position, dir) / r);
}

// Optical depth per color channel for those columns: everything that takes light out of a beam
vec3 extinction(vec2 columns) {
    return (rayleighDepth + ozoneDepth) * columns.x + mieDepth * columns.y;
}

// Fraction of sunlight (per channel) that reaches `position`
vec3 sunTransmittance(vec3 position) {
    return exp(-extinction(airColumns(position, sunDirection)));
}

// How the sky's light on the ground falls off as the sun goes down: mu0 for a high sun, and
// past sunset an exponential, e-folding every 0.02 in mu0 (about 1.1 degrees). With
// skyIrradiance() below this gives 0.6% of the overhead sun's illuminance at sunset, 0.005% at
// -6 degrees (the end of civil twilight) and nothing visible by -12, close to measured twilight
// illuminance (about 500, 3 and 0.01 lux against 100,000 lux at noon). This is what still
// lights the ground and clouds for a few degrees past the terminator.
const float TWILIGHT_WIDTH = 0.02;

float twilightMu(float mu0) {
    // softplus: smooth, equal to mu0 well above the horizon
    return mu0 > 0.0 ? mu0 + TWILIGHT_WIDTH * log(1.0 + exp(-mu0 / TWILIGHT_WIDTH))
                     : TWILIGHT_WIDTH * log(1.0 + exp(mu0 / TWILIGHT_WIDTH));
}

// Diffuse skylight on a horizontal surface at the ground with the sun at cos(zenith) mu0, as a
// fraction of the irradiance of the overhead sun (so it is on the same scale as the direct
// term T_sun * mu0). Of the sunlight scattered out of the direct beam on its way down, about
// half goes on downward; multiply by skylight to taste. It is blue, so shadows and the ground
// near the terminator take on the sky's color. The light has also crossed the ozone layer,
// which sits 20-30 km up and so has about half the Rayleigh air mass at sunset (17 rather than
// 35); its red absorption is what makes twilight (the "blue hour") blue.
// sunColumns: the air columns from the ground toward the sun, or along the horizon once it has
// set, airColumnsAt(0.0, max(mu0, 0.0)), which the Earth shader also uses for the direct beam.
vec3 skyIrradiance(float mu0, vec2 sunColumns) {
    vec3 scatteredOut = 1.0 - exp(-(rayleighDepth * sunColumns.x + mieDepth * mieAlbedo * sunColumns.y));
    vec3 ozone = exp(-0.5 * ozoneDepth * sunColumns.x);
    return skylight * 0.5 * scatteredOut * ozone * twilightMu(mu0);
}

// Scattering phase functions, normalised to integrate to 1 over the sphere; cosTheta is the
// cosine of the angle between the sunlight's direction of travel and the direction to the camera.
float rayleighPhase(float cosTheta) {
    return 3.0 / (16.0 * PI) * (1.0 + cosTheta * cosTheta);
}

float miePhase(float cosTheta) {
    float g = mieAnisotropy;
    float g2 = g * g;
    return (1.0 - g2) / (4.0 * PI * pow(1.0 + g2 - 2.0 * g * cosTheta, 1.5));
}

// Where the ray origin + t * dir enters the atmosphere (t = 0 if the origin is already inside).
// Returns a negative number if the ray misses the atmosphere entirely.
float atmosphereEntry(vec3 origin, vec3 dir) {
    float b = dot(origin, dir);
    float disc = b * b - (dot(origin, origin) - atmosphereTop * atmosphereTop);
    if (disc < 0.0) {
        return -1.0;
    }
    return max(-b - sqrt(disc), 0.0);
}

// Samples along a view ray. earth.js sets fewer on mobile devices (material.defines).
#ifndef ATMOSPHERE_SAMPLES
#define ATMOSPHERE_SAMPLES 8
#endif

// Light along the view ray origin + t * dir between t0, where it enters the atmosphere, and t1.
//   transmittance   fraction (per channel) of the light at t1 that reaches t0
//   inscatter       sunlight scattered toward the camera by the air in between, in radiance
//                   units (white Lambertian = 1), including the multiple-scattering boost
// towardEnd: true puts the samples closer together near t1 (a ray ending on the ground, where
// the air is densest); false bunches them about the middle (a ray grazing past the limb).
//
// The camera (the origin) is always outside the atmosphere: the controls keep it at least 7
// units from the Earth's center, and the top of the air is at 5.24 (it would only reach 7 with
// atmosphereHeightScale above about 26). So the light at t0 reaches the camera undimmed, and the
// air column from a point on the ray back toward the camera is the air between the two (the
// air above the top of the atmosphere is negligible).
void scatterAlong(vec3 origin, vec3 dir, float t0, float t1, bool towardEnd,
                  out vec3 transmittance, out vec3 inscatter) {
    float cosTheta = dot(dir, sunDirection);
    vec3 scatterRayleigh = rayleighDepth / (rayleighDepth + ozoneDepth) * (PI * rayleighPhase(cosTheta));
    float scatterMie = mieAlbedo * (PI * miePhase(cosTheta));

    vec2 prevColumns = vec2(0.0);
    vec3 prevT = vec3(1.0);
    float prevDist = t0;
    inscatter = vec3(0.0);
    for (int i = 1; i <= ATMOSPHERE_SAMPLES; i++) {
        float s = float(i) / float(ATMOSPHERE_SAMPLES);
        float f = towardEnd ? 1.0 - (1.0 - s) * (1.0 - s)
                            : 0.5 + 2.0 * sign(s - 0.5) * (s - 0.5) * (s - 0.5);
        float dist = mix(t0, t1, f);

        // The air from this point back to the camera, and the transmittance that gives
        vec2 columns = airColumns(origin + dir * dist, -dir);
        vec3 T = exp(-extinction(columns));

        // The segment's share of each kind of air decides the color of what it scatters; the
        // amount is what the segment removes from the view path (prevT - T), lit by the sun
        // at the segment's middle.
        vec2 seg = max(columns - prevColumns, 0.0);
        vec3 segRayleigh = (rayleighDepth + ozoneDepth) * seg.x;
        float segMie = mieDepth * seg.y;
        vec3 total = max(segRayleigh + segMie, 1e-7);
        vec3 scatterShare = (segRayleigh * scatterRayleigh + segMie * scatterMie) / total;

        vec3 midpoint = origin + dir * (0.5 * (prevDist + dist));
        inscatter += sunTransmittance(midpoint) * (prevT - T) * scatterShare;

        prevT = T;
        prevColumns = columns;
        prevDist = dist;
    }
    transmittance = prevT;
    inscatter *= sunColor * (1.0 + multipleScattering * (1.0 - transmittance));
}

/* Airglow. Oxygen atoms high in the atmosphere, split by sunlight during the day, recombine all
 * night and glow green (557.7 nm) in a layer about 10 km thick near 97 km. Looking straight down
 * through it the glow is faint, but seen edge-on, past the limb, the line of sight runs along the
 * layer for some 1500 km, which makes it the thin green line above the night side in photographs
 * from orbit. It is far too faint to see in daylight, and in reality only just visible to a
 * dark-adapted eye, so it is drawn at the brightness airglowBrightness sets, fading in over the
 * night side (airglowWeight). Its height is airglowHeight in earth.js, stretched by
 * atmosphereHeightScale with the rest of the air.
 *
 * The emission falls off as a Gaussian in height around airglowRadius. The layer is above nearly
 * all of the air, so its light reaches the camera undimmed, except from the far side of a line of
 * sight that passes below it, which has crossed the denser air in between.
 */

// How much of the airglow shows above the ground at `point`: none where the sun is up, rising
// smoothly to full where it is airglowFade (the sine of the angle) below the horizon. The eye
// sees the glow once it has adapted to the dark, so it comes in over the twilight band after
// sunset, gradually enough that the line fades out along the limb toward the day side rather
// than stopping.
float airglowWeight(vec3 point) {
    float muSun = dot(normalize(point), sunDirection);
    return smoothstep(0.0, airglowFade, -muSun);
}

// Path through the layer, weighted by its emission, of the half of a line of sight on one side
// of its closest point to the Earth's center (impact: that closest distance). The full line past
// the limb crosses the layer twice, symmetrically. The midpoint rule across the stretch where the
// line is within four widths of the peak is within 0.01% of the exact integral.
#define AIRGLOW_SAMPLES 10
float airglowHalfPath(float impact) {
    float d2 = impact * impact;
    float lower = airglowRadius - 4.0 * airglowWidth;
    float upper = airglowRadius + 4.0 * airglowWidth;
    float t0 = sqrt(max(lower * lower - d2, 0.0));
    float t1 = sqrt(max(upper * upper - d2, 0.0));
    float dt = (t1 - t0) / float(AIRGLOW_SAMPLES);
    float sum = 0.0;
    for (int i = 0; i < AIRGLOW_SAMPLES; i++) {
        float t = t0 + (float(i) + 0.5) * dt;
        float x = (sqrt(d2 + t * t) - airglowRadius) / airglowWidth;
        sum += exp(-0.5 * x * x);
    }
    return sum * dt;
}

// The same for a line of sight that ends on the ground, which crosses the layer once, at
// cos(zenith) mu = sqrt(1 - (impact / airglowRadius)^2). For any line that meets the ground
// that is at least about sqrt(2 h / R) for a layer at height h (0.25 with the defaults), steep
// enough for the layer to count as flat: the path is its thickness sqrt(2 pi) * airglowWidth
// over mu, within 0.1% of airglowHalfPath() at the edge of the disk.
float airglowGroundPath(float impact) {
    float ratio = impact / airglowRadius;
    float mu = sqrt(max(1.0 - ratio * ratio, 0.0));
    return sqrt(2.0 * PI) * airglowWidth / max(mu, 0.1);
}

// Half an 8-bit level of noise per pixel (interleaved gradient noise, Jimenez 2014), added after
// the output color conversion. The twilight and the glow beyond the limb are smooth gradients
// across only a few levels of the display, which otherwise show as bands.
vec3 ditherOutput(vec3 color) {
    float noise = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    return color + (noise - 0.5) / 255.0;
}
