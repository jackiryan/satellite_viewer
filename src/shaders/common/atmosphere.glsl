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
uniform float airglowRadius;        // radius of the peak of the green (oxygen) airglow layer
uniform float airglowWidth;         // its thickness, and the sodium layer's (one standard deviation of a Gaussian in height)
uniform vec3 airglowEmission;       // its light per scene unit of path at the peak (earth.js: airglowEmissions())
uniform float airglowSodiumRadius;  // radius of the peak of the sodium layer, just below it
uniform vec3 airglowSodiumEmission; // its light per scene unit of path at the peak
uniform float airglowRedRadius;     // radius of the peak of the red (oxygen) layer, high in the thermosphere
uniform float airglowRedScale;      // its scale height (a Chapman layer)
uniform vec3 airglowRedEmission;    // its light per scene unit of path at the peak
uniform float airglowFade;          // sine of the sun's depression at which the airglow is at full strength
uniform float airglowAdaptation;    // how far the eye has adapted to the dark: 0 with any of the day side in view (earth.js: nightView())
uniform sampler2D airglowNoise;     // white noise for tanoise() (earth.js: createAirglowNoise())
uniform mat3 airglowMagneticFrame;  // turns a scene direction into the Earth's magnetic frame (y: the dipole axis, north)
uniform vec3 airglowDusk;           // unit vector toward the point on the equator where the sun is setting
uniform vec2 airglowRedTime;        // the time coordinate of each octave of the red layer's noise
uniform float airglowRedStructure;  // how patchy the red layer is (0 = smooth)
uniform float airglowRedArcs;       // brightness of its two equatorial arcs, relative to the layer around them

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

/* Airglow. Atoms high in the atmosphere, split or excited by sunlight during the day, give the
 * energy back as light all night. Three layers of it show in photographs from orbit:
 *
 *   green    oxygen atoms recombining (557.7 nm), in a layer about 10 km thick near 97 km: the
 *            thin green line above the night side
 *   sodium   sodium atoms left by meteors, excited by ozone (589 nm), in a layer as thick near
 *            90 km: an amber band just under the green line, so the two together run from amber
 *            at the bottom through yellow to green at the top
 *   red      oxygen atoms again (630 nm), where the ionosphere recombines, 200-300 km up in the
 *            thermosphere. The air there is thin enough for the atoms to radiate before a
 *            collision takes the energy; lower down collisions win, so the layer has a fairly
 *            sharp floor and thins out slowly upward: a wide, faint red haze well clear of the
 *            other two
 *
 * Looking straight down through a layer its glow is faint, but seen edge-on, past the limb, the
 * line of sight runs along it for a thousand kilometers or more. It is all far too faint to see
 * in daylight, and in reality only just visible to a dark-adapted eye, so each layer is drawn at
 * the brightness its parameter sets, and only once the camera is behind the Earth with nothing
 * but its night side in view, fading in over the night side (airglowWeight). The heights
 * are parameters in earth.js, stretched by atmosphereHeightScale with the rest of the air.
 *
 * The green and sodium emission falls off as a Gaussian in height around the layer's peak. The
 * red is a Chapman layer, exp(1 - z - exp(-z)) with z the height above the peak in scale
 * heights. The layers are above nearly all of the air, so their light reaches the camera
 * undimmed, except from the far side of a line of sight that passes below them, which has
 * crossed the denser air in between.
 *
 * The green and sodium layers are even. The red one is not: it is the glow of the ionosphere,
 * which is patchy over hundreds to thousands of km, drawn out along lines of magnetic latitude
 * and slowly changing, and brightest in two arcs either side of the magnetic equator in the
 * evening (airglowRedPatches).
 */

/* tanoise by Charles Lohr (cnlohr): smooth noise from a single lookup in a small texture of white
 * noise (https://github.com/cnlohr/shadertrixx, Assets/cnlohr/Shaders/tanoise; MIT license). This
 * is its tanoise4_1d(), for GLSL.
 *
 * Value noise in 4D blends the random values at the 16 corners of a lattice cell. The texture
 * holds a random value per texel in red; bilinear filtering does the blend in x and y. Green
 * holds the same values shifted by TANOISE_Z texels, so it is what red would give one cell up in
 * z, and blue and alpha are red and green shifted by TANOISE_W, for one cell up in w: one lookup
 * returns the four x-y blends, which are then blended in z and w. The smoothstep on the fraction
 * hides the creases linear blending would leave at the cell edges, and turning x by TANOISE_M
 * first keeps the lattice from showing along the axes.
 *
 * Here w is time, and is left out of the turn, so that the noise changes in place instead of
 * drifting, and repeats exactly every 64 units of w (the texture's size), where earth.js wraps it.
 * Returns 0 to 1.
 */
const mat3 TANOISE_M = mat3(-0.071301,  0.494967, -0.757557,
                             0.494967,  0.388720,  0.303345,
                            -0.757557,  0.303345,  0.497523);
const vec2 TANOISE_Z = vec2(51.0, 111.0);
const vec2 TANOISE_W = vec2(103.0, 61.0);
const float TANOISE_SIZE = 64.0;    // texels across the noise texture

float tanoise(vec3 x, float w) {
    vec4 c = vec4(TANOISE_M * x, w);
    vec4 cell = floor(c);
    vec4 f = c - cell;
    f = f * f * (3.0 - 2.0 * f);
    vec2 uv = cell.xy + cell.z * TANOISE_Z + cell.w * TANOISE_W + f.xy;
    vec4 corners = textureLod(airglowNoise, (uv + 0.5) / TANOISE_SIZE, 0.0);
    return mix(mix(corners.r, corners.g, f.z), mix(corners.b, corners.a, f.z), f.w);
}

// How much of the airglow shows above the ground at `point`: none where the sun is up, rising
// smoothly to full where it is airglowFade (the sine of the angle) below the horizon. The eye
// sees the glow once it has adapted to the dark, so it comes in over the twilight band after
// sunset, gradually enough that the lines fade out along the limb toward the day side rather
// than stopping. And the eye only adapts to the dark with nothing sunlit in front of it, so
// there is no airglow at all until the night side is all of the globe that is in view
// (airglowAdaptation, the same for every pixel: with it at 0, the shaders skip the airglow).
float airglowWeight(vec3 point) {
    float muSun = dot(normalize(point), sunDirection);
    return airglowAdaptation * smoothstep(0.0, airglowFade, -muSun);
}

/* The red layer's patchiness over the ground in the direction `up` (a unit vector from the
 * Earth's center): x is the logarithm of its brightness there relative to the even layer, y the
 * brightening of the equatorial arcs on top of that (a factor, 1 away from them).
 *
 * The patches are two octaves of noise in the Earth's magnetic frame, so they turn with the
 * Earth, and change in place over time (airglowRedTime). The frame's y is the sine of the
 * magnetic latitude, along which the lattice is finer (AIRGLOW_RED_GRAIN: cells per Earth radius),
 * so the patches come out some 2500 km long east to west and 1000 km north to south, as the
 * ionosphere's structure, which the Earth's field organises, tends to be. They are taken from the
 * direction alone, so each stands the full height of the layer. The noise is the logarithm of the
 * brightness, which so varies by a factor of several either way. Where the layer is brighter it
 * is also lower (AIRGLOW_RED_SINK), as the real one is: the glow comes from the bottom of the
 * ionosphere, and is stronger where that has sunk into denser air.
 *
 * The arcs are the equatorial anomaly: the daytime ionosphere is lifted over the magnetic
 * equator and drains down the field lines either side, into two crests about 15 degrees of
 * magnetic latitude from it. After sunset they are the brightest red airglow there is, fading
 * through the night as the ionosphere recombines. Here: a smooth bump in the sine of the
 * magnetic latitude about each crest, 13 degrees wide at half its height, at full strength at
 * dusk and gone by dawn.
 */
const vec3 AIRGLOW_RED_GRAIN = vec3(2.5, 6.0, 2.5);
const float AIRGLOW_RED_CONTRAST = 6.0;     // range of the logarithm of the brightness, at airglowRedStructure 1
const float AIRGLOW_RED_SINK = 0.4;         // scale heights the layer sinks per unit of that logarithm
const float AIRGLOW_ARC_LATITUDE = 0.26;    // sine of the crests' magnetic latitude
const float AIRGLOW_ARC_WIDTH = 0.2;        // from a crest to where its arc ends, likewise

vec2 airglowRedPatches(vec3 up) {
    vec3 magnetic = airglowMagneticFrame * up;
    vec3 x = magnetic * AIRGLOW_RED_GRAIN;
    float noise = 0.55 * tanoise(x, airglowRedTime.x) + 0.45 * tanoise(3.1 * x, airglowRedTime.y) - 0.5;

    float fromCrest = (abs(magnetic.y) - AIRGLOW_ARC_LATITUDE) / AIRGLOW_ARC_WIDTH;
    float arc = max(1.0 - fromCrest * fromCrest, 0.0);
    float evening = smoothstep(-0.6, 0.8, dot(up, airglowDusk));

    return vec2(AIRGLOW_RED_CONTRAST * airglowRedStructure * noise,
                1.0 + airglowRedArcs * arc * arc * evening);
}

// The red layer's profile is followed from 3.5 scale heights below its peak (where it is nothing,
// even where the layer has sunk) to 7 above (0.25% of the peak)
const float AIRGLOW_RED_BELOW = 3.5;
const float AIRGLOW_RED_ABOVE = 7.0;

// Light of the green and sodium layers along the half of a line of sight on one side of its
// closest point to the Earth's center (impact: that closest distance). The full line past the
// limb crosses each layer twice, symmetrically. The two layers overlap, so one set of samples
// covers both: the midpoint rule across the stretch where the line is within four widths of
// either peak, which is within 0.01% of the exact integral.
#define AIRGLOW_SAMPLES 12
vec3 airglowHalfLine(float impact) {
    float d2 = impact * impact;
    float lower = min(airglowRadius, airglowSodiumRadius) - 4.0 * airglowWidth;
    float upper = max(airglowRadius, airglowSodiumRadius) + 4.0 * airglowWidth;
    float t0 = sqrt(max(lower * lower - d2, 0.0));
    float t1 = sqrt(max(upper * upper - d2, 0.0));
    float dt = (t1 - t0) / float(AIRGLOW_SAMPLES);
    vec2 sum = vec2(0.0);   // green, sodium
    for (int i = 0; i < AIRGLOW_SAMPLES; i++) {
        float t = t0 + (float(i) + 0.5) * dt;
        vec2 x = (sqrt(d2 + t * t) - vec2(airglowRadius, airglowSodiumRadius)) / airglowWidth;
        sum += exp(-0.5 * x * x);
    }
    return (airglowEmission * sum.x + airglowSodiumEmission * sum.y) * dt;
}

// Light of the red layer along the line of sight through `closest`, its closest point to the
// Earth's center, in direction `dir`: x from the half on the camera's side of that point, y from
// the half beyond it. The layer is patchy, so the halves differ, and each is sampled where it
// runs (the layer is ten times as thick as the other two, and takes fewer samples a side: for
// the even layer they are within 1.5% of the exact integral).
#define AIRGLOW_RED_SAMPLES 6
vec2 airglowRedLine(vec3 closest, vec3 dir) {
    float d2 = dot(closest, closest);
    float lower = airglowRedRadius - AIRGLOW_RED_BELOW * airglowRedScale;
    float upper = airglowRedRadius + AIRGLOW_RED_ABOVE * airglowRedScale;
    float t0 = sqrt(max(lower * lower - d2, 0.0));
    float t1 = sqrt(max(upper * upper - d2, 0.0));
    float dt = (t1 - t0) / float(AIRGLOW_RED_SAMPLES);
    vec2 sum = vec2(0.0);
    if (dt <= 0.0) {
        return sum;     // the line passes over the layer
    }
    for (int i = 0; i < AIRGLOW_RED_SAMPLES; i++) {
        float t = t0 + (float(i) + 0.5) * dt;
        float r = sqrt(d2 + t * t);
        float z = (r - airglowRedRadius) / airglowRedScale;
        vec2 near = airglowRedPatches((closest - dir * t) / r);
        vec2 far = airglowRedPatches((closest + dir * t) / r);
        vec2 brightness = vec2(near.x, far.x);      // its logarithm
        vec2 height = z + AIRGLOW_RED_SINK * brightness;
        sum += vec2(near.y, far.y) * exp(1.0 + brightness - height - exp(-height));
    }
    return sum * dt;
}

// The three layers' light on a line of sight in direction `dir` that ends on the ground at
// `surface`, which crosses each layer once, at cos(zenith) mu = sqrt(1 - (impact / radius)^2)
// for a layer at that radius (impact: the line's closest distance to the Earth's center, worked
// out from the surface point, which keeps its precision). For any line that meets the ground mu
// is at least about sqrt(2 h / R) for a layer at height h (0.25 for the green layer with the
// defaults), steep enough for the layer to count as flat: the path is its thickness over mu
// (within 0.1% of airglowHalfLine() at the edge of the disk for the two thin layers, and 3% for
// the even red layer). A Gaussian layer's thickness is sqrt(2 pi) widths, a Chapman layer's e
// scale heights. The red layer's patchiness is taken where the line crosses its peak.
vec3 airglowFromAbove(vec3 surface, vec3 dir) {
    float along = dot(surface, dir);
    float d2 = dot(surface, surface) - along * along;
    vec3 radius = vec3(airglowRadius, airglowSodiumRadius, airglowRedRadius);
    vec3 crossing = sqrt(max(radius * radius - d2, 0.0));   // from the closest point back to each layer
    vec3 path = vec3(vec2(sqrt(2.0 * PI) * airglowWidth), exp(1.0) * airglowRedScale)
        / max(crossing / radius, 0.1);
    vec3 redCrossing = surface - dir * (along + crossing.z);
    vec2 patches = airglowRedPatches(redCrossing / airglowRedRadius);
    return airglowEmission * path.x + airglowSodiumEmission * path.y
        + airglowRedEmission * (path.z * exp(patches.x) * patches.y);
}

// Half an 8-bit level of noise per pixel (interleaved gradient noise, Jimenez 2014), added after
// the output color conversion. The twilight and the glow beyond the limb are smooth gradients
// across only a few levels of the display, which otherwise show as bands.
vec3 ditherOutput(vec3 color) {
    float noise = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    return color + (noise - 0.5) / 255.0;
}
