/* atmosphereFragment.glsl - the glow of the air beyond the limb.
 *
 * Drawn on the inside of a sphere just larger than the atmosphere (its top is atmosphereTop()
 * in common/atmosphere.glsl, set by atmosphereHeightScale). Only the part outside the Earth's
 * disk is ever visible: behind the disk the globe, drawn first, wins the depth test. Each
 * visible pixel's line of sight passes through the atmosphere without touching the ground, so
 * the color is purely the sunlight that air scatters toward the camera, from the same
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

    // The point where the line of sight comes closest to the Earth's center, worked out from
    // this fragment's point on the shell (about earthRadius from the center) rather than from the
    // camera (up to 30 times further out), so that it keeps its precision at the limb.
    float along = dot(vPosition, viewDirection);
    vec3 closest = vPosition - viewDirection * along;
    float closestDistance = length(vPosition - cameraPosition) - along;   // from the camera

    // The globe is drawn as a polygon inscribed in the true sphere, so along the edge of the
    // disk there is a sliver, up to a pixel or two wide, where the line of sight misses the mesh
    // but passes inside the sphere. Those rays are treated as grazing the surface, so the glow
    // runs right up to the edge of the mesh instead of leaving a dark gap. (Rays that miss the
    // mesh can only be in the sliver: behind the disk the globe hides the shell.)
    float grazing = earthRadius * 1.0001;
    if (dot(closest, closest) < grazing * grazing) {
        closest = normalize(closest) * grazing;
        viewDirection = normalize(closest - cameraPosition);
        closestDistance = length(closest - cameraPosition);
    }

    // The line of sight's stretch through the atmosphere, either side of the closest point
    float top = atmosphereTop();
    float halfChord = sqrt(max(top * top - dot(closest, closest), 0.0));
    float entry = max(closestDistance - halfChord, 0.0);
    float exit = closestDistance + halfChord;

    vec3 transmittance, inscatter;
    scatterAlong(cameraPosition, viewDirection, entry, exit, false, transmittance, inscatter);

    // Normal alpha blending: the glow adds its scattered light and hides the stars behind it in
    // proportion to how much light the air takes out of the line of sight
    float alpha = clamp(1.0 - dot(transmittance, vec3(1.0 / 3.0)), 0.0, 1.0);
    gl_FragColor = vec4(inscatter / max(alpha, 1e-3), alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    gl_FragColor.rgb = ditherOutput(gl_FragColor.rgb);
}
