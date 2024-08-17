// Star Shader
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

uniform sampler2D uYoffData;
uniform sampler2D uXoffData;
uniform sampler2D uMagData;
uniform sampler2D uTempData;
uniform float uPixelSize;
uniform float uSigma;
uniform float uScaleFactor;
uniform float uBrightnessScale;

uniform samplerCube uSkyboxCubemap;
uniform float uRotY;
uniform float uRotX;
uniform float uRotZ;
uniform float uMwBright;

varying vec3 vDirection;

 float log10(float x) {
    return log(x) / log(10.0);
 }

float decodeMagnitude(float encodedValue) {
    float maxMag = -1.46; // Brightest
    float minMag = 14.0; // Dimmest
    if (encodedValue == 0.0) {
        return 30.0;
    } else {
        return (minMag + (minMag - maxMag) * ((encodedValue) * -1.0));
    }
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

vec4 getPixInfo(vec3 dir, vec2 offset) {
    float Px = -1.0 * dir.x;
    float Py = dir.y;
    float Pz = dir.z;

    float sumAbs = abs(Px) + abs(Py) + abs(Pz);
    vec3 Pprime = vec3(Px, Py, Pz) / sumAbs;

    vec2 coord;
    if (Pprime.z >= 0.0) {
        coord = Pprime.xy;
    } else {
        coord = vec2(
            sign(Pprime.x) * (1.0 - abs(Pprime.y)),
            sign(Pprime.y) * (1.0 - abs(Pprime.x))
        );
    }

    float u = (coord.x + 1.0) * 0.5;
    float v = (coord.y + 1.0) * 0.5;

    vec2 pixelSpaceUV = vec2(u, v) * uPixelSize;
    vec2 pixelCenter = (ceil(pixelSpaceUV) - 0.5) + offset;
    vec2 uvCenter = pixelCenter / uPixelSize;

    float magData = texture(uMagData, uvCenter).r;
    vec3 tempData = texture(uTempData, uvCenter).rgb;
    float xData = texture(uXoffData, uvCenter).r;
    float yData = texture(uYoffData, uvCenter).r;

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

    float vecDist = length((p - normalize(vec3(Px, Py, Pz)))) * 206265.0;

    float intensity = drawStar(vecDist, uSigma);

    starBrightness *= uBrightnessScale;

    // Use the brightness as the alpha value
    return vec4(tempData, 1.0) * (starBrightness * intensity);
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

vec4 desaturate(vec4 color, float desaturationAmount) {
    float gray = dot(color.rgb, vec3(0.299, 0.587, 0.114)); // Luminance calculation
    vec3 desaturatedColor = mix(color.rgb, vec3(gray, gray, gray), desaturationAmount);
    return vec4(desaturatedColor, color.a); // Maintain original alpha
}

void main() {
    vec3 ndir1 = (rotationMatrix(0.0, 90.0, 180.0) * vec4(vDirection, 1.0)).xyz;
    vec3 dir = (rotationMatrix(uRotY, 90.0 - uRotX, -uRotZ) * vec4(vDirection, 1.0)).xyz;

    vec2 offsets[25] = vec2[](
        vec2(0, 0), vec2(1, 0), vec2(1, 1), vec2(0, 1), vec2(-1, 1),
        vec2(-1, 0), vec2(-1, -1), vec2(0, -1), vec2(1, -1), vec2(-2, 0),
        vec2(2, 0), vec2(0, -2), vec2(0, 2), vec2(-2, 1), vec2(2, 1),
        vec2(1, -2), vec2(1, 2), vec2(-2, -1), vec2(2, -1), vec2(-1, -2),
        vec2(-1, 2), vec2(-2, -2), vec2(2, -2), vec2(-2, 2), vec2(2, 2)
    );
    vec4 starColor = vec4(0.0, 0.0, 0.0, 0.0);
    for (int i = 0; i < 25; i++) {
        starColor += getPixInfo(dir, offsets[i]);
    }

    mat4 rotMatrix = rotationMatrix(180.0, 0.0, 164.6);
    vec3 rotDirection = (rotMatrix * vec4(dir, 1.0)).xyz;
    vec4 skyColor = desaturate(texture(uSkyboxCubemap, rotDirection) * uMwBright, 0.6);
    //vec4 skyColor = texture(uSkyboxCubemap, dir);

    gl_FragColor = skyColor + starColor;

    #include <tonemapping_fragment>
	#include <colorspace_fragment>
}