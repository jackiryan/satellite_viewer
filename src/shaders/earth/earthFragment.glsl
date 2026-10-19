uniform sampler2D dayTexture;
uniform sampler2D nightTexture;
uniform sampler2D nightGlowTexture; // the night texture blurred into the glow lights make under cloud (nightGlowFragment.glsl)
uniform sampler2D specularMapTexture;
uniform sampler2D cloudTexture;   // sqrt(cloud reflectance) in red, from the gibs-cloud-texture worker
uniform bool showClouds;
uniform float cloudBrightness;    // scales cloud reflectance (1.0 = as computed)
uniform sampler2D cloudLightTexture; // cloud shadows and cloud-top shading, baked by cloudLightFragment.glsl
uniform bool liveCloudLight;      // march per pixel instead of reading cloudLightTexture (sun moving fast)
uniform float cloudShadowHeight;  // top height of the thickest clouds, in scene units
uniform float cloudRelief;        // strength of the slope shading on cloud tops (0 = flat)
uniform float cloudTwilightTint;  // 0 = cloud tops stay white to the terminator, 1 = full sunset color
uniform float windSpeed;          // m/s; rougher seas spread the sun glint out
uniform float glintBrightness;
uniform float atmosphereHaze;       // scales the air seen toward the limb (0 = no haze)
uniform float atmosphereBrightness; // brightness of sunlit haze where it is thick (at the limb)    // scales the sun glint
uniform vec3 sunDirection;
uniform float twilightAngle;
uniform vec3 dayColor;
uniform vec3 twilightColor;
uniform float time;
uniform float retinaStrength;     // the old retinaEffect(), now computed once per frame in earth.js

varying vec2 vUv;
varying vec3 vPosition;
varying vec3 vNormal;

vec3 gammaCorrection(vec3 color, float gamma) {
    return pow(color, vec3(1.0 / gamma));
}

// Clouds faintly visible on the night side (moonlight, airglow), as a reflectance multiplier
const vec3 nightCloudColor = vec3(0.012, 0.014, 0.02);

// Asymmetry parameter of cloud droplets at visible wavelengths, as in the cloud texture worker
// (gibs-cloud-texture/src/albedo.js), which made the reflectance R from the optical thickness tau
// with R = (1 - g) tau / (2 + (1 - g) tau)
const float CLOUD_ASYMMETRY = 0.86;

// Optical thickness of a cloud of reflectance R for light it scatters out of a straight path.
// Droplets scatter mostly forward, and light turned by only a few degrees still arrives about
// where it was going, so this counts only scattering at larger angles: the delta-M scaled
// thickness (1 - g^2) tau, which with tau from R above is 2 (1 + g) R / (1 - R).
float scatteringDepth(float reflectance) {
    return 2.0 * (1.0 + CLOUD_ASYMMETRY) * reflectance / (1.0 - reflectance);
}

#include ../common/atmosphere.glsl;

float sampleCloudReflectance(vec2 uv, float bias) {
    float encoded = texture(cloudTexture, uv, bias).r * float(showClouds);
    return clamp(encoded * encoded * cloudBrightness, 0.0, 0.95);
}

#include cloudShadow.glsl;

// Light that still reaches a shadowed cloud top from the sky and surrounding cloud
const float CLOUD_SHADOW_AMBIENT = 0.35;

void main() {
    vec3 viewDirection = normalize(vPosition - cameraPosition);
    vec3 normal = normalize(vNormal);
    vec3 color = vec3(0.0);
    float pi = 3.1415926;

    float sunOrientation = dot(sunDirection, normal);

    float twilightWidth = twilightAngle / pi;
    float dayMix = smoothstep(-twilightWidth, 0.0, sunOrientation);

    // Sun used to light the day side. The day texture is drawn past the geometric terminator,
    // fading out by sunOrientation = -twilightWidth, but there the real sun is below the horizon
    // and anything lit by it (cloud shadows, cloud-top shading, the sun glint) would switch off
    // at the terminator while the day texture is still showing. So keep the sun's real direction
    // across the ground (its azimuth) and remap its elevation, so that it reaches the horizon
    // where the day side finishes fading out: sin(elevation) = (mu + w) / (1 + w). Overhead sun
    // is unchanged, and at the geometric terminator the lighting sun is still ~6 degrees up.
    float litSunMu = (sunOrientation + twilightWidth) / (1.0 + twilightWidth);
    vec3 sunHorizontal = sunDirection - normal * sunOrientation;
    float sunHorizontalLength = length(sunHorizontal);
    vec3 litSunDirection = sunHorizontalLength > 1e-4
        ? normal * litSunMu + sunHorizontal / sunHorizontalLength * sqrt(max(1.0 - litSunMu * litSunMu, 0.0))
        : sunDirection;

    // Texture-space derivatives, taken up front because the day and night textures are read
    // inside branches below (implicit derivatives are undefined in non-uniform control flow)
    vec2 uvDx = dFdx(vUv), uvDy = dFdy(vUv);
    uvDx.x -= floor(uvDx.x + 0.5);                  // u wraps from 1 to 0 at the antimeridian
    uvDy.x -= floor(uvDy.x + 0.5);

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
    // showClouds is a uniform, so this branch costs nothing and skips all the cloud work while
    // the texture is loading or when clouds are toggled off.
    float cloudReflectance = 0.0;
    vec3 sunlight = vec3(1.0);
    if (showClouds) {
        cloudReflectance = sampleCloudReflectance(vUv, 0.0);
        // Sunlight after the clouds between this spot and the sun: x at the ground (with the cloud
        // overhead, at full resolution), y at the top of the cloud here, z the brightening of the
        // cloud top by its slope. Normally the shadow march is baked into cloudLightTexture by
        // cloudLightFragment.glsl whenever the sun has moved. When the sun moves so fast that the
        // bake would be redrawn every frame, Earth.updateCloudLighting sets liveCloudLight and the
        // march runs here per pixel instead, which costs less than marching the whole texture.
        // Both are uniform, so neither branch diverges.
        vec3 blocked;   // the bake's layout: ground and cloud-top light blocked, slope light - 0.4
        if (liveCloudLight) {
            // Mip level for the march: the pixel's footprint on the texture, allowing for up to
            // 4:1 stretching by foreshortening near the limb (as anisotropic filtering would)
            vec2 cloudTexels = vec2(textureSize(cloudTexture, 0));
            float footprintA = length(uvDx * cloudTexels), footprintB = length(uvDy * cloudTexels);
            float pixelLod = max(log2(max(min(footprintA, footprintB), max(footprintA, footprintB) / 4.0)), 0.0);
            vec3 light = cloudSunlight(vUv, normal, litSunDirection, length(vPosition), cloudReflectance, pixelLod);
            blocked = vec3(1.0 - light.x, 1.0 - light.y, light.z - 0.4);
        } else {
            blocked = textureGrad(cloudLightTexture, vUv, uvDx, uvDy).rgb;
        }
        sunlight = vec3(1.0 - max(cloudReflectance, blocked.r), 1.0 - blocked.g, blocked.b + 0.4);
    }
    float viewTransmission = 1.0 - cloudReflectance;
    float sunTransmission = sunlight.x;
    // Glint and the retina effect below only apply to water the sun reaches and we can see
    float specularTexColor = oceanMask * sunTransmission * viewTransmission;

    // Night side, skipped where the day side is fully opaque (dayMix = 1)
    if (dayMix < 1.0) {
        vec3 nightTexColor = textureGrad(nightTexture, vUv, uvDx, uvDy).rgb;

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

        // At night city lights shine up through the cloud once, and the cloud tops are barely lit.
        // The cloud passes 1 - R of the light on. The part that crosses it without being scattered
        // aside keeps the lights sharp; the rest spreads out sideways inside the cloud and leaves it
        // as a soft glow (nightGlowTexture). Thin cloud leaves most lights sharp, and only the glow
        // gets through thick cloud, or along the slanting view toward the limb. Clear sky skips
        // the glow lookup altogether.
        vec3 cityLights = animatedNightTexColor * viewTransmission;
        if (cloudReflectance > 0.0) {
            float directTransmission = exp(-scatteringDepth(cloudReflectance) / max(muView, 0.1));
            vec3 glow = textureGrad(nightGlowTexture, vUv, uvDx, uvDy).rgb;
            cityLights = animatedNightTexColor * directTransmission
                + glow * max(viewTransmission - directTransmission, 0.0);
        }
        vec3 nightCloudy = cityLights + cloudReflectance * nightCloudColor;
        color = nightCloudy * (1.0 - dayMix);
    }

    // Day side, skipped where it has fully faded out (dayMix = 0)
    if (dayMix > 0.0) {
        vec3 dayTexColor = textureGrad(dayTexture, vUv, uvDx, uvDy).rgb;

        float cloudTopLight = mix(CLOUD_SHADOW_AMBIENT, 1.0, sunlight.y) * sunlight.z;
        // Sunlight reddens as the sun gets low (hue only; dayMix handles the fade to night). Cloud
        // tops also get blue skylight, so they take at most half the reddening of the direct beam,
        // scaled down further by cloudTwilightTint.
        vec3 sunlightTint = exp(-0.5 * atmosphereOpticalDepth * (min(airMass(litSunMu), 20.0) - 1.0));
        sunlightTint = mix(vec3(1.0), sunlightTint / sunlightTint.r, cloudTwilightTint);

        vec3 dayCloudy = cloudReflectance * cloudTopLight * sunlightTint
            + dayTexColor * sunTransmission * viewTransmission / (1.0 - cloudReflectance * dayTexColor);
        color += dayCloudy * dayMix;              // same as mix(nightCloudy, dayCloudy, dayMix)
    }

    // Atmosphere seen from space (aerial perspective). Looking toward the limb, the line of
    // sight crosses more and more air: the surface and clouds fade behind it, and the air adds
    // sunlight it scatters toward the camera. Thin air scatters mostly blue; by the limb the air
    // is so thick that every color is scattered and the haze turns white, as in DSCOVR/EPIC
    // images of the whole Earth. Only the air beyond the straight-down path counts, since the
    // Blue Marble texture already looks like the surface seen straight down from orbit. The haze
    // is lit by the same twilight-remapped sun as the clouds, so it warms toward the terminator
    // and fades with the day side.
    float hazePath = (airMass(muView) - 1.0) * atmosphereHaze;
    vec3 hazeTransmittance = exp(-atmosphereOpticalDepth * hazePath);
    vec3 hazeSunlight = attenuatedSunlight(litSunMu, 0.5, 0.3) * dayMix;
    color = color * hazeTransmittance + skyInscatter(hazePath, hazeSunlight, atmosphereBrightness);

    // Sun glint, from the Cox & Munk (1954) model of a wind-roughened sea: wave facet slopes
    // are Gaussian with variance 0.003 + 0.00512 * wind speed, and the glint is the light off
    // facets tilted to mirror the sun into the camera (those facing the half vector), times
    // the Fresnel reflectance of water at that angle. It stretches out and brightens toward
    // the limb (1 / muView) and takes the color of sunlight that crossed the atmosphere twice.
    // Lit by the same remapped sun as the clouds, so it reaches into the twilight band and fades
    // out with the day side (dayMix) instead of stopping at the geometric terminator
    if (dayMix > 0.0 && specularTexColor > 0.0 && muView >= 0.0) {
        vec3 halfVector = normalize(litSunDirection + toCamera);
        float cosTilt = max(dot(normal, halfVector), 1e-3);
        float cos2Tilt = cosTilt * cosTilt;
        float tan2Tilt = (1.0 - cos2Tilt) / cos2Tilt;
        float slopeVariance = 0.003 + 0.00512 * windSpeed;
        float waterFresnel = 0.02 + 0.98 * pow(1.0 - clamp(dot(halfVector, litSunDirection), 0.0, 1.0), 5.0);
        float glint = waterFresnel  * exp(-tan2Tilt / slopeVariance)
            / (4.0 * slopeVariance * cos2Tilt * cos2Tilt * max(muView, 0.9));
        glint *= dayMix * step(0.0, muView);
        const float glintMax = 0.9;
        glint = glintMax * (1.0 - exp(-glint / glintMax));
        // The color comes from the full extinction along the sun's path down and the view's path
        // back up, as for the cloud tops, but only part of the dimming is applied: the atmosphere
        // also scatters sunlight into those long paths. Taking all of it made the glint (and the
        // cloud shadows, which only show against it) fade out near the limb while the surface
        // there was still in full daylight.
        float glintPath = min(airMass(litSunMu) + airMass(muView), 40.0) - 2.0;
        // This was glintTint / glintTint.r * exp(-0.3 * k.r * path): the attenuatedSunlight() form with
        // the hue and dimming strengths both 0.3, which is exactly exp(-0.3 * k * path). Give the two
        // different strengths, as attenuatedSunlight() does, if they were meant to differ.
        vec3 glintColor = exp(-0.3 * atmosphereOpticalDepth * glintPath);
        color += glint * glintBrightness * specularTexColor * glintColor;
    }

    // The retina effect: retinaStrength is the same for every pixel, so this branch is free
    // and skips the pow() whenever the effect is off
    if (retinaStrength > 0.0) {
        vec3 retinaColor = mix(gammaCorrection(color, 1.11), color, specularTexColor);
        color = mix(color, retinaColor, retinaStrength);
    }

    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}