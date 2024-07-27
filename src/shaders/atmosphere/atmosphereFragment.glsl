uniform vec3 sunDirection;
uniform vec3 dayColor;
uniform vec3 twilightColor;
uniform float twilightAngle;

varying vec3 vNormal;
varying vec3 vPosition;

void main()
{
    vec3 viewDirection = normalize(vPosition - cameraPosition);
    vec3 normal = normalize(vNormal);
    vec3 color = vec3(0.0);
    float pi = 3.1415926;

    // Sun orientation
    float sunOrientation = dot(sunDirection, normal);

    // Atmosphere
    float nightSideTwilightExtent = -0.02; // Done by eye, not physically based
    float twilightMix = smoothstep(nightSideTwilightExtent, (twilightAngle / pi), sunOrientation)
                      * (-smoothstep(-(twilightAngle / pi), (twilightAngle / pi), sunOrientation) + 1.0);
    vec3 atmosphereColor = mix(dayColor, twilightColor, twilightMix);
    //vec3 atmosphereColor = mix(twilightColor, dayColor, twilightMix);
    //color = mix(color, atmosphereColor, atmosphereDayMix);
    color += atmosphereColor;
    
    // Alpha
    float edgeAlpha = dot(viewDirection, normal);
    edgeAlpha = smoothstep(0.0, 0.5, edgeAlpha);
    //edgeAlpha = pow(edgeAlpha, 2.0);

    float dayAlpha = smoothstep(nightSideTwilightExtent, (twilightAngle / pi), sunOrientation);
    float alpha = edgeAlpha * dayAlpha;

    // Final color
    gl_FragColor = vec4(color, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}