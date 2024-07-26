
uniform vec3 color;
uniform vec3 planetCenter;
uniform float atmosphereRadius;
varying vec4 cDirection;
//varying vec4 vNormal;


vec2 raySphere(vec3 sphereCenter, float sphereRadius, vec3 rayOrigin, vec3 rayDir) {
    vec3 offset = rayOrigin - sphereCenter;
    float maxFloat = 1.e20;
    float a = 1.0; // Set to dot(rayDir, rayDir) if rayDir is not normalized
    float b = 2.0 * dot(offset, rayDir);
    float c = dot(offset, offset) - sphereRadius * sphereRadius;
    float d = b * b - 4.0 * a * c; // quadratic formula discriminator

    if (d > 0.0) {
        float s = sqrt(d);
        float dstToSphereNear = max(0.0, (-b - s) / (2.0 * a));
        float dstToSphereFar = (-b + s) / (2.0 * a);

        if (dstToSphereFar >= 0.0) {
            return vec2(dstToSphereNear, dstToSphereFar - dstToSphereNear);
        }
    }
    // d <= 0 ray did not intersect sphere (or was tangent)
    return vec2(maxFloat, 0.0);
}


void main() {
    vec3 rayOrigin = normalize(cameraPosition);
    vec3 rayDir = normalize(cDirection.xyz);

    vec2 hitInfo = raySphere(planetCenter, atmosphereRadius, rayOrigin, rayDir);

    float distToAtmosphere = hitInfo.x;
    float distThroughAtmosphere = hitInfo.y;
    float rayRatio = distThroughAtmosphere / (atmosphereRadius * 2.0);

    gl_FragColor = vec4(rayDir.x, rayDir.y, 0.0, 1.0);
}