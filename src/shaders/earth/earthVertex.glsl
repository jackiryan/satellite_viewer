varying vec2 vUv;
varying vec3 vPosition;
varying vec3 vNormal;
varying vec3 vObjectNormal; // the surface direction fixed to the Earth (it doesn't turn with it)

void main() {
    vUv = uv;
    vPosition = (modelMatrix * vec4(position, 1.0)).xyz;
    vNormal = (modelMatrix * vec4(normal, 0.0)).xyz;
    vObjectNormal = normal;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
