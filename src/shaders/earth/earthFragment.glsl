uniform sampler2D dayTexture;
uniform sampler2D nightTexture;
uniform sampler2D specularMapTexture;
uniform sampler2D cloudTexture;
uniform bool showClouds;
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

// Function to determine if a color is within a range (with some tolerance)
bool isInRange(vec3 color, vec3 minColor, vec3 maxColor, float tolerance) {
    vec3 diff1 = color - minColor;
    vec3 diff2 = maxColor - color;
    return all(greaterThanEqual(diff1, vec3(-tolerance))) && all(greaterThanEqual(diff2, vec3(-tolerance)));
}

vec3 closestPointOnSegment(vec3 p, vec3 a, vec3 b) {
    vec3 ab = b - a;
    float t = dot(p - a, ab) / dot(ab, ab);
    t = clamp(t, 0.0, 1.0);
    return a + t * ab;
}

float closestPointOnSegmentWithT(vec3 p, vec3 a, vec3 b) {
    vec3 ab = b - a;
    float t = dot(p - a, ab) / dot(ab, ab);
    return clamp(t, 0.0, 1.0);
}

float isOnGradient(vec3 testColor, vec3 colorA, vec3 colorB, vec3 colorC, vec3 colorD) {

    // Find closest points on each segment
    vec3 closest1 = closestPointOnSegment(testColor, colorA, colorB);
    vec3 closest2 = closestPointOnSegment(testColor, colorB, colorC);
    vec3 closest3 = closestPointOnSegment(testColor, colorC, colorD);
    
    // Find minimum distance
    float dist1 = distance(testColor, closest1);
    float dist2 = distance(testColor, closest2);
    float dist3 = distance(testColor, closest3);
    
    float minDist = min(dist1, min(dist2, dist3));
    
    return minDist;
}

float mapColorToGradientT(vec3 testColor, vec3 colorA, vec3 colorB, vec3 colorC, vec3 colorD, vec4 stops) {
    
    // Find closest points and distances on each segment
    float t1 = closestPointOnSegmentWithT(testColor, colorA, colorB);
    float t2 = closestPointOnSegmentWithT(testColor, colorB, colorC);
    float t3 = closestPointOnSegmentWithT(testColor, colorC, colorD);
    
    vec3 closest1 = mix(colorA, colorB, t1);
    vec3 closest2 = mix(colorB, colorC, t2);
    vec3 closest3 = mix(colorC, colorD, t3);
    
    float dist1 = distance(testColor, closest1);
    float dist2 = distance(testColor, closest2);
    float dist3 = distance(testColor, closest3);
    
    // Use inverse distance weighting to handle cases where the color
    // might be nearly equidistant to multiple segments
    float weight_sum = 0.0;
    if (dist1 > 0.0001) weight_sum += 1.0/dist1;
    if (dist2 > 0.0001) weight_sum += 1.0/dist2;
    if (dist3 > 0.0001) weight_sum += 1.0/dist3;
    
    // Global t values for each segment
    float global_t1 = mix(stops.x, stops.y, t1);
    float global_t2 = mix(stops.y, stops.z, t2);
    float global_t3 = mix(stops.z, stops.w, t3);
    
    // Weighted average of t values
    float result = 0.0;
    if (dist1 > 0.0001) result += (global_t1 * (1.0/dist1)) / weight_sum;
    if (dist2 > 0.0001) result += (global_t2 * (1.0/dist2)) / weight_sum;
    if (dist3 > 0.0001) result += (global_t3 * (1.0/dist3)) / weight_sum;
    
    return result;
}


// Calculates cloud optical depth and properties based on RGB encoding
vec4 calculateCloudProperties(vec4 cloudRGBA) {
    vec3 iceColorA = vec3(182.0, 0.0, 184.0) / 255.0;
    vec3 iceColorB = vec3(92.0,   0.0, 152.0) / 255.0;
    vec3 iceColorC = vec3(0.0, 122.0, 254.0) / 255.0;
    vec3 iceColorD = vec3(0.0, 1.0, 0.0);
    vec4 iceStops = vec4(0.0, 82.0 / 228.0, 152.0 / 228.0, 1.0);
    vec3 watColorA = vec3(255.0, 255.0, 4.0) / 255.0;
    vec3 watColorB = vec3(255.0, 255.0, 181.0) / 255.0;
    vec3 watColorC = vec3(255.0, 0.0, 0.0) / 255.0;
    vec3 watColorD = vec3(135.0, 0.0, 0.0) / 255.0;
    vec4 watStops = vec4(0.0, 79.0 / 228.0, 190.0 / 228.0, 1.0);
    
    // Tolerance for color comparison
    float tolerance = 1.0;
    
    // Initialize result: rgb = cloud color, a = opacity
    vec4 result = vec4(1.0, 1.0, 1.0, 0.0);

    vec3 cloudRGB = cloudRGBA.rgb;
    float iceDist = isOnGradient(cloudRGB, iceColorA, iceColorB, iceColorC, iceColorD);
    float watDist = isOnGradient(cloudRGB, watColorA, watColorB, watColorC, watColorD);
    float iceDepth = mapColorToGradientT(cloudRGB, iceColorA, iceColorB, iceColorC, iceColorD, iceStops);
    float watDepth = mapColorToGradientT(cloudRGB, watColorA, watColorB, watColorC, watColorD, watStops);
    float totalDepth = mix(mix(0.0, iceDepth, 0.4 - iceDist), mix(0.0, watDepth, 0.4 - watDist), iceDist - watDist);
    totalDepth = clamp(totalDepth, 0.0, 1.0);
    result.rgb = mix(vec3(0.95, 0.95, 0.95), vec3(0.7, 0.7, 0.8), totalDepth);
    result.a = clamp(totalDepth * 3.0, 0.0, 1.0);
    
    return result;
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

    // Apply cloud texture if enabled
    if (showClouds) {

        vec4 cloudPixel = texture(cloudTexture, vUv);
        // Calculate cloud properties based on optical depth encoding
        vec4 cloudProperties = calculateCloudProperties(cloudPixel);
        float cloudFactor = mix(0.05, 1.0, dayMix);
        vec3 cloudColor = cloudProperties.rgb * cloudFactor;

        // Blend cloud color with earth, using calculated opacity
        color = mix(color, cloudColor, cloudProperties.a);
        // Allow specular highlights to show through clouds a bit
        float cloudSpecularDamping = mix(1.0, 0.0, cloudProperties.a);
        specularTexColor *= cloudSpecularDamping;

    }

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