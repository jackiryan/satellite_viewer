/* earthFragment.glsl - the globe seen from space.
 *
 * Every pixel is built the same way, in this order (main() at the bottom):
 *
 *   1. What is on the ground: the Blue Marble albedo (atmospherically corrected surface
 *      reflectance), sea ice drawn over the sea, the ocean mask.
 *   2. What light falls on it: direct sunlight, dimmed and reddened by the air it crossed
 *      (sunTransmittance) times the cosine of the sun's elevation, plus blue skylight
 *      (skyIrradiance). Cloud shadows and the clouds' own transmission only block the direct
 *      part. Both come from common/atmosphere.glsl.
 *   3. What leaves the surface toward the camera: Lambertian ground and cloud tops, the
 *      two-stream cloud/ground exchange, the sun glint off the sea (Cox & Munk), and on the
 *      night side the city lights (an emission that does not depend on the sun).
 *   4. The observer (observerAdaptation): the eye adapts to the light around what it looks
 *      at, so the dim ground near the terminator is shown brighter than a single exposure would
 *      show it, and the city lights take over where it has adapted to the dark. This is the only
 *      step that is about perception rather than physics, and it only touches the light
 *      reflected by the surface and clouds, not the sun glint (the sun's own image).
 *   5. The air between the surface and the camera (scatterAlong): the surface's light is
 *      attenuated, and sunlight scattered by that air is added. This is the haze that whitens
 *      toward the limb and the blue over the ocean. The same function draws the glow beyond the
 *      limb in atmosphereFragment.glsl, so the two match at the edge of the disk.
 *
 * Radiance units: a white Lambertian surface under overhead sunlight is 1.0, so the textures'
 * albedo shows unchanged where the sun is overhead and the air is thin. Tone mapping and the
 * output color space are three.js's (viewer.js sets the exposure).
 */
uniform sampler2D dayTexture;
uniform sampler2D nightTexture;
uniform sampler2D nightGlowTexture; // the night texture blurred into the glow lights make under cloud (nightGlowFragment.glsl)
uniform sampler2D specularMapTexture;
uniform sampler2D cloudTexture;   // sqrt(cloud reflectance) in red, from the gibs-cloud-texture worker
uniform bool showClouds;
uniform float cloudBrightness;    // scales cloud reflectance (1.0 = as computed)
uniform float cloudShadowHeight;  // top height of the thickest clouds, in scene units
uniform float cloudRelief;        // strength of the slope shading on cloud tops (0 = flat)
uniform float cloudShadowAmbient; // direct light a shadowed cloud top still gets from the cloud around it (0-1)
uniform sampler2D seaIceTexture;  // sea ice concentration (0-1) in red, from the gibs-cloud-texture worker
uniform bool showSeaIce;
uniform vec3 seaIceColor;         // albedo of sea ice (linear); at night it takes the Black Marble's ice color (blackMarbleIce())
uniform float seaIceFloeThreshold; // concentration from which the ice is solid pack; below it, it breaks into floes
uniform float seaIceFloeScale;     // large floe cells per unit of the polar plane (floePlane())
uniform float windSpeed;          // m/s; rougher seas spread the sun glint out
uniform float glintBrightness;    // scales the sun glint
uniform float nightCloudLight;    // brightness of cloud on the night side (moonlight, airglow), as a reflectance multiplier
uniform float twilightAdaptation; // how far the eye brightens dim, low-sun ground (0 = one fixed exposure)
uniform float adaptationKnee;     // illumination (fraction of the overhead sun's) above which the eye doesn't adapt
uniform float nightAdaptationLevel; // illumination at which the view is half day- and half night-adapted
uniform float time;
uniform float retinaStrength;     // the old retinaEffect(), now computed once per frame in earth.js

varying vec2 vUv;
varying vec3 vPosition;
varying vec3 vNormal;
varying vec3 vObjectNormal;

vec3 gammaCorrection(vec3 color, float gamma) {
    return pow(color, vec3(1.0 / gamma));
}

// Night-side cloud is faintly bluish (moonlight and airglow are), scaled by nightCloudLight
const vec3 NIGHT_CLOUD_TINT = vec3(0.6, 0.7, 1.0);

// Asymmetry parameter of cloud droplets at visible wavelengths, as in the cloud texture worker
// (gibs-cloud-texture/src/albedo.js), which made the reflectance R from the optical thickness tau
// with R = (1 - g) tau / (2 + (1 - g) tau)
const float CLOUD_ASYMMETRY = 0.86;

// Optical thickness of a cloud of reflectance R for light it scatters out of a straight path.
// Droplets scatter mostly forward, and light turned by only a few degrees still arrives about
// where it was going, so this counts only scattering at larger angles: the delta-M scaled
// thickness (1 - g^2) tau, which with tau from R above is 2 (1 + g) R / (1 - R).
float scatteringDepth(float reflectance) {
    return 2.0 * (1.0 + CLOUD_ASYMMETRY) * reflectance / (1.0 - reflectance);
}

#include ../common/atmosphere.glsl;

// Where the view ray meets the true sphere. The mesh is a polygon: its triangles cut inside
// the sphere, by up to ~8 km in the middle of a triangle edge with 64 segments, which is more
// than the aerosol's scale height. Ending the view ray at the mesh point made the air in front of
// each triangle thicker in the middle than at the edges, which showed along the limb and the
// terminator as rows of beads, one per triangle. meshPoint is on the ray (vPosition), and the
// sphere's surface is a little way back toward the camera from it.
vec3 trueSurface(vec3 meshPoint, vec3 viewDirection) {
    float b = dot(meshPoint, viewDirection);                       // < 0 on the near side
    float r = length(meshPoint);
    float inside = max((earthRadius - r) * (earthRadius + r), 0.0); // R^2 - |P|^2, written for precision
    float back = -b - sqrt(b * b + inside);                         // <= 0: toward the camera
    return meshPoint + viewDirection * back;
}

const vec3 LUMINANCE = vec3(0.2126, 0.7152, 0.0722);

/* The observer. A camera with one exposure shows the Lambert falloff as it is: the ground
 * gets 1/10 of the overhead sun's light with the sun 10 degrees up and 1/170 at sunset, so
 * the band either side of the terminator is black. The eye adapts locally to the light around
 * what it looks at (it sees detail in a dusk landscape and a bright sky at once), which is why
 * the twilight band looks lit to someone in orbit. This models that as a gain on the light the
 * surface and clouds reflect, from the illumination E falling on the ground (direct sun and
 * sky, without cloud shadows, which the eye does not adapt to):
 *
 *     gain = max(((knee + A) / (E + A))^p, 1)
 *
 * p = twilightAdaptation (0 = a fixed exposure, 1 = everything shown as if in full daylight),
 * knee = adaptationKnee (no adaptation above it, so the sunlit disk is unchanged), and
 * A = nightAdaptationLevel, the darkest level the eye adapts to before it switches to the night
 * lights, which caps the gain. The night lights are shown with weight 1 / (1 + (E / A)^2): full
 * where E << A, half at E = A (with A = 1e-3, the sun about 2.5 degrees below the horizon), and
 * gone in daylight. The air's own light (in-scatter) is not adapted, so the haze and the glow
 * beyond the limb stay as the physics gives them and meet at the edge of the disk. Nor is the
 * sun glint: it is an image of the sun itself, which the eye does not adapt to, and brightening
 * it by the twilight gain (about 10 with the sun 2 degrees up) made it a clipped orange blob.
 *
 * irradiance: light falling on the ground, relative to the overhead sun, without sunColor.
 * Returns x: the gain for reflected sunlight, y: the weight of the night lights.
 */
vec2 observerAdaptation(vec3 irradiance) {
    float E = dot(irradiance, LUMINANCE);
    float A = nightAdaptationLevel;
    float gain = max(pow((adaptationKnee + A) / (E + A), twilightAdaptation), 1.0);
    float ratio = E / A;
    return vec2(gain, 1.0 / (1.0 + ratio * ratio));
}

/* Sea ice floes. The concentration grids are 25 km, far coarser than the globe, so where the
 * pack is loose (below seaIceFloeThreshold) the ice is drawn as separate floes, made up here
 * from Voronoi noise, with the sea showing between them. Each cell of the noise holds at most
 * one floe: the cell itself, or the cell shrunk toward its seed. Floes come in two sizes, large
 * ones and ones a quarter as big, and their combined area is the concentration, so the amount of
 * ice matches the data at every zoom. Just below the threshold the pack is plates of joined
 * floes with a few gaps; as the concentration falls the plates break up, large floes get rarer,
 * and floes of both sizes shrink and spread apart, until at 15% the ice is mostly small, widely
 * spaced floes, as in the marginal ice zone. When the floes would be under a few pixels across,
 * they fade into their average, so the globe never shimmers.
 */

// Earth-fixed direction -> plane, by stereographic projection from the opposite pole. It is
// conformal, so floes stay round, and they shrink by under 20% from the pole down to 40 degrees,
// beyond which there is no sea ice. One unit of the plane is 12742 km at the pole.
vec2 floePlane(vec3 p) {
    return p.y >= 0.0 ? p.xz / (1.0 + p.y) : p.xz / (1.0 - p.y);
}

// The inverse: a point of the plane in the given hemisphere -> texture coordinates (the
// SphereGeometry mapping: u = atan(z, -x) / 2 pi, v = 0.5 + latitude / pi)
vec2 floePlaneToUv(vec2 plane, bool north) {
    float rho2 = dot(plane, plane);
    vec2 xz = 2.0 * plane / (1.0 + rho2);
    float y = (1.0 - rho2) / (1.0 + rho2) * (north ? 1.0 : -1.0);
    return vec2(fract(atan(xz.y, -xz.x) * 0.15915494), 0.5 + asin(clamp(y, -1.0, 1.0)) * 0.31830989);
}

// PCG hash (Jarzynski & Olano 2020): three random numbers in [0, 1) for a cell, free of the
// banding sin()-based hashes show at large coordinates
vec3 cellRandom(ivec2 cell, uint salt) {
    uvec3 v = uvec3(uvec2(cell), salt) * 1664525u + 1013904223u;
    v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
    v ^= v >> 16u;
    v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
    return vec3(v) * (1.0 / 4294967296.0);
}

// Smooth value noise, two channels in [-0.5, 0.5], for roughening the floes' straight edges
vec2 floeWarp(vec2 q, uint salt) {
    ivec2 i = ivec2(floor(q));
    vec2 f = fract(q);
    vec2 u = f * f * (3.0 - 2.0 * f);
    vec2 a = cellRandom(i, salt).xy, b = cellRandom(i + ivec2(1, 0), salt).xy;
    vec2 c = cellRandom(i + ivec2(0, 1), salt).xy, d = cellRandom(i + ivec2(1, 1), salt).xy;
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) - 0.5;
}

// Pack cover: the concentration scaled so the threshold and above are 1 (solid)
float packCover(float concentration) {
    return min(concentration / seaIceFloeThreshold, 1.0);
}

// The share of the sea each size of floe covers, for a pack cover c: large floes cover c^2, and
// small ones fill in around them, so the two together (1 - (1 - large)(1 - small)) cover c
float floeShare(float c, bool large) {
    return large ? c * c : c / (1.0 + c);
}

// One layer of floes, one seed per unit cell of q (q = plane * scale). Each floe is decided by
// the pack cover at its seed, so it is drawn whole even where the cover changes across it. Some
// cells are whole: their floe fills the cell and joins whole neighbours with no seam, so close
// pack forms plates with the odd gap in them. In the rest, a share `present` hold a floe,
// shrunk toward its seed by `size` so it covers size^2 of the cell. As the cover falls there are
// fewer whole cells, and fewer, smaller floes. pixel: the pixel's size in cells, for
// antialiasing; lod: the mip level for reading the cover at a seed.
// Returns x: the part of the pixel the layer covers, y: the floe's brightness.
vec2 floeLayer(vec2 q, float scale, bool large, bool north, float pixel, float lod, uint salt) {
    // wobble the cells' edges a little (by up to ~0.1 cell, over a third of a cell), so floes
    // have ragged outlines rather than straight polygon sides
    q += 0.2 * floeWarp(q * 3.0, salt + 7u);
    ivec2 n = ivec2(floor(q));
    vec2 f = fract(q);

    // the nearest and second-nearest seeds (offsets from q), and their cells
    vec2 nearest = vec2(0.0), second = vec2(0.0);
    ivec2 nearestCell = n, secondCell = n;
    float best = 8.0, next = 8.0;
    for (int j = -1; j <= 1; j++) {
        for (int i = -1; i <= 1; i++) {
            ivec2 cell = n + ivec2(i, j);
            vec2 r = vec2(i, j) + cellRandom(cell, salt).xy - f;
            float d = dot(r, r);
            if (d < best) {
                next = best; second = nearest; secondCell = nearestCell;
                best = d; nearest = r; nearestCell = cell;
            } else if (d < next) {
                next = d; second = r; secondCell = cell;
            }
        }
    }

    float concentration = textureLod(seaIceTexture, floePlaneToUv((q + nearest) / scale, north), lod).r;
    float cover = floeShare(packCover(concentration), large);
    if (cover <= 0.0) return vec2(0.0, 1.0);
    float whole = cover * smoothstep(0.3, 1.0, cover);
    float rest = (cover - whole) / max(1.0 - whole, 1e-4); // cover needed from the other cells
    float present = sqrt(rest);
    float size = sqrt(present);                            // present * size^2 = rest

    vec3 kind = cellRandom(nearestCell, salt + 1u);
    vec3 look = cellRandom(nearestCell, salt + 2u);
    // loose floes are thinner, so a little greyer
    float brightness = 1.0 - 0.12 * look.y * (1.0 - cover);

    if (kind.x < whole) {
        // A whole cell covers all of itself, and only has an edge where it meets a cell that isn't
        // whole. For antialiasing, the edge nearby is taken to be the one with the second-nearest
        // seed (true over nearly all of the cell), and that cell's kind is judged by this cell's
        // cover (close enough: a wrong guess only softens one side of a seam).
        if (cellRandom(secondCell, salt + 1u).x < whole) return vec2(1.0, brightness);
        vec2 across = second - nearest;
        float edge = dot(nearest + 0.5 * across, normalize(across));
        return vec2(smoothstep(-0.5 * pixel, 0.5 * pixel, edge), brightness);
    }
    if (kind.y >= present) return vec2(0.0, 1.0);

    // floes vary in size, less so as the pack closes up
    float k = min(size * (1.0 + (look.x - 0.5) * 0.5 * (1.0 - cover)), 1.0);
    // Distance from q into the floe: its edges are the cell's edges (the bisectors with the
    // neighbouring seeds) moved toward its seed by k, as in Inigo Quilez's exact Voronoi border
    // distance ("Voronoi edges") with each bisector scaled. That searches the 5x5 cells around
    // the seed; a shrunk floe only meets the bisectors of seeds close by, so the 3x3 will do.
    float edge = 8.0;
    for (int j = -1; j <= 1; j++) {
        for (int i = -1; i <= 1; i++) {
            ivec2 cell = nearestCell + ivec2(i, j);
            if (cell == nearestCell) continue;
            vec2 toNeighbour = vec2(cell - n) + cellRandom(cell, salt).xy - f - nearest;
            edge = min(edge, dot(nearest + 0.5 * k * toNeighbour, normalize(toNeighbour)));
        }
    }
    return vec2(smoothstep(-0.5 * pixel, 0.5 * pixel, edge), brightness);
}

// Floes are drawn in full while their cells are over ~7 pixels across (0.15 cells per pixel),
// and have faded into their average by 2.5 pixels (0.4)
const vec2 FLOE_FADE = vec2(0.15, 0.4);
// The small floes' cells are this many times smaller than the large ones'
const float SMALL_FLOE_RATIO = 4.0;

// Sea ice over a pixel: x = the part covered, y = its brightness relative to seaIceColor.
// concentration: at this pixel; direction: the Earth-fixed direction of this pixel.
vec2 seaIceCover(float concentration, vec3 direction) {
    // floe coordinates, and the pixel's size in large floe cells
    vec2 plane = floePlane(direction);
    vec2 q = plane * seaIceFloeScale;
    float pixel = max(length(dFdx(q)), length(dFdy(q)));
    float cover = packCover(concentration);

    float showLarge = 1.0 - smoothstep(FLOE_FADE.x, FLOE_FADE.y, pixel);
    float showSmall = 1.0 - smoothstep(FLOE_FADE.x, FLOE_FADE.y, pixel * SMALL_FLOE_RATIO);
    if (showLarge <= 0.0 && showSmall <= 0.0) return vec2(cover, 1.0);
    // Mip level whose texels are about a large cell across: 12742 km / scale is the cell size,
    // and the texture spans 20015 km from pole to pole. Where there is no ice for about a cell
    // around, no floe reaches this pixel.
    float cellLod = log2(12742.0 / seaIceFloeScale * float(textureSize(seaIceTexture, 0).y) / 20015.0);
    if (textureLod(seaIceTexture, vUv, cellLod).r <= 0.0) return vec2(cover, 1.0);

    bool north = direction.y >= 0.0;
    vec2 a = vec2(floeShare(cover, true), 1.0);
    vec2 b = vec2(floeShare(cover, false), 1.0);
    if (showLarge > 0.0) {
        a = mix(a, floeLayer(q, seaIceFloeScale, true, north, pixel, max(cellLod - 2.0, 0.0), 0u), showLarge);
    }
    // small floes only show where there is sea between the large ones
    if (showSmall > 0.0 && a.x < 1.0) {
        b = mix(b, floeLayer(q * SMALL_FLOE_RATIO, seaIceFloeScale * SMALL_FLOE_RATIO, false, north,
            pixel * SMALL_FLOE_RATIO, max(cellLod - 4.0, 0.0), 3u), showSmall);
    }
    float covered = 1.0 - (1.0 - a.x) * (1.0 - b.x);
    // large floes lie over small ones
    float brightness = (a.x * a.y + (1.0 - a.x) * b.x * b.y) / max(covered, 1e-4);
    return vec2(covered, brightness);
}

// The Black Marble's color for ice. It draws the ice sheets in one flat color (sRGB about
// 49, 48, 70, a little bluer over Antarctica than over Greenland), which sea ice takes on at
// night, as it is about as bright as the ice sheets. Read from the night texture itself, so it
// matches whichever size is loaded: from the middle of the Greenland ice sheet (74 N, 40 W) for
// Arctic sea ice, and the East Antarctic plateau (80 S, 90 E) for Antarctic sea ice, at the mip
// level 256 texels wide, where a texel spans 1.4 degrees, well inside either ice sheet.
vec3 blackMarbleIce(bool north) {
    vec2 uv = north ? vec2(140.0 / 360.0, 164.0 / 180.0) : vec2(270.0 / 360.0, 10.0 / 180.0);
    float lod = max(log2(float(textureSize(nightTexture, 0).x) / 256.0), 0.0);
    return textureLod(nightTexture, uv, lod).rgb;
}

float sampleCloudReflectance(vec2 uv, float bias) {
    float encoded = texture(cloudTexture, uv, bias).r * float(showClouds);
    return clamp(encoded * encoded * cloudBrightness, 0.0, 0.95);
}

// Same, from an explicit mip level. The shadow lookups use this rather than a bias: a bias is
// added to the level the GPU picks for the pixel, which near the limb is already 4-5 levels
// coarse from foreshortening, so the shadow march ended up reading a ~32x16 texel texture and
// shadows faded out well before the terminator. textureLod is also safe inside the march loop
// and after the early return, where implicit derivatives are undefined.
float sampleCloudReflectanceLod(vec2 uv, float lod) {
    float encoded = textureLod(cloudTexture, uv, lod).r * float(showClouds);
    return clamp(encoded * encoded * cloudBrightness, 0.0, 0.95);
}

// Cloud shadows. The cloud tops are treated as a height field: thin cloud is low, and cloud
// rises to cloudShadowHeight as it thickens, levelling off into a flat-topped deck once it is
// opaque (R ~ 0.45, optical thickness ~ 10) so overcast doesn't look lumpy. The shader marches from each point toward the
// sun along the ground, checking whether any cloud on the way rises above the sun's ray. With
// the sun high the ray climbs steeply and only nearby clouds cast (short) shadows; near the
// terminator it climbs slowly, so shadows stretch out along the sun's direction and taller
// clouds shade lower ones, as in geostationary imagery around sunrise and sunset.
const int CLOUD_SHADOW_STEPS = 8;
// Longest shadow as a multiple of the cloud height: tan(84 degrees) ~ 10
const float MAX_SHADOW_LENGTH = 10.0;
// (the skylight a shadowed cloud top still gets is skyIrradiance(); cloudShadowAmbient adds the
// direct light scattered to it by the cloud around it)

float cloudHeight(float reflectance) {
    return cloudShadowHeight * smoothstep(0.0, 0.45, reflectance);
}

// Sunlight reaching this spot, after the clouds between it and the sun:
//   x  at the ground (includes the cloud overhead), for the surface and the sun glint
//   y  at the top of the cloud here, for the cloud itself
//   z  brightening/darkening of the cloud top by its slope toward or away from the sun
// pixelLod: mip level matching the pixel's footprint on the cloud texture
// sunDir: the direction to the sun
vec3 cloudSunlight(vec2 uv, vec3 normal, vec3 sunDir, float radius, float localReflectance, float pixelLod) {
    float mu = dot(normal, sunDir);
    vec3 towardSun = sunDir - normal * mu;              // horizontal direction to the sun
    float sinZenith = length(towardSun);
    if (mu <= 0.0 || sinZenith < 1e-4) {
        return vec3(1.0 - localReflectance, 1.0, 1.0);
    }

    // Texture coordinates per scene unit of distance toward the sun. The Earth spins about the
    // scene's y axis, so east and north follow from the normal; u grows east and v north.
    vec3 eastUnscaled = cross(vec3(0.0, 1.0, 0.0), normal);
    float cosLatitude = max(length(eastUnscaled), 0.05);
    vec3 east = eastUnscaled / cosLatitude;
    vec3 north = cross(normal, east);
    vec3 sunAzimuth = towardSun / sinZenith;
    vec2 uvPerUnit = vec2(dot(sunAzimuth, east) / (2.0 * 3.14159265 * radius * cosLatitude),
                          dot(sunAzimuth, north) / (3.14159265 * radius));
    float texelsPerUnit = float(textureSize(cloudTexture, 0).x) / (2.0 * 3.14159265 * radius);

    // Slope of the cloud tops along the sun's direction, from heights three texels either side
    // (on a slightly blurred level, so it follows the shape of the clouds rather than pixel
    // noise). A top rising away from the sun faces it and catches more light.
    float nearStep = 3.0 / texelsPerUnit;
    float slopeLod = max(pixelLod, 1.5);
    float slope = (cloudHeight(sampleCloudReflectanceLod(uv - uvPerUnit * nearStep, slopeLod))
                 - cloudHeight(sampleCloudReflectanceLod(uv + uvPerUnit * nearStep, slopeLod))) / (2.0 * nearStep);
    slope *= cloudRelief;
    float slopeLight = clamp((mu + sinZenith * slope) / (sqrt(1.0 + slope * slope) * mu), 0.4, 1.4);

    // March toward the sun out to where the ray clears the tallest cloud. Samples come from a
    // mip level about as coarse as the step, so the march blends into soft streaks instead of
    // showing copies of each cloud.
    float tanZenith = min(sinZenith / mu, MAX_SHADOW_LENGTH);
    float stepLength = cloudShadowHeight * tanZenith / float(CLOUD_SHADOW_STEPS);
    float marchLod = max(clamp(log2(max(stepLength * texelsPerUnit, 1.0)), 0.0, 4.0), pixelLod);
    float softness = 0.25 * cloudShadowHeight;
    float localHeight = cloudHeight(localReflectance);
    float groundBlocked = localReflectance;
    float topBlocked = 0.0;
    for (int i = 1; i <= CLOUD_SHADOW_STEPS; i++) {
        float marchDistance = (float(i) - 0.5) * stepLength;
        float reflectance = sampleCloudReflectanceLod(uv + uvPerUnit * marchDistance, marchLod);
        float height = cloudHeight(reflectance);
        float rayHeight = marchDistance / tanZenith;         // the sun's ray, measured from the ground
        groundBlocked = max(groundBlocked, reflectance * smoothstep(-softness, softness, height - rayHeight));
        topBlocked = max(topBlocked, reflectance * smoothstep(-softness, softness, height - localHeight - rayHeight));
    }
    return vec3(1.0 - groundBlocked, 1.0 - topBlocked, slopeLight);
}

// Fraction of the sea's wave facets that the sun still reaches when it is at cos(zenith) mu,
// for Gaussian slopes of variance slopeVariance (Smith's shadowing function for the Beckmann
// distribution, with Walter et al.'s 2007 rational fit). It is 1 with the sun high, and as the
// sun sets the wave crests shade the troughs, so it falls to 0 at the horizon: about 0.5 with
// the sun 2 degrees up and 0.3 at 1 degree with a 5 m/s wind.
float waveShadowing(float mu, float slopeVariance) {
    if (mu <= 0.0) return 0.0;
    float a = mu / sqrt(slopeVariance * max(1.0 - mu * mu, 1e-6)); // 1 / (sigma tan(zenith))
    if (a >= 1.6) return 1.0;
    float lambda = (1.0 - 1.259 * a + 0.396 * a * a) / (3.535 * a + 2.181 * a * a);
    return 1.0 / (1.0 + lambda);
}

void main() {
    vec3 viewDirection = normalize(vPosition - cameraPosition);
    vec3 normal = normalize(vNormal);                // the mesh point's direction (lighting, textures)
    vec3 surface = trueSurface(vPosition, viewDirection); // the true sphere along this ray (the air)
    vec3 toCamera = -viewDirection;
    float muSun = dot(normal, sunDirection);     // cosine of the sun's zenith angle (negative at night)
    float muView = dot(normal, toCamera);        // cosine of the view zenith angle (0 at the limb)

    // Texture-space derivatives, taken up front because the day and night textures are read
    // inside branches below (implicit derivatives are undefined in non-uniform control flow)
    vec2 uvDx = dFdx(vUv), uvDy = dFdy(vUv);
    uvDx.x -= floor(uvDx.x + 0.5);                  // u wraps from 1 to 0 at the antimeridian
    uvDy.x -= floor(uvDy.x + 0.5);

    float oceanMask = texture(specularMapTexture, vUv).r;

    // Sea ice. The texture holds the fraction of the sea covered by ice, from the NSIDC Sea Ice
    // Index's 25 km grids (0 for open water, land, and outside the polar grids). The worker
    // carries the ice about 50 km past the grids' coarse coastline, so the ocean mask, which is
    // much sharper, decides where the coast is. Sampled with the corrected derivatives so the
    // antimeridian seam doesn't drop to the smallest mip level. Where the pack is loose it is
    // broken into floes (seaIceCover()); seaIce is the part of the pixel the ice covers, and
    // seaIceBrightness scales its albedo.
    float seaIce = 0.0;
    float seaIceBrightness = 1.0;
    if (showSeaIce) {
        float concentration = textureGrad(seaIceTexture, vUv, uvDx, uvDy).r;
        vec2 ice = seaIceCover(concentration, normalize(vObjectNormal));
        seaIce = ice.x * oceanMask;
        seaIceBrightness = ice.y;
    }
    vec3 seaIceAlbedo = seaIceColor * seaIceBrightness;

    // Clouds. The texture holds the visible reflectance R of the clouds, worked out by the
    // worker from NOAA-20 VIIRS cloud optical thickness (0 where there is no cloud). Cloud
    // droplets and crystals scatter without absorbing, so a cloud that reflects R passes
    // T = 1 - R on. The surface is lit by direct sun through the cloud between it and the sun
    // (sunTransmission, which is what casts shadows) and by skylight through the cloud overhead,
    // is seen through that cloud (viewTransmission), and gets back some of its own light from
    // the cloud base: the two-stream exchange A T_view / (1 - R A) for a surface of albedo A.
    // Thick clouds (R ~ 0.8) are bright white and hide the ground; thin ones (R < 0.1) only veil it.
    // showClouds is a uniform, so this branch costs nothing and skips all the cloud work while
    // the texture is loading or when clouds are toggled off.
    float cloudReflectance = 0.0;
    vec3 sunlight = vec3(1.0);
    if (showClouds) {
        cloudReflectance = sampleCloudReflectance(vUv, 0.0);
        // Mip level for the shadow lookups: the pixel's footprint on the texture, allowing for up to
        // 4:1 stretching by foreshortening near the limb (as anisotropic filtering would)
        vec2 cloudTexels = vec2(textureSize(cloudTexture, 0));
        float footprintA = length(uvDx * cloudTexels), footprintB = length(uvDy * cloudTexels);
        float pixelLod = max(log2(max(min(footprintA, footprintB), max(footprintA, footprintB) / 4.0)), 0.0);
        sunlight = cloudSunlight(vUv, normal, sunDirection, earthRadius, cloudReflectance, pixelLod);
    }
    float viewTransmission = 1.0 - cloudReflectance;
    float sunTransmission = sunlight.x;
    // Glint and the retina effect below only apply to open water the sun reaches and we can see
    float specularTexColor = oceanMask * (1.0 - seaIce) * sunTransmission * viewTransmission;

    // Light on the surface, in units of the overhead sun's irradiance:
    //   directSun  the beam itself, reddened and dimmed by the air it came down through, times
    //              the cosine of the sun's elevation; zero once the sun has set
    //   skyLight   diffuse light from the sky, blue; small, but it is what lights shadows, and
    //              the ground and clouds for the last degrees before the terminator and the
    //              first few of twilight after it
    // Both come from the air between the ground and the sun (along the horizon once the sun has
    // set, for the skylight), looked up once. The observer then adapts to that light
    // (observerAdaptation): dayGain brightens the dim ground near the terminator, and
    // nightWeight brings in the city lights as it gets dark.
    vec2 sunColumns = airColumnsAt(0.0, max(muSun, 0.0));
    vec3 sunAtGround = muSun > 0.0 ? exp(-extinction(sunColumns)) : vec3(0.0);
    vec3 sky = skyIrradiance(muSun, sunColumns);
    vec3 irradiance = sunAtGround * max(muSun, 0.0) + sky;
    vec2 adaptation = observerAdaptation(irradiance);
    float dayGain = adaptation.x;
    float nightWeight = adaptation.y;
    vec3 directSun = sunAtGround * max(muSun, 0.0) * sunColor;
    vec3 skyLight = sky * sunColor;
    // the reflected light is invisible past here (well into nautical twilight)
    bool lit = dot(irradiance, LUMINANCE) * dayGain > 1e-5;

    vec3 color = vec3(0.0);

    // Night side, skipped where the lights are invisible (in daylight)
    if (nightWeight > 1e-3) {
        vec3 nightTexColor = textureGrad(nightTexture, vUv, uvDx, uvDy).rgb;

        // Identify and animate city lights -- this effect is completely unrealistic but it
        // makes the whole thing feel more alive
        vec3 animatedNightTexColor = nightTexColor;

        // Approximate color of city lights (slight yellow)
        vec3 cityLightColor = vec3(1.0, 0.98, 0.85);
        // Threshold for detecting city lights -- it's greater than 1 because the second step
        // of scaling by brightness cuts down the effect a lot
        float cityLightThreshold = 5.0;

        // Calculate how close the pixel's color is to our target city light color
        float colorDistance = length(normalize(nightTexColor) - normalize(cityLightColor));
        float isCityLight = 1.0 - smoothstep(0.0, cityLightThreshold, colorDistance);

        // Only animate pixels that are bright enough (not just dark areas that happen to match the color)
        // if removing this later, lower the threshold a lot (to 0.1 or so)
        float brightness = length(nightTexColor);
        isCityLight *= step(0.2, brightness);

        if (isCityLight > 0.0) {
            // heartbeat
            float globalPulse = 0.93 + 0.07 * sin(time * 6.0);
            // conceals heartbeat by modulating the pulse with slow-moving circles
            float regionalVariation = 0.85 + 0.15 * sin(vUv.x * 5.0 + time * 5.0) * cos(vUv.y* 5.0 + time * 5.0);
            // high-frequency flicker, the sine wave pattern is noticeable when pixel peeping but looks good
            // at a distance, lowering coefficient of time makes it slower, lower the final coefficient of
            // randomOffset increases the spatial frequency
            float randomOffset = fract(sin(dot(vUv, vec2(2.9898, 78.233)) * 4370.0));
            float twinkling = 0.8 + 0.2 * sin(time * 20.0 + randomOffset * 4.28);

            float animationFactor = globalPulse * twinkling * regionalVariation;

            animatedNightTexColor = nightTexColor * animationFactor;
            // the lights should tend to modulate brighter than darker, to suggest stray light reaching
            // into space (hence why I'm multiplying by 1.2)
            animatedNightTexColor = min(animatedNightTexColor * 1.2, vec3(1.0));
        }

        // Sea ice at night looks like the ice sheets do in the Black Marble: it covers that part
        // of the (nearly black) sea with the Black Marble's ice color, a little darker for loose
        // floes, as on the day side. Like there, it never darkens anything, such as city lights
        // or the ice shelves, which the Black Marble already draws as ice.
        vec3 nightSurface = animatedNightTexColor;
        vec3 seaIceNight = vec3(0.0);
        if (seaIce > 0.0) {
            seaIceNight = blackMarbleIce(vUv.y >= 0.5) * seaIceBrightness;
            nightSurface = max(nightSurface, mix(nightSurface, seaIceNight, seaIce));
        }

        // At night city lights shine up through the cloud once, and the cloud tops are barely lit.
        // The cloud passes 1 - R of the light on. The part that crosses it without being scattered
        // aside keeps the lights sharp; the rest spreads out sideways inside the cloud and leaves it
        // as a soft glow (nightGlowTexture). Thin cloud leaves most lights sharp, and only the glow
        // gets through thick cloud, or along the slanting view toward the limb. Clear sky skips
        // the glow lookup altogether. The rest of the night surface, the ice sheets included, comes
        // through cloud the same way, and so does the sea ice: the glow is made from the night
        // texture, which has no sea ice, so the ice is put into it here too. Its floes are much
        // larger than the glow's spread (cityLightSpread), so their glow is about the ice itself.
        vec3 cityLights = nightSurface * viewTransmission;
        if (cloudReflectance > 0.0) {
            float directTransmission = exp(-scatteringDepth(cloudReflectance) / max(muView, 0.1));
            vec3 glow = textureGrad(nightGlowTexture, vUv, uvDx, uvDy).rgb;
            glow = max(glow, mix(glow, seaIceNight, seaIce));
            cityLights = nightSurface * directTransmission
                + glow * max(viewTransmission - directTransmission, 0.0);
        }
        color = (cityLights + cloudReflectance * nightCloudLight * NIGHT_CLOUD_TINT) * nightWeight;
    }

    // Day side, skipped once twilight has faded out
    if (lit) {
        vec3 dayTexColor = textureGrad(dayTexture, vUv, uvDx, uvDy).rgb;
        // Sea ice covers that fraction of the sea, so it is part of the surface the clouds sit
        // over (its albedo enters the cloud formula below). It never darkens anything: where the
        // ice runs past the coast, or over the ice shelves (which the ocean mask counts as sea),
        // the ground is already as bright as the ice.
        vec3 albedo = max(dayTexColor, mix(dayTexColor, seaIceAlbedo, seaIce));

        // Cloud tops: direct sun, less where another cloud shades them (sunlight.y) and more or
        // less by their slope toward the sun (sunlight.z), plus the skylight. Near the terminator
        // the direct beam has lost its blue to the long path through the air, so the cloud tops
        // go golden, then red, while the skylight keeps their shadowed parts blue.
        vec3 cloudTopLight = directSun * mix(cloudShadowAmbient, 1.0, sunlight.y) * sunlight.z + skyLight;
        vec3 cloudTop = cloudReflectance * cloudTopLight;

        // The ground: direct sun through any cloud in the way (sunTransmission includes the
        // cloud overhead), skylight through the cloud overhead, seen through that cloud again,
        // with the ground-cloud bounce
        vec3 groundLight = directSun * sunTransmission + skyLight * viewTransmission;
        vec3 ground = albedo * groundLight * viewTransmission / (1.0 - cloudReflectance * albedo);

        vec3 reflected = cloudTop + ground;

        // Sun glint, from the Cox & Munk (1954) model of a wind-roughened sea: wave facet slopes
        // are Gaussian with variance 0.003 + 0.00512 * wind speed, and the glint is the light off
        // facets tilted to mirror the sun into the camera (those facing the half vector), times
        // the Fresnel reflectance of water at that angle. It stretches out and brightens toward
        // the limb (1 / muView). It is a mirror image of the sun, so it has the color of the
        // direct beam (without the cosine) and, like everything else, is then seen through the
        // air on the way up. As the sun sets the waves shade each other (waveShadowing), which
        // fades the glint out over the last few degrees before the terminator. Without it the
        // glint has no cosine to take it to zero, and sunAtGround is still a few percent at the
        // horizon before it drops to nothing, so the glint was cut off sharply at the terminator.
        // glintMax rolls the brightest part off softly, as a camera's sensor saturating would:
        // the real glint is many times brighter than any cloud. It is added after the observer's
        // gain, which it does not get (observerAdaptation).
        vec3 glintLight = vec3(0.0);
        if (specularTexColor > 0.0 && muView >= 0.0) {
            vec3 halfVector = normalize(sunDirection + toCamera);
            float cosTilt = max(dot(normal, halfVector), 1e-3);
            float cos2Tilt = cosTilt * cosTilt;
            float tan2Tilt = (1.0 - cos2Tilt) / cos2Tilt;
            float slopeVariance = 0.003 + 0.00512 * windSpeed;
            float waterFresnel = 0.02 + 0.98 * pow(1.0 - clamp(dot(halfVector, sunDirection), 0.0, 1.0), 5.0);
            float glint = waterFresnel * exp(-tan2Tilt / slopeVariance) * waveShadowing(muSun, slopeVariance)
                / (4.0 * slopeVariance * cos2Tilt * cos2Tilt * max(muView, 0.8));
            const float glintMax = 0.9;
            glint = glintMax * (1.0 - exp(-glint / glintMax));
            glintLight = glint * glintBrightness * specularTexColor * sunAtGround * sunColor;
        }
        color += reflected * dayGain + glintLight;
    }

    // The air between here and the camera (aerial perspective). Looking toward the limb the
    // line of sight crosses more and more of it: the surface and clouds fade behind it, and it
    // adds the sunlight it scatters toward the camera, blue where the air is thin and whitening
    // where it is thick, as in DSCOVR/EPIC images. The same model lights the ground above, so
    // the air's color and the surface's agree; on the night side the air is unlit and adds
    // nothing, apart from the band of twilight air still catching the sun past the terminator.
    // The ray ends at the true sphere (trueSurface), not at the mesh.
    float entry = atmosphereEntry(cameraPosition, viewDirection);
    vec3 airTransmittance, airLight;
    scatterAlong(cameraPosition, viewDirection, entry, length(surface - cameraPosition), true,
                 airTransmittance, airLight);
    color = color * airTransmittance + airLight;

    // The retina effect: retinaStrength is the same for every pixel, so this branch is free
    // and skips the pow() whenever the effect is off
    if (retinaStrength > 0.0) {
        vec3 retinaColor = mix(gammaCorrection(color, 1.11), color, specularTexColor);
        color = mix(color, retinaColor, retinaStrength);
    }

    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    gl_FragColor.rgb = ditherOutput(gl_FragColor.rgb);
}
