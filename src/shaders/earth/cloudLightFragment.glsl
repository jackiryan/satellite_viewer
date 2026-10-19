// Cloud lighting, baked into a texture with the same equirectangular layout as the cloud texture.
// None of it depends on the camera, only on the clouds and on where the sun is relative to the
// ground, so earth.js redraws it only when the clouds change or the sun has moved by
// cloudLightUpdateAngle, and the globe reads one texel of it instead of marching every frame.
//
// Output:
//   r  sunlight blocked by cloud between the ground here and the sun (not counting the cloud
//      overhead, which earthFragment adds at full resolution)
//   g  sunlight blocked by cloud between the top of the cloud here and the sun
//   b  brightening/darkening of the cloud top by its slope toward or away from the sun, minus 0.4
//      (it is clamped to 0.4..1.4)

uniform sampler2D cloudTexture;   // sqrt(cloud reflectance) in red, from the gibs-cloud-texture worker
uniform float cloudBrightness;    // scales cloud reflectance (1.0 = as computed)
uniform float cloudShadowHeight;  // top height of the thickest clouds, in scene units
uniform float cloudRelief;        // strength of the slope shading on cloud tops (0 = flat)
uniform vec3 sunDirectionLocal;   // sun in the Earth's own frame (unrotated by sidereal time)
uniform float twilightAngle;
uniform float earthRadius;        // scene units
uniform float bakeLod;            // log2(cloud texture width / this texture's width)

varying vec2 vUv;

#include cloudShadow.glsl;

void main() {
    // The ground under this texel, from the inverse of SphereGeometry's UV mapping
    // (u = phi / 2pi, v = 1 - theta / pi), in the Earth's own frame
    float phi = vUv.x * 2.0 * 3.14159265;
    float theta = (1.0 - vUv.y) * 3.14159265;
    vec3 normal = vec3(-cos(phi) * sin(theta), cos(theta), sin(phi) * sin(theta));

    // The same twilight-remapped sun as earthFragment uses to light the day side
    float pi = 3.1415926;
    float sunOrientation = dot(sunDirectionLocal, normal);
    float twilightWidth = twilightAngle / pi;
    float litSunMu = (sunOrientation + twilightWidth) / (1.0 + twilightWidth);
    vec3 sunHorizontal = sunDirectionLocal - normal * sunOrientation;
    float sunHorizontalLength = length(sunHorizontal);
    vec3 litSunDirection = sunHorizontalLength > 1e-4
        ? normal * litSunMu + sunHorizontal / sunHorizontalLength * sqrt(max(1.0 - litSunMu * litSunMu, 0.0))
        : sunDirectionLocal;

    float localReflectance = sampleCloudReflectanceLod(vUv, bakeLod);
    vec3 sunlight = cloudSunlight(vUv, normal, litSunDirection, earthRadius, localReflectance, bakeLod);
    gl_FragColor = vec4(1.0 - sunlight.x, 1.0 - sunlight.y, sunlight.z - 0.4, 1.0);
}
