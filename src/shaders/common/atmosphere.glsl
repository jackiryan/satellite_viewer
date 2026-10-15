// Atmosphere helpers shared by the Earth and atmosphere shaders, so that the colour of sunlight
// and of the sky is worked out the same way everywhere.

// Vertical optical depth of the atmosphere at about 650, 550 and 450 nm (Rayleigh scattering
// plus a little haze). Sunlight that crosses more air loses its blue first, so the sun glint,
// cloud tops and the sky turn golden, then orange and red, toward the terminator. Air also
// scatters blue the most, which is why a thin layer of it looks blue and a thick one white.
const vec3 atmosphereOpticalDepth = vec3(0.133, 0.197, 0.349);

// Air mass along a ray leaving the ground at cos(zenith angle) mu: the path through a
// uniform atmosphere 8.4 km deep on a 6371 km Earth (r = 6371 / 8.4). 1 straight up, about
// 39 along the horizon.
float airMass(float mu) {
    const float r = 758.0;
    mu = max(mu, 0.0);
    return sqrt(r * r * mu * mu + 2.0 * r + 1.0) - r * mu;
}

// Colour of sunlight that has come down through the atmosphere with the sun at cos(zenith) mu,
// relative to sunlight from straight overhead. The hue takes hueStrength times the reddening
// and the brightness dimStrength times the dimming of the red channel: the sky also scatters
// light into long low paths, so taking all of the dimming darkens twilight far too much.
vec3 attenuatedSunlight(float mu, float hueStrength, float dimStrength) {
    float path = min(airMass(mu), 40.0) - 1.0;
    vec3 tint = exp(-hueStrength * atmosphereOpticalDepth * path);
    return tint / tint.r * exp(-dimStrength * atmosphereOpticalDepth.r * path);
}

// Light scattered toward the viewer by a stretch of atmosphere `path` air masses long, lit by
// `sunlight`: brightness * sunlight * (1 - transmittance). Blue saturates first, so short paths
// look blue and long ones (toward the limb) whiten.
vec3 skyInscatter(float path, vec3 sunlight, float brightness) {
    return brightness * sunlight * (1.0 - exp(-atmosphereOpticalDepth * path / 5.0));
}
