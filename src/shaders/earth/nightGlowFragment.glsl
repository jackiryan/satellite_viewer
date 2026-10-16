// The glow of city lights under cloud. Light from the ground that is scattered inside a cloud
// spreads out sideways before it escapes from the cloud top, so seen from orbit the lights under
// a cloud turn into soft pools of light (earthFragment mixes this in by how much of the light the
// cloud scatters). This blurs the night texture into that glow once, when the globe is first
// drawn, in two passes of a Gaussian blur: east-west, then north-south.
//
// The texture is equirectangular, so a given distance east-west covers more texels toward the
// poles. The east-west pass widens by 1 / cos(latitude) to keep the glows round on the ground.

uniform sampler2D source;     // the night texture (east-west pass), or the first pass's output
uniform float spread;         // standard deviation of the blur, in radians of arc on the surface
uniform bool eastWest;        // which pass this is
uniform float sourceLod;      // mip level of the source that matches this pass's resolution
uniform float targetWidth;    // texels

varying vec2 vUv;

// Taps each side of the center, half a standard deviation apart, out to three standard deviations
const int TAPS = 6;

void main() {
    vec2 step;
    float lod = sourceLod;
    if (eastWest) {
        float cosLatitude = max(cos((vUv.y - 0.5) * 3.14159265), 0.02);
        step = vec2(0.5 * spread / (2.0 * 3.14159265 * cosLatitude), 0.0);
        // Toward the poles the taps end up more than a texel apart: read a coarser level there,
        // so that no light falls between them
        lod += max(log2(step.x * targetWidth), 0.0);
    } else {
        step = vec2(0.0, 0.5 * spread / 3.14159265);
    }

    vec3 sum = vec3(0.0);
    float total = 0.0;
    for (int i = -TAPS; i <= TAPS; i++) {
        float weight = exp(-0.125 * float(i * i));   // Gaussian, with taps at half-sigma steps
        sum += weight * textureLod(source, vUv + step * float(i), lod).rgb;
        total += weight;
    }
    gl_FragColor = vec4(sum / total, 1.0);
}
