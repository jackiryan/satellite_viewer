uniform sampler2D dayTexture;
uniform sampler2D nightTexture;
uniform sampler2D specularMapTexture;
uniform sampler2D cloudTexture;   // sqrt(cloud reflectance) in red, from the gibs-cloud-texture worker
uniform bool showClouds;
uniform float cloudBrightness;    // scales cloud reflectance (1.0 = as computed)
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
    
    float specularTexColor = texture(specularMapTexture, vUv).r;

    // Clouds. The texture holds the visible reflectance R of the clouds, worked out by the
    // worker from NOAA-20 VIIRS cloud optical thickness (0 where there is no cloud). Cloud
    // droplets and crystals scatter without absorbing, so a cloud that reflects R passes
    // T = 1 - R on. By day the surface is seen through the cloud twice (sunlight going down,
    // reflected light coming back up), plus light bouncing between the ground and the cloud
    // base: R + A T^2 / (1 - R A) for a surface of albedo A. Thick clouds (R ~ 0.8) are bright
    // white and hide the ground; thin ones (R < 0.1) only veil it, as in true colour imagery.
    float cloudEncoded = texture(cloudTexture, vUv).r * float(showClouds);
    float cloudReflectance = clamp(cloudEncoded * cloudEncoded * cloudBrightness, 0.0, 0.95);
    float cloudTransmission = 1.0 - cloudReflectance;
    vec3 dayCloudy = cloudReflectance
        + dayTexColor * cloudTransmission * cloudTransmission / (1.0 - cloudReflectance * dayTexColor);
    // At night city lights shine up through the cloud once, and the cloud tops are barely lit
    vec3 nightCloudy = animatedNightTexColor * cloudTransmission + cloudReflectance * nightCloudColor;
    color = mix(nightCloudy, dayCloudy, dayMix);
    // Sun glint off the ocean only shows through gaps in the cloud
    specularTexColor *= cloudTransmission * cloudTransmission;

    // Fresnel
    float fresnel = dot(viewDirection, normal) + 1.0;
    fresnel = pow(fresnel, 2.0);

    // Atmosphere
    float daySideTwilightExtent = 0.1;
    float nightSideTwilightExtent = 0.1;
    float twilightMix = smoothstep(-0.05, nightSideTwilightExtent + (twilightAngle / pi), sunOrientation)
                      * (-smoothstep(-0.05, daySideTwilightExtent + (twilightAngle / pi), sunOrientation) + 1.0);
    vec3 atmosphereColor = mix(dayColor, twilightColor, twilightMix);
    color = mix(color, dayColor, fresnel * dayMix / 8.0);
    // divide the mix variable by 10 to done down the atmosphere color by a lot.
    color = mix(color, twilightColor, fresnel * twilightMix / 5.0);

    // Specular
    vec3 reflection = reflect(-sunDirection, normal);
    float specular = -dot(reflection, viewDirection);
    specular = max(specular, 0.0);
    specular = pow(specular, 100.0);
    specular *= specularTexColor;

    vec3 specularColor = mix(vec3(0.31, 0.31, 0.35), atmosphereColor, fresnel);
    color += specular * specularColor;
    vec3 retinaColor = mix(gammaCorrection(color, 1.11), color, specularTexColor);
    color = mix(color, retinaColor, retinaEffect(sunDirection, vec3(0.0), 5.0));

    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}