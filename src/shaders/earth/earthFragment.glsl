uniform sampler2D dayTexture;
uniform sampler2D nightTexture;
uniform sampler2D specularMapTexture;
uniform vec3 sunDirection;
uniform float twilightAngle;
uniform vec3 dayColor;
uniform vec3 twilightColor;

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


void main() {
    vec3 viewDirection = normalize(vPosition - cameraPosition);
    vec3 normal = normalize(vNormal);
    vec3 color = vec3(0.0);
    float pi = 3.1415926;

    float sunOrientation = dot(sunDirection, normal);
    
    float dayMix = smoothstep(0.0, twilightAngle / pi, sunOrientation);
    vec3 dayTexColor = texture(dayTexture, vUv).rgb;
    vec3 nightTexColor = texture(nightTexture, vUv).rgb;
    color = mix(nightTexColor, dayTexColor, dayMix);

    float specularTexColor = texture(specularMapTexture, vUv).r;

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

/*
void oldFrag() {
    float cosAngle = cos(-declinationAngle);
    float sinAngle = sin(-declinationAngle);
    // The sphere is rotated by the gmst in scene space, which cares about sidereal time, but we
    // want a "solar time", so back out the gmst rotation and add in a rotation representing the 
    // difference between solar noon at the prime meridian and the time now.
    float rotatedX = vPosition.x * cos(-gmst + solarTime) + vPosition.z * sin(-gmst + solarTime);
    float rotPos = rotatedX * cosAngle - vPosition.y * sinAngle;
    vec3 dayColor = texture2D(dayTexture, vUv).rgb;
    vec3 nightColor = texture2D(nightTexture, vUv).rgb;

    // Blend between day and night offset over the 18 degrees of twilight, biased towards the night side
    // Note that the degrees of twilight is doubled for aesthetic reasons
    float blendFactor = clamp((rotPos + twilightAngle) / twilightAngle, 0.0, 1.0);
    vec3 color = mix(nightColor, dayColor, blendFactor);
    gl_FragColor = vec4(color, 1.0);
} */