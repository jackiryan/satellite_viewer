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
    float fresnelDay = pow(fresnel, 2.0);

    // Atmosphere
    float nightSideTwilightExtent = -0.02; // Done by eye, not physically based
    float twilightMix = smoothstep(nightSideTwilightExtent, (twilightAngle / pi), sunOrientation)
                      * (-smoothstep(-(twilightAngle / pi), (twilightAngle / pi), sunOrientation) + 1.0);
    // divide the mix variable by 8 and 4 to tone down the atmosphere colors by a lot.
    color = mix(color, dayColor, fresnelDay * dayMix / 8.0);
    color = mix(color, twilightColor, fresnel * twilightMix / 4.0);

    // Specular
    vec3 reflection = reflect(-sunDirection, normal);
    float specular = -dot(reflection, viewDirection);
    specular = max(specular, 0.0);
    specular = pow(specular, 50.0);
    specular *= specularTexColor;

    float specularMix = smoothstep(0.0, (twilightAngle / 3.0 * pi), sunOrientation);
    vec3 specularColor = mix(twilightColor, vec3(0.31, 0.31, 0.35), specularMix);
    color += specular * specularColor;
    //color = mix(atmosphereColor, color, dayMix);

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