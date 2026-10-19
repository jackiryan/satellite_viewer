// Cloud shadows and cloud-top shading: a short march toward the sun over the cloud tops. Shared by
// the bake (cloudLightFragment.glsl), which runs it once per texel whenever the sun has moved,
// and earthFragment.glsl, which runs it per pixel instead while the sun moves so fast that the
// bake would be redrawn every frame (see Earth.updateCloudLighting).
//
// The including shader declares these uniforms:
//   sampler2D cloudTexture;   sqrt(cloud reflectance) in red, from the gibs-cloud-texture worker
//   float cloudBrightness;    scales cloud reflectance (1.0 = as computed)
//   float cloudShadowHeight;  top height of the thickest clouds, in scene units
//   float cloudRelief;        strength of the slope shading on cloud tops (0 = flat)

// The cloud texture from an explicit mip level. Explicit levels matter here: the march reads along
// a line toward the sun, and the level has to match the step length, not anything the GPU would
// pick on its own (near the limb that is already 4-5 levels coarse from foreshortening, which
// made shadows fade out well before the terminator). textureLod is also safe inside the loop and
// after the early return, where implicit derivatives are undefined.
float sampleCloudReflectanceLod(vec2 uv, float lod) {
    float encoded = textureLod(cloudTexture, uv, lod).r;
    return clamp(encoded * encoded * cloudBrightness, 0.0, 0.95);
}

// Cloud shadows. The cloud tops are treated as a height field: thin cloud is low, and cloud
// rises to cloudShadowHeight as it thickens, levelling off into a flat-topped deck once it is
// opaque (R ~ 0.45, optical thickness ~ 10) so overcast doesn't look lumpy. The shader marches from each point toward the
// sun along the ground, checking whether any cloud on the way rises above the sun's ray. With
// the sun high the ray climbs steeply and only nearby clouds cast (short) shadows; near the
// terminator it climbs slowly, so shadows stretch out along the sun's direction and taller
// clouds shade lower ones, as in geostationary imagery around sunrise and sunset.
const int CLOUD_SHADOW_STEPS = 8;
// Longest shadow as a multiple of the cloud height: tan(84 degrees) ~ 10
const float MAX_SHADOW_LENGTH = 10.0;

float cloudHeight(float reflectance) {
    return cloudShadowHeight * smoothstep(0.0, 0.45, reflectance);
}

// Sunlight reaching this spot, after the clouds between it and the sun:
//   x  at the ground, for the surface and the sun glint (the cloud overhead is left out here)
//   y  at the top of the cloud here, for the cloud itself
//   z  brightening/darkening of the cloud top by its slope toward or away from the sun
// minLod: the finest mip level worth reading: the bake's texel size on the cloud texture, or the
// pixel's footprint on it when earthFragment marches per pixel
// sunDir is the sun used for lighting (main() passes the twilight-remapped one, which only sets
// below the horizon where the day side has finished fading out)
vec3 cloudSunlight(vec2 uv, vec3 normal, vec3 sunDir, float radius, float localReflectance, float minLod) {
    float mu = dot(normal, sunDir);
    vec3 towardSun = sunDir - normal * mu;              // horizontal direction to the sun
    float sinZenith = length(towardSun);
    if (mu <= 0.0 || sinZenith < 1e-4) {
        return vec3(1.0);
    }

    // Texture coordinates per scene unit of distance toward the sun. The Earth spins about its
    // y axis, so east and north follow from the normal; u grows east and v north.
    vec3 eastUnscaled = cross(vec3(0.0, 1.0, 0.0), normal);
    float cosLatitude = max(length(eastUnscaled), 0.05);
    vec3 east = eastUnscaled / cosLatitude;
    vec3 north = cross(normal, east);
    vec3 sunAzimuth = towardSun / sinZenith;
    vec2 uvPerUnit = vec2(dot(sunAzimuth, east) / (2.0 * 3.14159265 * radius * cosLatitude),
                          dot(sunAzimuth, north) / (3.14159265 * radius));
    float texelsPerUnit = float(textureSize(cloudTexture, 0).x) / (2.0 * 3.14159265 * radius);

    // Slope of the cloud tops along the sun's direction, from heights three texels either side
    // (on a slightly blurred level, so it follows the shape of the clouds rather than pixel
    // noise). A top rising away from the sun faces it and catches more light.
    float nearStep = 3.0 / texelsPerUnit;
    float slopeLod = max(minLod, 1.5);
    float slope = (cloudHeight(sampleCloudReflectanceLod(uv - uvPerUnit * nearStep, slopeLod))
                 - cloudHeight(sampleCloudReflectanceLod(uv + uvPerUnit * nearStep, slopeLod))) / (2.0 * nearStep);
    slope *= cloudRelief;
    float slopeLight = clamp((mu + sinZenith * slope) / (sqrt(1.0 + slope * slope) * mu), 0.4, 1.4);

    // March toward the sun out to where the ray clears the tallest cloud. Samples come from a
    // mip level about as coarse as the step, so the march blends into soft streaks instead of
    // showing copies of each cloud.
    float tanZenith = min(sinZenith / mu, MAX_SHADOW_LENGTH);
    float stepLength = cloudShadowHeight * tanZenith / float(CLOUD_SHADOW_STEPS);
    float marchLod = max(clamp(log2(max(stepLength * texelsPerUnit, 1.0)), 0.0, 4.0), minLod);
    float softness = 0.25 * cloudShadowHeight;
    float localHeight = cloudHeight(localReflectance);
    float groundBlocked = 0.0;
    float topBlocked = 0.0;
    for (int i = 1; i <= CLOUD_SHADOW_STEPS; i++) {
        float marchDistance = (float(i) - 0.5) * stepLength;
        float reflectance = sampleCloudReflectanceLod(uv + uvPerUnit * marchDistance, marchLod);
        float height = cloudHeight(reflectance);
        float rayHeight = marchDistance / tanZenith;         // the sun's ray, measured from the ground
        groundBlocked = max(groundBlocked, reflectance * smoothstep(-softness, softness, height - rayHeight));
        topBlocked = max(topBlocked, reflectance * smoothstep(-softness, softness, height - localHeight - rayHeight));
    }
    return vec3(1.0 - groundBlocked, 1.0 - topBlocked, slopeLight);
}
