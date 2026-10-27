uniform sampler2D dayTexture;
uniform sampler2D nightTexture;
uniform sampler2D nightGlowTexture; // the night texture blurred into the glow lights make under cloud (nightGlowFragment.glsl)
uniform sampler2D specularMapTexture;
uniform sampler2D cloudTexture;   // sqrt(cloud reflectance) in red, from the gibs-cloud-texture worker
uniform bool showClouds;
uniform float cloudBrightness;    // scales cloud reflectance (1.0 = as computed)
uniform float cloudShadowHeight;  // top height of the thickest clouds, in scene units
uniform float cloudRelief;        // strength of the slope shading on cloud tops (0 = flat)
uniform float cloudTwilightTint;  // 0 = cloud tops stay white to the terminator, 1 = full sunset color
uniform sampler2D seaIceTexture;  // sea ice concentration (0-1) in red, from the gibs-cloud-texture worker
uniform bool showSeaIce;
uniform vec3 seaIceColor;         // albedo of sea ice (linear); at night it takes the Black Marble's ice color (blackMarbleIce())
uniform float seaIceFloeThreshold; // concentration from which the ice is solid pack; below it, it breaks into floes
uniform float seaIceFloeScale;     // large floe cells per unit of the polar plane (floePlane())
uniform float windSpeed;          // m/s; rougher seas spread the sun glint out
uniform float glintBrightness;
uniform float atmosphereHaze;       // scales the air seen toward the limb (0 = no haze)
uniform float atmosphereBrightness; // brightness of sunlit haze where it is thick (at the limb)    // scales the sun glint
uniform vec3 sunDirection;
uniform float twilightAngle;
uniform vec3 dayColor;
uniform vec3 twilightColor;
uniform float time;
uniform float retinaStrength;     // the old retinaEffect(), now computed once per frame in earth.js

varying vec2 vUv;
varying vec3 vPosition;
varying vec3 vNormal;
varying vec3 vObjectNormal;

vec3 gammaCorrection(vec3 color, float gamma) {
    return pow(color, vec3(1.0 / gamma));
}

// Clouds faintly visible on the night side (moonlight, airglow), as a reflectance multiplier
const vec3 nightCloudColor = vec3(0.012, 0.014, 0.02);

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
// Light that still reaches a shadowed cloud top from the sky and surrounding cloud
const float CLOUD_SHADOW_AMBIENT = 0.35;

float cloudHeight(float reflectance) {
    return cloudShadowHeight * smoothstep(0.0, 0.45, reflectance);
}

// Sunlight reaching this spot, after the clouds between it and the sun:
//   x  at the ground (includes the cloud overhead), for the surface and the sun glint
//   y  at the top of the cloud here, for the cloud itself
//   z  brightening/darkening of the cloud top by its slope toward or away from the sun
// pixelLod: mip level matching the pixel's footprint on the cloud texture
// sunDir is the sun used for lighting (main() passes the twilight-remapped one, which only sets
// below the horizon where the day side has finished fading out)
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

void main() {
    vec3 viewDirection = normalize(vPosition - cameraPosition);
    vec3 normal = normalize(vNormal);
    vec3 color = vec3(0.0);
    float pi = 3.1415926;

    float sunOrientation = dot(sunDirection, normal);

    float twilightWidth = twilightAngle / pi;
    float dayMix = smoothstep(-twilightWidth, 0.0, sunOrientation);

    // Sun used to light the day side. The day texture is drawn past the geometric terminator,
    // fading out by sunOrientation = -twilightWidth, but there the real sun is below the horizon
    // and anything lit by it (cloud shadows, cloud-top shading, the sun glint) would switch off
    // at the terminator while the day texture is still showing. So keep the sun's real direction
    // across the ground (its azimuth) and remap its elevation, so that it reaches the horizon
    // where the day side finishes fading out: sin(elevation) = (mu + w) / (1 + w). Overhead sun
    // is unchanged, and at the geometric terminator the lighting sun is still ~6 degrees up.
    float litSunMu = (sunOrientation + twilightWidth) / (1.0 + twilightWidth);
    vec3 sunHorizontal = sunDirection - normal * sunOrientation;
    float sunHorizontalLength = length(sunHorizontal);
    vec3 litSunDirection = sunHorizontalLength > 1e-4
        ? normal * litSunMu + sunHorizontal / sunHorizontalLength * sqrt(max(1.0 - litSunMu * litSunMu, 0.0))
        : sunDirection;

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

    vec3 toCamera = -viewDirection;
    float muView = dot(normal, toCamera);

    // Clouds. The texture holds the visible reflectance R of the clouds, worked out by the
    // worker from NOAA-20 VIIRS cloud optical thickness (0 where there is no cloud). Cloud
    // droplets and crystals scatter without absorbing, so a cloud that reflects R passes
    // T = 1 - R on. By day the surface is lit through the cloud between it and the sun
    // (sunTransmission, which is what casts shadows), seen through the cloud above it
    // (viewTransmission), and gets back some of its own light from the cloud base:
    // R + A T_sun T_view / (1 - R A) for a surface of albedo A. Thick clouds (R ~ 0.8) are
    // bright white and hide the ground; thin ones (R < 0.1) only veil it.
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
        sunlight = cloudSunlight(vUv, normal, litSunDirection, length(vPosition), cloudReflectance, pixelLod);
    }
    float viewTransmission = 1.0 - cloudReflectance;
    float sunTransmission = sunlight.x;
    // Glint and the retina effect below only apply to open water the sun reaches and we can see
    float specularTexColor = oceanMask * (1.0 - seaIce) * sunTransmission * viewTransmission;

    // Night side, skipped where the day side is fully opaque (dayMix = 1)
    if (dayMix < 1.0) {
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
        vec3 nightCloudy = cityLights + cloudReflectance * nightCloudColor;
        color = nightCloudy * (1.0 - dayMix);
    }

    // Day side, skipped where it has fully faded out (dayMix = 0)
    if (dayMix > 0.0) {
        vec3 dayTexColor = textureGrad(dayTexture, vUv, uvDx, uvDy).rgb;
        // Sea ice covers that fraction of the sea, so it is part of the surface the clouds sit
        // over (its albedo enters the cloud formula below). It never darkens anything: where the
        // ice runs past the coast, or over the ice shelves (which the ocean mask counts as sea),
        // the ground is already as bright as the ice.
        dayTexColor = max(dayTexColor, mix(dayTexColor, seaIceAlbedo, seaIce));

        float cloudTopLight = mix(CLOUD_SHADOW_AMBIENT, 1.0, sunlight.y) * sunlight.z;
        // Sunlight reddens as the sun gets low (hue only; dayMix handles the fade to night). Cloud
        // tops also get blue skylight, so they take at most half the reddening of the direct beam,
        // scaled down further by cloudTwilightTint.
        vec3 sunlightTint = exp(-0.5 * atmosphereOpticalDepth * (min(airMass(litSunMu), 20.0) - 1.0));
        sunlightTint = mix(vec3(1.0), sunlightTint / sunlightTint.r, cloudTwilightTint);

        vec3 dayCloudy = cloudReflectance * cloudTopLight * sunlightTint
            + dayTexColor * sunTransmission * viewTransmission / (1.0 - cloudReflectance * dayTexColor);
        color += dayCloudy * dayMix;              // same as mix(nightCloudy, dayCloudy, dayMix)
    }

    // Atmosphere seen from space (aerial perspective). Looking toward the limb, the line of
    // sight crosses more and more air: the surface and clouds fade behind it, and the air adds
    // sunlight it scatters toward the camera. Thin air scatters mostly blue; by the limb the air
    // is so thick that every color is scattered and the haze turns white, as in DSCOVR/EPIC
    // images of the whole Earth. Only the air beyond the straight-down path counts, since the
    // Blue Marble texture already looks like the surface seen straight down from orbit. The haze
    // is lit by the same twilight-remapped sun as the clouds, so it warms toward the terminator
    // and fades with the day side.
    float hazePath = (airMass(muView) - 1.0) * atmosphereHaze;
    vec3 hazeTransmittance = exp(-atmosphereOpticalDepth * hazePath);
    vec3 hazeSunlight = attenuatedSunlight(litSunMu, 0.5, 0.3) * dayMix;
    color = color * hazeTransmittance + skyInscatter(hazePath, hazeSunlight, atmosphereBrightness);

    // Sun glint, from the Cox & Munk (1954) model of a wind-roughened sea: wave facet slopes
    // are Gaussian with variance 0.003 + 0.00512 * wind speed, and the glint is the light off
    // facets tilted to mirror the sun into the camera (those facing the half vector), times
    // the Fresnel reflectance of water at that angle. It stretches out and brightens toward
    // the limb (1 / muView) and takes the color of sunlight that crossed the atmosphere twice.
    // Lit by the same remapped sun as the clouds, so it reaches into the twilight band and fades
    // out with the day side (dayMix) instead of stopping at the geometric terminator
    if (dayMix > 0.0 && specularTexColor > 0.0 && muView >= 0.0) {
        vec3 halfVector = normalize(litSunDirection + toCamera);
        float cosTilt = max(dot(normal, halfVector), 1e-3);
        float cos2Tilt = cosTilt * cosTilt;
        float tan2Tilt = (1.0 - cos2Tilt) / cos2Tilt;
        float slopeVariance = 0.003 + 0.00512 * windSpeed;
        float waterFresnel = 0.02 + 0.98 * pow(1.0 - clamp(dot(halfVector, litSunDirection), 0.0, 1.0), 5.0);
        float glint = waterFresnel  * exp(-tan2Tilt / slopeVariance)
            / (4.0 * slopeVariance * cos2Tilt * cos2Tilt * max(muView, 0.8));
        glint *= dayMix * step(0.0, muView);
        const float glintMax = 0.9;
        glint = glintMax * (1.0 - exp(-glint / glintMax));
        // The color comes from the full extinction along the sun's path down and the view's path
        // back up, as for the cloud tops, but only part of the dimming is applied: the atmosphere
        // also scatters sunlight into those long paths. Taking all of it made the glint (and the
        // cloud shadows, which only show against it) fade out near the limb while the surface
        // there was still in full daylight.
        float glintPath = min(airMass(litSunMu) + airMass(muView), 40.0) - 2.0;
        // This was glintTint / glintTint.r * exp(-0.3 * k.r * path): the attenuatedSunlight() form with
        // the hue and dimming strengths both 0.3, which is exactly exp(-0.3 * k * path). Give the two
        // different strengths, as attenuatedSunlight() does, if they were meant to differ.
        vec3 glintColor = exp(-0.3 * atmosphereOpticalDepth * glintPath);
        color += glint * glintBrightness * specularTexColor * glintColor;
    }

    // The retina effect: retinaStrength is the same for every pixel, so this branch is free
    // and skips the pow() whenever the effect is off
    if (retinaStrength > 0.0) {
        vec3 retinaColor = mix(gammaCorrection(color, 1.11), color, specularTexColor);
        color = mix(color, retinaColor, retinaStrength);
    }

    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}