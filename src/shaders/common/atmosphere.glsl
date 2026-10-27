/* atmosphere.glsl - the atmosphere model shared by the Earth and atmosphere shaders.
 *
 * Everything that gives the globe its colour from space is derived from one description of
 * the air: how much of it there is at each height, and how strongly it scatters and absorbs
 * each colour. Three things are computed from it, all with the same code so they agree:
 *
 *   sunTransmittance()   how much sunlight (per colour) reaches a point, after the air above it
 *   skyIrradiance()      the diffuse skylight falling on the ground
 *   scatterAlong()       for a view ray: how much of the light at its far end survives the air
 *                        in between (transmittance), and how much sunlight the air along it
 *                        scatters toward the camera (in-scatter). This is what makes the limb
 *                        blue-white and the ocean blue.
 *
 * The model is single scattering (sunlight scattered once toward the camera) in an atmosphere
 * of three parts, each with its own vertical optical depth per colour channel:
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
 * Optical depth along a ray uses the Chapman function (the exact integral of an exponential
 * atmosphere along a straight line on a sphere) via a rational fit, so there is no inner loop
 * over the path to the sun. The in-scatter integral is done per segment: the transmittance
 * across a segment is exact (from Chapman differences) and the scattered light is the light
 * that segment removes from the view path, times the sun's transmittance at its middle. That
 * keeps extinction and in-scatter consistent with each other, which the old haze was not.
 *
 * Uniforms are declared here, so both shaders get the same set (earth.js fills them from
 * `parameters`, see docs/atmosphere-shader.md).
 */

uniform vec3 sunDirection;          // unit vector toward the sun (scene frame)
uniform vec3 sunColor;              // colour and strength of sunlight at the top of the atmosphere
uniform float earthRadius;          // scene units
uniform float atmosphereHeightScale; // stretches the air's heights (not its optical depth), to make the limb glow visible
uniform vec3 rayleighDepth;         // vertical optical depth of Rayleigh scattering, per channel
uniform vec3 ozoneDepth;            // vertical optical depth of ozone absorption, per channel
uniform float mieDepth;             // vertical optical depth of aerosol (grey)
uniform float mieAlbedo;            // fraction of the light aerosols take from a beam that they scatter rather than absorb
uniform float mieAnisotropy;        // Henyey-Greenstein g of the aerosol phase function (0 = even, 1 = all forward)
uniform float multipleScattering;   // extra light from light scattered more than once, relative to single scattering
uniform float skylight;             // scales the diffuse skylight on the ground

const float PI = 3.14159265;
// Heights of the real atmosphere, as fractions of the Earth's radius (8 km, 1.2 km and the
// 100 km above which little air is left), scaled by atmosphereHeightScale.
const float RAYLEIGH_HEIGHT_RATIO = 8.0 / 6371.0;
const float MIE_HEIGHT_RATIO = 1.2 / 6371.0;
const float ATMOSPHERE_TOP_RATIO = 100.0 / 6371.0;

float rayleighHeight() { return earthRadius * RAYLEIGH_HEIGHT_RATIO * atmosphereHeightScale; }
float mieHeight() { return earthRadius * MIE_HEIGHT_RATIO * atmosphereHeightScale; }
float atmosphereTop() { return earthRadius * (1.0 + ATMOSPHERE_TOP_RATIO * atmosphereHeightScale); }

// Optical depth from altitude h along a ray at cos(zenith angle) mu to the top of an
// exponential atmosphere of scale height H, in units of the vertical optical depth: 1 straight
// up, about 35 along the horizon for H = 8 km. A rational fit to the Chapman function that is
// exact at the zenith and the horizon and within 6% in between (scripts/chapman_check.py).
// Rays going below the horizon (mu < 0) descend to their closest point to the Earth and climb
// out again; one that would reach the ground gets a huge depth (no light gets through).
float chapman(float h, float mu, float H) {
    h = max(h, 0.0);
    float r = earthRadius + h;
    float c = sqrt(0.5 * PI * r / H);
    float up = c / ((c - 1.0) * pow(abs(mu), 1.05) + 1.0) * exp(-h / H);
    if (mu >= 0.0) {
        return up;
    }
    float rt = r * sqrt(max(1.0 - mu * mu, 0.0));     // radius of the ray's closest approach
    float ht = rt - earthRadius;
    if (ht < 0.0) {
        return 1e9;
    }
    float ct = sqrt(0.5 * PI * rt / H);
    return 2.0 * ct * exp(-ht / H) - up;
}

// Air columns (in vertical optical depths) along the ray from `position` in direction `dir`
// to space: x for the Rayleigh profile (air molecules and ozone), y for the aerosol profile.
vec2 airColumns(vec3 position, vec3 dir) {
    float r = length(position);
    float h = r - earthRadius;
    float mu = dot(position, dir) / r;
    return vec2(chapman(h, mu, rayleighHeight()), chapman(h, mu, mieHeight()));
}

// Optical depth per colour channel for those columns: everything that takes light out of a beam
vec3 extinction(vec2 columns) {
    return (rayleighDepth + ozoneDepth) * columns.x + mieDepth * columns.y;
}

// Fraction of sunlight (per channel) that reaches `position`
vec3 sunTransmittance(vec3 position) {
    return exp(-extinction(airColumns(position, sunDirection)));
}

// Diffuse skylight on a horizontal surface at the ground with the sun at cos(zenith) mu0, as a
// fraction of the irradiance of the overhead sun (so it is on the same scale as the direct
// term T_sun * mu0). Of the sunlight scattered out of the direct beam on its way down, about
// half goes on downward; multiply by skylight to taste. It is blue, so shadows and the ground
// near the terminator take on the sky's colour.
vec3 skyIrradiance(float mu0) {
    float mu = max(mu0, 0.0);
    vec3 scatteredOut = 1.0 - exp(-(rayleighDepth * chapman(0.0, mu, rayleighHeight())
                                    + mieDepth * mieAlbedo * chapman(0.0, mu, mieHeight())));
    return skylight * 0.5 * scatteredOut * mu;
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
    float top = atmosphereTop();
    float b = dot(origin, dir);
    float disc = b * b - (dot(origin, origin) - top * top);
    if (disc < 0.0) {
        return -1.0;
    }
    return max(-b - sqrt(disc), 0.0);
}

#ifndef ATMOSPHERE_SAMPLES
#define ATMOSPHERE_SAMPLES 8
#endif

// Light along the view ray origin + t * dir between t0 (nearer the camera) and t1.
//   transmittance   fraction (per channel) of the light at t1 that reaches t0
//   inscatter       sunlight scattered toward the camera by the air in between, in radiance
//                   units (white Lambertian = 1), including the multiple-scattering boost
// towardEnd: true puts the samples closer together near t1 (a ray ending on the ground, where
// the air is densest); false bunches them about the middle (a ray grazing past the limb).
void scatterAlong(vec3 origin, vec3 dir, float t0, float t1, bool towardEnd,
                  out vec3 transmittance, out vec3 inscatter) {
    float cosTheta = dot(dir, sunDirection);
    vec3 scatterRayleigh = rayleighDepth / (rayleighDepth + ozoneDepth) * (PI * rayleighPhase(cosTheta));
    float scatterMie = mieAlbedo * (PI * miePhase(cosTheta));

    // Optical depth from the camera itself to space (non-zero only inside the atmosphere), so
    // that depths below are measured from the camera rather than from space.
    vec3 cameraDepth = extinction(airColumns(origin, -dir));

    // The first sample sits at t0: its depth back to the camera is (nearly) zero and its
    // transmittance 1 unless the camera is inside the atmosphere.
    vec2 prevColumns = airColumns(origin + dir * t0, -dir);
    vec3 prevT = exp(-max(extinction(prevColumns) - cameraDepth, 0.0));
    float prevDist = t0;
    inscatter = vec3(0.0);
    for (int i = 1; i <= ATMOSPHERE_SAMPLES; i++) {
        float s = float(i) / float(ATMOSPHERE_SAMPLES);
        float f = towardEnd ? 1.0 - (1.0 - s) * (1.0 - s)
                            : 0.5 + 2.0 * sign(s - 0.5) * (s - 0.5) * (s - 0.5);
        float dist = mix(t0, t1, f);

        // Depth from this point back to the camera, and the transmittance that gives
        vec2 columns = airColumns(origin + dir * dist, -dir);
        vec3 T = exp(-max(extinction(columns) - cameraDepth, 0.0));

        // The segment's share of each kind of air decides the colour of what it scatters; the
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
