uniform sampler2D dayTexture;
uniform sampler2D nightTexture;
uniform vec3 sunDirection;
uniform float twilightAngle;
uniform vec3 dayColor;
uniform vec3 twilightColor;

varying vec2 vUv;
varying vec3 vPosition;
varying vec3 vNormal;

void main() {
    vec3 viewDirection = normalize(vPosition - cameraPosition);
    vec3 normal = normalize(vNormal);
    vec3 color = vec3(0.0);
    float pi = 3.1415926;

    float sunOrientation = dot(sunDirection, normal);
    
    float dayMix = smoothstep(0.0, twilightAngle / 2.0 * pi, sunOrientation);
    vec3 dayTexColor = texture(dayTexture, vUv).rgb;
    vec3 nightTexColor = texture(nightTexture, vUv).rgb;
    color = mix(nightTexColor, dayTexColor, dayMix);

    // Fresnel
    float fresnel = dot(viewDirection, normal) + 1.0;
    fresnel = pow(fresnel, 3.0);

    // Atmosphere
    float atmosphereDayMix = smoothstep(0.0, 1.0, sunOrientation);
    vec3 atmosphereColor = mix(twilightColor, dayColor, atmosphereDayMix);
    // divide the mix variable by 10 to done down the atmosphere color by a lot.
    color = mix(color, atmosphereColor, fresnel * atmosphereDayMix / 10.0);

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