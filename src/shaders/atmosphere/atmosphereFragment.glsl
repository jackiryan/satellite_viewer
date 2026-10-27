/* atmosphereFragment.glsl - the glow of the air beyond the limb.
 *
 * Drawn on the inside of a sphere just larger than the atmosphere (its top is atmosphereTop()
 * in common/atmosphere.glsl, set by atmosphereHeightScale). Only the part outside the Earth's
 * disk is ever visible: behind the disk the globe, drawn first, wins the depth test. Each
 * visible pixel's line of sight passes through the atmosphere without touching the ground, so
 * the colour is purely the sunlight that air scatters toward the camera, from the same
 * scatterAlong() that draws the haze on the disk. Thick air next to the limb glows white-blue,
 * the thinning air above it fades to a deeper blue, and the twilight band of air past the
 * terminator, still in sunlight when the ground below is not, carries the glow a little way
 * onto the night side. Seen from the night side, aerosol's forward scattering makes a bright
 * rim toward the sun.
 */
#define ATMOSPHERE_SAMPLES 12

varying vec3 vNormal;
varying vec3 vPosition;

#include ../common/atmosphere.glsl;

void main() {
    vec3 viewDirection = normalize(vPosition - cameraPosition);

    // The ray's stretch through the atmosphere: from where it enters the shell to where it
    // leaves it. Rays that would hit the Earth never get here (depth test), but guard anyway.
    float b = dot(cameraPosition, viewDirection);
    float closest = dot(cameraPosition, cameraPosition) - b * b;
    if (closest < earthRadius * earthRadius && b < 0.0) {
        discard;
    }
    float top = atmosphereTop();
    float halfChord = sqrt(max(top * top - closest, 0.0));
    float entry = max(-b - halfChord, 0.0);
    float exit = -b + halfChord;

    vec3 transmittance, inscatter;
    scatterAlong(cameraPosition, viewDirection, entry, exit, false, transmittance, inscatter);

    // Normal alpha blending: the glow adds its scattered light and hides the stars behind it in
    // proportion to how much light the air takes out of the line of sight
    float alpha = clamp(1.0 - dot(transmittance, vec3(1.0 / 3.0)), 0.0, 1.0);
    gl_FragColor = vec4(inscatter / max(alpha, 1e-3), alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}
