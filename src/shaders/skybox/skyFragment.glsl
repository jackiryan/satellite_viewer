
uniform samplerCube skyboxCubemap;
uniform float rotY;
uniform float rotX;
uniform float rotZ;
uniform float speed;

varying vec3 vDirection;

mat4 rotationMatrix(float y, float x, float z) {
    // Convert angles from degrees to radians
    x = radians(x);
    y = radians(y);
    z = radians(z);

    // Precompute sine and cosine
    float sinX = sin(x);
    float cosX = cos(x);
    float sinY = sin(y);
    float cosY = cos(y);
    float sinZ = sin(z);
    float cosZ = cos(z);

    // Construct the rotation matrix
    mat4 rotMatrix  = mat4(
        cosY * cosZ, cosZ * sinX * sinY - cosX * sinZ, cosX * cosZ * sinY + sinX * sinZ,   0,
        cosY * sinZ, cosX * cosZ + sinX * sinY * sinZ, -cosZ * sinX + cosX * sinY * sinZ,  0,
        -sinY,       cosY * sinX,                      cosX * cosY,                        0,
        0,           0,                                0,                                  1
    );

    return rotMatrix;
}

vec4 desaturate(vec4 color, float desaturationAmount) {
    float gray = dot(color.rgb, vec3(0.299, 0.587, 0.114)); // Luminance calculation
    vec3 desaturatedColor = mix(color.rgb, vec3(gray, gray, gray), desaturationAmount);
    return vec4(desaturatedColor, color.a); // Maintain original alpha
}

void main() {
    float ra = atan(vDirection.z, vDirection.x);
    float dec = asin(vDirection.y);

    mat4 rotMatrix = rotationMatrix(rotY, rotX, rotZ);
    vec3 rotDirection = (rotMatrix * vec4(vDirection, 1.0)).xyz;
    //vec4 skyColor = desaturate(texture(skyboxCubemap, rotatedDir) * speed, 0.6);
    vec4 skyColor = texture(skyboxCubemap, rotDirection);

    gl_FragColor = skyColor;

    #include <tonemapping_fragment>
	#include <colorspace_fragment>
}