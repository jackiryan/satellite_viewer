
varying vec3 vDirection;

void main() {
    vDirection = normalize(position);

    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position.z = gl_Position.w; // set z to camera.far
}
