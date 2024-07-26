uniform sampler2D dayTexture;
uniform sampler2D nightTexture;
uniform float declinationAngle;
uniform float twilightAngle;
uniform float gmst;
uniform float solarTime;
varying vec2 vUv;
varying vec3 vPosition;

void main() {
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
}