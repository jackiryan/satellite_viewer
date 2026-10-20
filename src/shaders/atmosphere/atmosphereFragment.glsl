uniform vec3 sunDirection;
uniform float twilightAngle;
uniform float earthRadius;
uniform float atmosphereRadius;     // radius of the shell this is drawn on
uniform float atmosphereBrightness; // brightness of sunlit haze where it is thick (as in the Earth shader)
uniform float haloScaleHeight;      // scene units over which the glow fades with height (exaggerated)

varying vec3 vNormal;
varying vec3 vPosition;

#include ../common/atmosphere.glsl;

// The glow of the atmosphere seen edge-on beyond the limb. Each pixel's line of sight passes the
// Earth at some height above the surface; the air along it thins out exponentially with that
// height, and it is lit by the sun where it skims closest to the Earth. The color and opacity
// come from the same scattering as the haze on the globe (common/atmosphere.glsl): thick air near
// the limb glows white, thinner air above it blue, and it turns warm and fades with the twilight
// on the night side. Only the part of the shell outside the Earth's disk is ever visible.
void main()
{
    vec3 viewDirection = normalize(vPosition - cameraPosition);
    float pi = 3.1415926;

    // Point where the line of sight comes closest to the Earth's center, and how high that is
    vec3 closest = cameraPosition - viewDirection * dot(cameraPosition, viewDirection);
    float height = max(length(closest) - earthRadius, 0.0);
    vec3 up = normalize(closest);

    // A line of sight skimming the surface crosses about twice the horizon air mass, and the air
    // thins out exponentially above that. The density is offset to reach zero at the top of the
    // shell, so the glow fades out before the edge of the geometry instead of being cut off by it.
    float shellHeight = atmosphereRadius - earthRadius;
    float topDensity = exp(-shellHeight / haloScaleHeight);
    float density = max(exp(-height / haloScaleHeight) - topDensity, 0.0) / (1.0 - topDensity);
    float path = 2.0 * airMass(0.0) * density;

    // Light it with the sun at that point, remapped for twilight as in the Earth shader
    float sunOrientation = dot(sunDirection, up);
    float twilightWidth = twilightAngle / pi;
    float dayMix = smoothstep(-twilightWidth, 0.0, sunOrientation);
    float litSunMu = (sunOrientation + twilightWidth) / (1.0 + twilightWidth);
    vec3 sunlight = attenuatedSunlight(litSunMu, 0.5, 0.3) * dayMix;

    // Normal alpha blending: the glow adds its scattered light and hides the stars behind it in
    // proportion to how much light the air removes (using the green channel's transmittance)
    vec3 inscatter = skyInscatter(path, sunlight, atmosphereBrightness);
    float alpha = clamp(1.0 - exp(-atmosphereOpticalDepth.g * path / 15.0), 0.0, 1.0) * dayMix;
    gl_FragColor = vec4(inscatter / max(alpha, 1e-3), alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}
