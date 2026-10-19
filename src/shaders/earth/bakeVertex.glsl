// Full-screen pass shared by the Earth's texture bakes: the night glow blur (nightGlowFragment.glsl)
// and the cloud lighting (cloudLightFragment.glsl). Drawn with three's FullScreenQuad, whose single
// triangle is already in clip space.
varying vec2 vUv;

void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
}
