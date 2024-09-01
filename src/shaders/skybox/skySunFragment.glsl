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

vec4 getPixInfo(vec3 dir, vec2 offset) {
    vec2 uv = lookDirToTetrahedralUV(dir);

    vec2 pixelSpaceUV = uv * uPixelSize;
    vec2 pixelCenter = (ceil(pixelSpaceUV) - 0.5) + offset;
    vec2 uvCenter = pixelCenter / uPixelSize;

    vec3 starData = texture(uStarData, uvCenter).rgb;
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

    float vecDist = length((p - normalize(vec3(-1.0 * dir.x, dir.yz)))) * 206265.0;

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

// mix noise for alive animation, full source
vec4 hash4( vec4 n ) { return fract(sin(n)*1399763.5453123); }
vec3 hash3( vec3 n ) { return fract(sin(n)*1399763.5453123); }
vec3 hpos( vec3 n ) { return hash3(vec3(dot(n,vec3(157.0,113.0,271.0)),dot(n,vec3(271.0,157.0,113.0)),dot(n,vec3(113.0,271.0,157.0)))); }
float noise4q(vec4 x)
{
	vec4 n3 = vec4(0,0.25,0.5,0.75);
	vec4 p2 = floor(x.wwww+n3);
	vec4 b = floor(x.xxxx+n3) + floor(x.yyyy+n3)*157.0 + floor(x.zzzz +n3)*113.0;
	vec4 p1 = b + fract(p2*0.00390625)*vec4(164352.0, -164352.0, 163840.0, -163840.0);
	p2 = b + fract((p2+1.0)*0.00390625)*vec4(164352.0, -164352.0, 163840.0, -163840.0);
	vec4 f1 = fract(x.xxxx+n3);
	vec4 f2 = fract(x.yyyy+n3);
	f1=f1*f1*(3.0-2.0*f1);
	f2=f2*f2*(3.0-2.0*f2);
	vec4 n1 = vec4(0,1.0,157.0,158.0);
	vec4 n2 = vec4(113.0,114.0,270.0,271.0);	
	vec4 vs1 = mix(hash4(p1), hash4(n1.yyyy+p1), f1);
	vec4 vs2 = mix(hash4(n1.zzzz+p1), hash4(n1.wwww+p1), f1);
	vec4 vs3 = mix(hash4(p2), hash4(n1.yyyy+p2), f1);
	vec4 vs4 = mix(hash4(n1.zzzz+p2), hash4(n1.wwww+p2), f1);	
	vs1 = mix(vs1, vs2, f2);
	vs3 = mix(vs3, vs4, f2);
	vs2 = mix(hash4(n2.xxxx+p1), hash4(n2.yyyy+p1), f1);
	vs4 = mix(hash4(n2.zzzz+p1), hash4(n2.wwww+p1), f1);
	vs2 = mix(vs2, vs4, f2);
	vs4 = mix(hash4(n2.xxxx+p2), hash4(n2.yyyy+p2), f1);
	vec4 vs5 = mix(hash4(n2.zzzz+p2), hash4(n2.wwww+p2), f1);
	vs4 = mix(vs4, vs5, f2);
	f1 = fract(x.zzzz+n3);
	f2 = fract(x.wwww+n3);
	f1=f1*f1*(3.0-2.0*f1);
	f2=f2*f2*(3.0-2.0*f2);
	vs1 = mix(vs1, vs2, f1);
	vs3 = mix(vs3, vs4, f1);
	vs1 = mix(vs1, vs3, f2);
	float r=dot(vs1,vec4(0.25));
	//r=r*r*(3.0-2.0*r);
	return r * r * (3.0-2.0*r);
}

float ringRayNoise(vec3 sunDirection, vec3 pos, float r, float size) {
    vec3 ps = pos - sunDirection;
    float c = length(ps);
    ps = normalize(ps);
    
    float s = max(0.0, (1.0 - size * (c - r)));

    // multiple of ps controls the frequency of the noise
    float n = noise4q(vec4(ps * 1.0, c * 2.0));
    float ns = noise4q(vec4(ps * size, c * 2.0)) * 2.0;
    n = pow(ns, 2.0) * pow(n, 2.0);
    
    // this power of s controls the amount the noise is pushed in towards
    // the radius
    return pow(s, 5.0) + s * s * n;
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
    for (int i = 0; i < 9; i++) {
        starColor += getPixInfo(dir, offsets[i]);
    }

    vec3 sunDistance = normalize(vNormal) - uSunDirection;
    float sunRays = ringRayNoise(normalize(uSunDirection), normalize(vNormal), 0.015, 15.0);
    // Sorry, everyone... the sun is white actually. Approximating the spectral irradiance of
    // the sun as a 5900k blackbody (observed at the top of the atmosphere), the sRGB value
    // would be (255, 255, 253). This is rather boring to look at, so I've made it a bit more
    // yellow than real life (~5100k) to make things interesting.
    vec4 sunColor = vec4(1.0, 0.98, 0.65, 1.0) * sunRays;

    // bake in -90 degree rotation about X axis for UV coordinate
    vec4 skyColor = desaturate(texture(uSkybox, vec2(1.0 - vUv.x, vUv.y)) * uMwBright, 0.6);

    gl_FragColor = starColor + skyColor + sunColor;

    #include <tonemapping_fragment>
	#include <colorspace_fragment>
}
