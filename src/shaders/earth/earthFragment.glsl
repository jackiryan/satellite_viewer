uniform sampler2D dayTexture;
uniform sampler2D nightTexture;
uniform sampler2D specularMapTexture;
uniform sampler2D cloudTexture; // Add cloud texture uniform
uniform vec3 sunDirection;
uniform float twilightAngle;
uniform vec3 dayColor;
uniform vec3 twilightColor;

varying vec2 vUv;
varying vec3 vPosition;
varying vec3 vNormal;

// Perlin noise implementation for GLSL
// Classic Perlin noise function
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 permute(vec3 x) { return mod289(((x*34.0)+1.0)*x); }

float snoise(vec2 v) {
    const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                     -0.577350269189626, 0.024390243902439);
    vec2 i  = floor(v + dot(v, C.yy));
    vec2 x0 = v -   i + dot(i, C.xx);
    vec2 i1;
    i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    vec4 x12 = x0.xyxy + C.xxzz;
    x12.xy -= i1;
    i = mod289(i);
    vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0))
                    + i.x + vec3(0.0, i1.x, 1.0));
    vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy),
                            dot(x12.zw, x12.zw)), 0.0);
    m = m*m;
    m = m*m;
    vec3 x = 2.0 * fract(p * C.www) - 1.0;
    vec3 h = abs(x) - 0.5;
    vec3 ox = floor(x + 0.5);
    vec3 a0 = x - ox;
    m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);
    vec3 g;
    g.x  = a0.x  * x0.x  + h.x  * x0.y;
    g.yz = a0.yz * x12.xz + h.yz * x12.yw;
    return 130.0 * dot(m, g);
}

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

// Function to calculate cloud density from NASA GIBS cloud texture
float getCloudDensity(vec4 cloudPixel) {
    // Check if it's a "no data" pixel (#e4e4e4)
    if (abs(cloudPixel.r - 228.0/255.0) < 0.01 && 
        abs(cloudPixel.g - 228.0/255.0) < 0.01 && 
        abs(cloudPixel.b - 228.0/255.0) < 0.01) {
        return 0.0; // No data, no clouds
    }
    
    // Map the color range from #fff7ec (100% cloudy) to #7f0000 (0% cloudy)
    float r_factor = (cloudPixel.r - 127.0/255.0) / (255.0/255.0 - 127.0/255.0);
    float g_factor = (cloudPixel.g - 0.0/255.0) / (247.0/255.0 - 0.0/255.0);
    float b_factor = (cloudPixel.b - 0.0/255.0) / (236.0/255.0 - 0.0/255.0);
    
    // Average the factors and clamp to [0,1]
    return clamp((r_factor + g_factor + b_factor) / 3.0, 0.0, 1.0);
}

void main() {
    vec3 viewDirection = normalize(vPosition - cameraPosition);
    vec3 normal = normalize(vNormal);
    vec3 color = vec3(0.0);
    float pi = 3.1415926;

    float sunOrientation = dot(sunDirection, normal);
    
    float dayMix = smoothstep(0.0, twilightAngle, sunOrientation);
    vec3 dayTexColor = texture(dayTexture, vUv).rgb;
    vec3 nightTexColor = texture(nightTexture, vUv).rgb;
    color = mix(nightTexColor, dayTexColor, dayMix);

    // Sample cloud texture and calculate density
    vec4 cloudPixel = texture(cloudTexture, vUv);
    float baseDensity = getCloudDensity(cloudPixel);

    float scale1 = 4.0;  // Base scale for first octave
    float scale2 = 8.0; // Scale for second octave
    float scale3 = 32.0; // Scale for fine detail

    // Get noise values at different frequencies/scales
    // Offset the second and third octaves to avoid pattern repetition
    vec2 noiseCoord = vUv * 20.0; // Base coordinate scaling

    // You can add time to animate: noiseCoord + time * 0.01
    float noise1 = snoise(noiseCoord * scale1) * 0.5 + 0.5;
    float noise2 = snoise((noiseCoord + vec2(8.3, 2.8)) * scale2) * 0.25 + 0.25;
    float noise3 = snoise((noiseCoord + vec2(1.9, 9.2)) * scale3) * 0.125 + 0.125;
    
    // Combine noise octaves with cloud base density
    // This makes noise stronger in cloudy areas and weaker in clear areas
    float cloudDetail = (noise1 + noise2 + noise3) / 1.875; // Normalize to 0-1 range

    float cloudDensity = baseDensity * (0.7 + 0.6 * cloudDetail);
    cloudDensity = smoothstep(0.1, 0.6, cloudDensity); // Add some contrast to the clouds
    
    // Create cloud color that's illuminated by sunlight
    // Brighter in day, darker at night with subtle blue tint
    vec3 cloudColorDay = vec3(0.95, 0.95, 0.94);
    vec3 cloudColorNight = vec3(0.1, 0.1, 0.15); // Dark blue-ish for night side
    vec3 cloudColor = mix(cloudColorNight, cloudColorDay, dayMix);

    cloudColor = cloudColor * (0.75 + 0.4 * cloudDetail);
    
    // Apply clouds before atmosphere and specular effects
    // Adjust cloud opacity based on density and day/night cycle
    float cloudOpacity = cloudDensity * 0.9; // Adjust base opacity as needed
    cloudOpacity *= mix(0.2, 1.0, dayMix); // Slightly more visible on day side
    
    // Blend the clouds with the earth
    color = mix(color, cloudColor, cloudOpacity);
    
    float specularTexColor = texture(specularMapTexture, vUv).r;
    
    // Allow specular highlights to show through clouds a bit
    float cloudSpecularDamping = mix(1.0, 0.3, cloudOpacity);
    specularTexColor *= cloudSpecularDamping;

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
    // divide the mix variable by 10 to tone down the atmosphere color by a lot.
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