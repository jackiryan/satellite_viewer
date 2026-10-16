// Star Shader (w/ Sun and no star color)
// (c) 2024 Alex Stone-Martinez & Jacqueline Ryan

// Permission is hereby granted, free of charge, to any person obtaining a copy of
// this software and associated documentation files (the “Software”), to deal in the
// Software without restriction, including without limitation the rights to use, copy,
// modify, merge, publish, distribute, sublicense, and/or sell copies of the Software,
// and to permit persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies
// or substantial portions of the Software.

// THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
// PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
// HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
// OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
// SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

uniform sampler2D uStarData;
uniform float uPixelSize;
uniform float uSigma;
uniform float uScaleFactor;
uniform float uBrightnessScale;

uniform vec3 uSunDirection;
uniform float uEarthRadius;  // the globe hides the sun, and with it the glare

uniform sampler2D uSkybox;
// uniform float uRotX;
// uniform float uRotY;
// uniform float uRotZ;
uniform float uMwBright;

varying vec3 vDirection;
varying vec3 vNormal;
varying vec2 vUv;

float decodeMagnitude(float encodedValue) {
    float maxMag = -1.46; // Brightest
    float minMag = 14.0;  // Dimmest
    float dftMag = 30.0;  // Used if the encoded value is ~= 0.0
    float thresh = 1e-6;

    float decodedMag = (minMag + (minMag - maxMag) * ((encodedValue) * -1.0));
    return mix(dftMag, decodedMag, step(thresh, abs(encodedValue)));
}

float magnitudeToBrightness(float magnitude) {
    // Convert astronomical magnitude to linear brightness
    // Remember: Lower magnitude means brighter star
    return pow(10.0, (0.0 - magnitude) / 2.5);
}

float drawStar(float dist, float sigma) {
    float gaussianIntensity = exp(-pow(dist, 2.0) / (2.0 * sigma * sigma));
    return gaussianIntensity;
}

vec2 lookDirToTetrahedralUV(vec3 dir) {
    float Px = -1.0 * dir.x;
    float Py = dir.y;
    float Pz = dir.z;

    float sumAbs = abs(Px) + abs(Py) + abs(Pz);
    vec3 Pprime = vec3(Px, Py, Pz) / sumAbs;

    float zSign = step(0.0, Pprime.z);
    vec2 coordPos = Pprime.xy;
    vec2 coordNeg = vec2(
        sign(Pprime.x) * (1.0 - abs(Pprime.y)),
        sign(Pprime.y) * (1.0 - abs(Pprime.x))
    );
    vec2 coord = mix(coordNeg, coordPos, zSign);

    return vec2(
        (coord.x + 1.0) * 0.5,
        (coord.y + 1.0) * 0.5
    );
}

vec4 getPixInfo(vec2 homeCenter, vec3 viewDir, vec2 offset) {
    vec2 uvCenter = (homeCenter + offset) / uPixelSize;

    vec3 starData = texture(uStarData, uvCenter).rgb;
    // ~89% of texels hold no star; neighbouring pixels read the same texels, so this branch is coherent
    if (starData.b < 1e-6) return vec4(0.0);
    float xData = starData.r;
    float yData = starData.g;
    float magData = starData.b;

    float starBrightness = magnitudeToBrightness(decodeMagnitude(magData) - uScaleFactor);

    vec2 coord1;
    // Value is between -2.5 / uPixelSize to 2.5 / uPixelSize
    coord1.x = (uvCenter.x * 2.0 - 1.0) + (((xData * 3.0) - 1.5) / uPixelSize);
    coord1.y = (uvCenter.y * 2.0 - 1.0) + (((yData * 3.0) - 1.5) / uPixelSize);

    vec3 Pprime1;
    if (abs(coord1.x) + abs(coord1.y) <= 1.0) {
        // Original condition for Pprime.z >= 0
        Pprime1.xy = coord1;
        Pprime1.z = 1.0 - abs(coord1.x) - abs(coord1.y); // Invert original front-facing projection
    } else {
        // Original condition for Pprime.z < 0, needs guessing
        // This branch is trickier because the original transformation compresses more information into the same space
        Pprime1.x = sign(coord1.x) * (1.0 - abs(coord1.y));
        Pprime1.y = sign(coord1.y) * (1.0 - abs(coord1.x));
        Pprime1.z = -(1.0 - abs(Pprime1.x) - abs(Pprime1.y)); // Invert original front-facing projection
    }

    vec3 p = normalize(Pprime1); // This normalization assumes Pprime was a direction vector.

    float vecDist = length(p - viewDir) * 206265.0;

    float intensity = drawStar(vecDist, uSigma);

    starBrightness *= uBrightnessScale;

    // Using pure white as the star color is less accurate, but provides better
    // accessibility for viewing the satellites
    return vec4(1.0) * (starBrightness * intensity);
}

mat4 rotationMatrix(float y, float x, float z) {
    // Convert angles from degrees to radians
    x = radians(x);
    y = radians(y);
    z = radians(z);

    // Precompute sine and cosine
    float sinX = sin(x);
    float cosX = cos(x);
    float sinY = sin(y);
    float cosY = cos(y);
    float sinZ = sin(z);
    float cosZ = cos(z);

    // Construct the rotation matrix
    mat4 rotMatrix  = mat4(
        cosY * cosZ, cosZ * sinX * sinY - cosX * sinZ, cosX * cosZ * sinY + sinX * sinZ,   0.0,
        cosY * sinZ, cosX * cosZ + sinX * sinY * sinZ, -cosZ * sinX + cosX * sinY * sinZ,  0.0,
        -sinY,       cosY * sinX,                      cosX * cosY,                        0.0,
        0.0,         0.0,                              0.0,                                1.0
    );

    return rotMatrix;
}

// Sun glare, the way the eye sees a light far too bright to look at (after Spencer et al. 1995,
// "Physically-based glare effects for digital images", and Ritschel et al. 2009, "Temporal
// glare"). Light scattered inside the eye spreads around the sun as a bloom, and diffraction by
// the fibers of the eye's lens fans it out into the ciliary corona: a dense burst of fine needles
// of uneven length, whose tips run slightly red because red light diffracts further than blue.
// Both happen in the eye rather than in the sky, so they follow the view:
//   - the needles keep their direction on screen however the camera turns;
//   - they shimmer as the eye moves (here, as the sun moves across the view), each needle
//     brightening, fading and changing length on its own;
//   - the glare is largest looking straight at the sun and shrinks into peripheral vision;
//   - it goes out as the Earth covers the sun.
const float SUN_ANGULAR_RADIUS = 0.00296; // radians; the disk drawn by the SDF in sunDisk()
const float GLARE_REACH = 0.12;           // longest needles, looking straight at the sun (radians, ~7 degrees)
const float PERIPHERAL_GLARE = 0.4;       // size and brightness of the glare at the edge of vision, relative to straight on
const float GAZE_FALLOFF = 0.35;          // tan of the angle off the view center where the glare is halfway there (~19 degrees)
const float SHIMMER_PERIOD = 0.12;        // how far the sun moves across the view (tan of the angle, ~7 degrees) for a needle to brighten and fade
const float NEEDLE_WIDTH = 0.0005;        // radians; needles are never drawn thinner than a pixel
// Needle length for red, green and blue relative to green (diffraction angle grows with wavelength)
const vec3 NEEDLE_DISPERSION = vec3(1.12, 1.0, 0.86);

// Hash without sine (Dave Hoskins), stable across GPUs
float hash11(float p) {
    p = fract(p * 0.1031);
    p *= p + 33.33;
    p *= p + p;
    return fract(p);
}

// One ring of needles around the sun, one per angular cell, each with its own direction jitter,
// length and brightness. u: angle around the sun in cells (0 to count), dist: angular distance
// from the sun (radians), width: needle half-width (radians), reach: the longest needle,
// shimmer: the sun's position in the view in units of SHIMMER_PERIOD. A needle can lie anywhere
// in its cell, so the cells either side are checked too.
vec3 needleRing(float u, float count, float dist, float width, float reach, vec2 shimmer, float seed) {
    float cellAngle = 6.2831853 / count;
    float home = floor(u);
    vec3 sum = vec3(0.0);
    for (int k = -1; k <= 1; k++) {
        float cell = home + float(k);
        float id = mod(cell, count) + seed;           // wraps around the circle
        float offset = hash11(id);
        float size = hash11(id + 0.37);
        float phase = hash11(id + 0.71);
        float heading = 6.2831853 * hash11(id + 0.13);
        float strength = hash11(id + 0.53);
        // Each needle swings between dim and bright as the sun moves across the view, along a
        // direction of its own, so moving the camera reshuffles which ones stand out
        float swing = 0.5 + 0.5 * sin(6.2831853 * (dot(shimmer, vec2(cos(heading), sin(heading))) + phase));
        // A few long, bright needles and many short, faint ones
        float needleLength = reach * (0.15 + 0.85 * size * size) * (0.6 + 0.4 * swing);
        float across = (u - cell - offset) * cellAngle * dist;   // distance from the needle's center line
        vec3 along = max(1.0 - dist / (needleLength * NEEDLE_DISPERSION), 0.0);
        sum += (0.15 + strength * strength) * (0.25 + 0.75 * swing)
             * exp(-across * across / (width * width)) * along * along;
    }
    return sum;
}

// The sun's disk: a signed distance to its edge, sharpened into a bright core
float sunDisk(float dist) {
    float s = max(0.0, (1.0 - 1.5 * (dist - SUN_ANGULAR_RADIUS)));
    s = pow(s, 50.0);
    return pow(s, 5.0);
}

// Disk and glare at sky direction dir, for a sun in direction sun (both unit vectors).
// pixelAngle: the angle one pixel covers, so needles stay at least a pixel wide.
vec3 sunLight(vec3 dir, vec3 sun, float pixelAngle) {
    vec3 offset = dir - sun;
    float dist = length(offset);                 // the chord, which is the angle from the sun this close
    if (dist > GLARE_REACH) return vec3(0.0);    // the rest of the sky
    vec3 disk = vec3(sunDisk(dist));

    // Where the sun is in the view: x and y are the tangents of its angle off the view center
    // along the screen axes. The sun behind the camera can't dazzle.
    mat3 toView = mat3(viewMatrix);
    vec3 sunView = toView * sun;
    if (sunView.z > -1e-3) return disk;
    vec2 sunInView = sunView.xy / -sunView.z;
    float gaze = mix(PERIPHERAL_GLARE, 1.0, 1.0 / (1.0 + dot(sunInView, sunInView) / (GAZE_FALLOFF * GAZE_FALLOFF)));

    // How much of the sun the Earth leaves showing (the Earth is at the origin)
    float cameraDistance = length(cameraPosition);
    float earthAngle = asin(min(uEarthRadius / cameraDistance, 1.0));
    float sunFromEarth = acos(clamp(dot(sun, -cameraPosition) / cameraDistance, -1.0, 1.0));
    float visible = smoothstep(earthAngle - SUN_ANGULAR_RADIUS, earthAngle + 3.0 * SUN_ANGULAR_RADIUS, sunFromEarth);
    if (visible <= 0.0) return disk;

    // Direction away from the sun on screen. A straight line through the sun on screen is a great
    // circle through it on the sky, so this stays the same all along each needle.
    vec3 offsetView = toView * offset;
    vec2 onScreen = offsetView.xy * -sunView.z + sunView.xy * offsetView.z;
    float around = atan(onScreen.y, onScreen.x + 1e-12) / 6.2831853 + 0.5;

    // Ciliary corona: a ring of long needles and a denser ring of short ones, brightest near the sun
    float reach = GLARE_REACH * gaze;
    vec2 shimmer = sunInView / SHIMMER_PERIOD;
    float width = max(NEEDLE_WIDTH, pixelAngle);
    vec3 needles = needleRing(around * 64.0, 64.0, dist, width, reach, shimmer, 0.0)
                 + 0.7 * needleRing(around * 233.0, 233.0, dist, width, 0.5 * reach, shimmer, 97.0);
    needles *= 1.1 * 0.012 / (dist + 0.012);

    // Bloom: a hot core and a glow falling off as a power of the angle, as scattering in the eye
    // does, so it has no edge; it still fades out before GLARE_REACH
    float glowSize = 0.008 * gaze;
    float bloom = 1.2 * exp(-dist / (0.004 * gaze)) + 0.3 * pow(glowSize / (dist + glowSize), 2.0);
    bloom *= 1.0 - smoothstep(0.5 * GLARE_REACH, GLARE_REACH, dist);

    return disk + visible * gaze * (bloom + needles);
}

vec4 desaturate(vec4 color, float saturation) {
    // standard coefficients for sRGB colorspace
    float luminance = dot(color.rgb, vec3(0.299, 0.587, 0.114));
    vec3 desaturatedColor = mix(vec3(luminance), color.rgb, saturation);
    return vec4(desaturatedColor, 1.0);
}

void main() {
    // bake in -90 degree rotation about y and x axes
    vec3 normPos = normalize(vDirection);
    vec3 dir = vec3(normPos.z, normPos.x, normPos.y);

    // to be as correct as possible, a 5-by-5 grid of points should be sampled from the datapack
    // a 3-by-3 grid is chosen instead to save on the render budget
    vec2 offsets[25] = vec2[](
        vec2(0, 0), vec2(1, 0), vec2(1, 1), vec2(0, 1), vec2(-1, 1),
        vec2(-1, 0), vec2(-1, -1), vec2(0, -1), vec2(1, -1), vec2(-2, 0),
        vec2(2, 0), vec2(0, -2), vec2(0, 2), vec2(-2, 1), vec2(2, 1),
        vec2(1, -2), vec2(1, 2), vec2(-2, -1), vec2(2, -1), vec2(-1, -2),
        vec2(-1, 2), vec2(-2, -2), vec2(2, -2), vec2(-2, 2), vec2(2, 2)
    );
    vec4 starColor = vec4(0.0, 0.0, 0.0, 0.0);
    vec2 homeCenter = ceil(lookDirToTetrahedralUV(dir) * uPixelSize) - 0.5;
    vec3 viewDir = normalize(vec3(-dir.x, dir.yz));
    for (int i = 0; i < 9; i++) {
        starColor += getPixInfo(homeCenter, viewDir, offsets[i]);
    }

    // The sky direction of this pixel, and the angle a pixel covers (taken here, outside any branch)
    vec3 skyDirection = normalize(vNormal);
    float pixelAngle = length(dFdx(skyDirection));
    vec3 sunRays = sunLight(skyDirection, normalize(uSunDirection), pixelAngle);
    // Sorry, everyone... the sun is white actually. Approximating the spectral irradiance of
    // the sun as a 6500k blackbody (observed at the top of the atmosphere), the sRGB value
    // would be (255, 255, 255). This is rather boring to look at, so I've made it a bit more
    // yellow than real life (~5100k) to make things interesting.
    vec4 sunColor = vec4(vec3(1.0, 0.98, 0.65) * sunRays, 1.0);

    // bake in -90 degree rotation about X axis for UV coordinate
    vec4 skyColor = desaturate(texture(uSkybox, vec2(1.0 - vUv.x, vUv.y)) * uMwBright, 0.9);

    gl_FragColor = starColor + skyColor + sunColor;

    #include <tonemapping_fragment>
	#include <colorspace_fragment>
}
