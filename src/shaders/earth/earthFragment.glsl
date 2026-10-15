uniform sampler2D dayTexture;
uniform sampler2D nightTexture;
uniform sampler2D specularMapTexture;
uniform sampler2D cloudTexture;   // sqrt(cloud reflectance) in red, from the gibs-cloud-texture worker
uniform bool showClouds;
uniform float cloudBrightness;    // scales cloud reflectance (1.0 = as computed)
uniform float cloudShadowHeight;  // top height of the thickest clouds, in scene units
uniform float cloudRelief;        // strength of the slope shading on cloud tops (0 = flat)
uniform float cloudTwilightTint;  // 0 = cloud tops stay white to the terminator, 1 = full sunset colour
uniform float windSpeed;          // m/s; rougher seas spread the sun glint out
uniform float glintBrightness;    // scales the sun glint
uniform vec3 sunDirection;
uniform float twilightAngle;
uniform vec3 dayColor;
uniform vec3 twilightColor;
uniform float time;

varying vec2 vUv;
varying vec3 vPosition;
varying vec3 vNormal;

float retinaEffect(vec3 sunPos, vec3 origin, float r) {
    vec3 sunCam = normalize(cameraPosition - sunPos * 1000.0);
    vec3 earthCam = cameraPosition - origin;
    float a = dot(sunCam, sunCam);
    float b = 2.0 * dot(sunCam, earthCam);
    float c = dot(earthCam, earthCam) - (r * r);
    float disc = b * b - 4.0 * a * c;
    float disc2 = mix(0.0, disc, smoothstep(0.0, 2.0, b));

    // experimentally derived smoothstep limits
    return smoothstep(10.0, 100.0, disc2);
}

vec3 gammaCorrection(vec3 color, float gamma) {
    return pow(color, vec3(1.0 / gamma));
}

// Clouds faintly visible on the night side (moonlight, airglow), as a reflectance multiplier
const vec3 nightCloudColor = vec3(0.012, 0.014, 0.02);

// Vertical optical depth of the atmosphere at about 650, 550 and 450 nm (Rayleigh scattering
// plus a little haze). Sunlight that crosses more air loses its blue first, so the sun glint
// and cloud tops turn golden, then orange and red, toward the terminator and the limb.
const vec3 atmosphereOpticalDepth = vec3(0.133, 0.197, 0.349);

// Air mass along a ray leaving the ground at cos(zenith angle) mu: the path through a
// uniform atmosphere 8.4 km deep on a 6371 km Earth (r = 6371 / 8.4). 1 straight up, about
// 39 along the horizon.
float airMass(float mu) {
    const float r = 758.0;
    mu = max(mu, 0.0);
    return sqrt(r * r * mu * mu + 2.0 * r + 1.0) - r * mu;
}

float sampleCloudReflectance(vec2 uv, float bias) {
    float encoded = texture(cloudTexture, uv, bias).r * float(showClouds);
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
vec3 cloudSunlight(vec2 uv, vec3 normal, vec3 sunDir, float radius, float localReflectance) {
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
    float slope = (cloudHeight(sampleCloudReflectance(uv - uvPerUnit * nearStep, 1.5))
                 - cloudHeight(sampleCloudReflectance(uv + uvPerUnit * nearStep, 1.5))) / (2.0 * nearStep);
    slope *= cloudRelief;
    float slopeLight = clamp((mu + sinZenith * slope) / (sqrt(1.0 + slope * slope) * mu), 0.4, 1.4);

    // March toward the sun out to where the ray clears the tallest cloud. Samples come from a
    // mip level about as coarse as the step, so the march blends into soft streaks instead of
    // showing copies of each cloud.
    float tanZenith = min(sinZenith / mu, MAX_SHADOW_LENGTH);
    float stepLength = cloudShadowHeight * tanZenith / float(CLOUD_SHADOW_STEPS);
    float bias = clamp(log2(max(stepLength * texelsPerUnit, 1.0)), 0.0, 4.0);
    float softness = 0.25 * cloudShadowHeight;
    float localHeight = cloudHeight(localReflectance);
    float groundBlocked = localReflectance;
    float topBlocked = 0.0;
    for (int i = 1; i <= CLOUD_SHADOW_STEPS; i++) {
        float marchDistance = (float(i) - 0.5) * stepLength;
        float reflectance = sampleCloudReflectance(uv + uvPerUnit * marchDistance, bias);
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

    float dayMix = smoothstep(-twilightAngle/pi, 0.0, sunOrientation);
    vec3 dayTexColor = texture(dayTexture, vUv).rgb;
    vec3 nightTexColor = texture(nightTexture, vUv).rgb;

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

    float oceanMask = texture(specularMapTexture, vUv).r;
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
    float cloudReflectance = sampleCloudReflectance(vUv, 0.0);
    float viewTransmission = 1.0 - cloudReflectance;
    vec3 sunlight = cloudSunlight(vUv, normal, sunDirection, length(vPosition), cloudReflectance);
    float sunTransmission = sunlight.x;
    float cloudTopLight = mix(CLOUD_SHADOW_AMBIENT, 1.0, sunlight.y) * sunlight.z;
    // Sunlight reddens as the sun gets low (hue only; dayMix handles the fade to night). Cloud
    // tops also get blue skylight, so they take at most half the reddening of the direct beam,
    // scaled down further by cloudTwilightTint.
    vec3 sunlightTint = exp(-0.5 * atmosphereOpticalDepth * (min(airMass(sunOrientation), 20.0) - 1.0));
    sunlightTint = mix(vec3(1.0), sunlightTint / sunlightTint.r, cloudTwilightTint);

    vec3 dayCloudy = cloudReflectance * cloudTopLight * sunlightTint
        + dayTexColor * sunTransmission * viewTransmission / (1.0 - cloudReflectance * dayTexColor);
    // At night city lights shine up through the cloud once, and the cloud tops are barely lit
    vec3 nightCloudy = animatedNightTexColor * viewTransmission + cloudReflectance * nightCloudColor;
    color = mix(nightCloudy, dayCloudy, dayMix);
    // Glint and the retina effect below only apply to water the sun reaches and we can see
    float specularTexColor = oceanMask * sunTransmission * viewTransmission;

    // Fresnel
    float fresnel = dot(viewDirection, normal) + 1.0;
    fresnel = pow(fresnel, 2.0);

    // Atmosphere
    float daySideTwilightExtent = 0.1;
    float nightSideTwilightExtent = 0.1;
    float twilightMix = smoothstep(-0.05, nightSideTwilightExtent + (twilightAngle / pi), sunOrientation)
                      * (-smoothstep(-0.05, daySideTwilightExtent + (twilightAngle / pi), sunOrientation) + 1.0);
    color = mix(color, dayColor, fresnel * dayMix / 8.0);
    // divide the mix variable by 10 to done down the atmosphere color by a lot.
    color = mix(color, twilightColor, fresnel * twilightMix / 5.0);

    // Sun glint, from the Cox & Munk (1954) model of a wind-roughened sea: wave facet slopes
    // are Gaussian with variance 0.003 + 0.00512 * wind speed, and the glint is the light off
    // facets tilted to mirror the sun into the camera (those facing the half vector), times
    // the Fresnel reflectance of water at that angle. It stretches out and brightens toward
    // the limb (1 / muView) and takes the colour of sunlight that crossed the atmosphere twice.
    vec3 halfVector = normalize(sunDirection + toCamera);
    float cosTilt = max(dot(normal, halfVector), 1e-3);
    float cos2Tilt = cosTilt * cosTilt;
    float tan2Tilt = (1.0 - cos2Tilt) / cos2Tilt;
    float slopeVariance = 0.003 + 0.00512 * windSpeed;
    float waterFresnel = 0.02 + 0.98 * pow(1.0 - clamp(dot(halfVector, sunDirection), 0.0, 1.0), 5.0);
    float glint = waterFresnel  * exp(-tan2Tilt / slopeVariance)
        / (4.0 * slopeVariance * cos2Tilt * cos2Tilt * max(muView, 0.1));
    glint *= smoothstep(0.0, 0.05, sunOrientation) * step(0.0, muView);
    vec3 glintColor = exp(-atmosphereOpticalDepth * (min(airMass(sunOrientation) + airMass(muView), 40.0) - 2.0));
    color += glint * glintBrightness * specularTexColor * glintColor;
    vec3 retinaColor = mix(gammaCorrection(color, 1.11), color, specularTexColor);
    color = mix(color, retinaColor, retinaEffect(sunDirection, vec3(0.0), 5.0));

    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}