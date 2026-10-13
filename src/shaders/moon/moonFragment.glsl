uniform sampler2D moonTexture;
uniform vec3 sunPosition;     // scene units, relative to the Earth's center (the origin)
uniform float sunRadius;      // scene units
uniform float earthRadius;    // scene units
uniform float brightness;     // overall scale on the sunlit surface
uniform vec3 umbraColor;      // light refracted into the umbra by Earth's atmosphere, at its edge

varying vec2 vUv;
varying vec3 vPosition;
varying vec3 vNormal;

// McEwen (1991) lunar-Lambert weight L(phase angle). L = 1 is pure Lommel-Seeliger, which
// is why a full Moon looks evenly bright out to its limb; L falls toward 0 (Lambertian)
// at large phase angles, so crescents darken smoothly toward the terminator.
float lunarLambertWeight(float phaseAngleDeg) {
    float g = phaseAngleDeg;
    return clamp(1.0 - 0.019 * g + 2.42e-4 * g * g - 1.46e-6 * g * g * g, 0.0, 1.0);
}

// Sunlight reaching this point past the Earth: white outside the shadow, fading across the
// penumbra, and only the reddish light refracted by Earth's atmosphere inside the umbra
// (darkest at the center of the shadow). The 1.02 factor is the usual ~2% enlargement of
// the shadow by the atmosphere (Danjon).
vec3 earthShadowLight(vec3 position) {
    vec3 sunDir = normalize(sunPosition);
    float behind = dot(position, -sunDir);          // distance along the shadow axis
    if (behind <= 0.0) {
        return vec3(1.0);
    }
    float offAxis = length(position + sunDir * behind);
    float sunDistance = length(sunPosition);
    float umbra = 1.02 * (earthRadius - behind * (sunRadius - earthRadius) / sunDistance);
    float penumbra = 1.02 * (earthRadius + behind * (sunRadius + earthRadius) / sunDistance);

    float direct = smoothstep(umbra, penumbra, offAxis);
    float towardEdge = clamp(offAxis / umbra, 0.0, 1.0);
    vec3 refracted = umbraColor * mix(0.35, 1.0, towardEdge * towardEdge);
    return mix(refracted, vec3(1.0), direct);
}

void main() {
    vec3 normal = normalize(vNormal);
    vec3 toSun = normalize(sunPosition - vPosition);
    vec3 toCamera = normalize(cameraPosition - vPosition);

    float mu0 = max(dot(normal, toSun), 0.0);      // cosine of the incidence angle
    float mu = max(dot(normal, toCamera), 0.0);    // cosine of the emission angle
    float phaseAngle = degrees(acos(clamp(dot(toSun, toCamera), -1.0, 1.0)));
    float L = lunarLambertWeight(phaseAngle);
    float reflectance = 2.0 * L * mu0 / max(mu0 + mu, 1e-4) + (1.0 - L) * mu0;

    vec3 light = earthShadowLight(vPosition);
    vec3 albedo = texture(moonTexture, vUv).rgb;
    gl_FragColor = vec4(albedo * reflectance * light * brightness, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}