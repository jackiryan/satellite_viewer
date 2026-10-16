// Full-screen pass for the night glow blur (see nightGlowFragment.glsl). Drawn with three's
// FullScreenQuad, whose single triangle is already in clip space.
varying vec2 vUv;

void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
}
