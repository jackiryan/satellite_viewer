# The Earth and atmosphere shaders

How the globe gets its colour from space, and what each parameter in `parameters` in
`src/earth.js` does. The code is in `src/shaders/common/atmosphere.glsl` (the air),
`src/shaders/earth/earthFragment.glsl` (the disk) and
`src/shaders/atmosphere/atmosphereFragment.glsl` (the glow beyond the limb).

## The idea

Every pixel of the disk is built in the same four steps, in this order:

1. **What is on the ground.** The Blue Marble albedo. It is an atmospherically corrected
   surface reflectance: the open ocean in it is only `(0.004, 0.008, 0.036)` in linear RGB,
   which is what water itself reflects. Nothing in the texture is "air". Sea ice is drawn
   over the sea here too.
2. **What light falls on it.** Direct sunlight, dimmed and reddened by the air it crossed on
   the way down (`sunTransmittance`), times the cosine of the sun's elevation; plus blue
   skylight (`skyIrradiance`). Cloud shadows block only the direct part.
3. **What leaves the surface toward the camera.** Lambertian ground and cloud tops, the
   two-stream exchange between a cloud and the ground under it, the sun glint off the sea,
   and on the night side the city lights.
4. **The air between the surface and the camera** (`scatterAlong`). The surface's light is
   attenuated by that air, and the sunlight the air scatters toward the camera is added.

The limb glow uses step 4 alone, along rays that miss the Earth, so the air at the edge of the
disk and the glow outside it are the same thing drawn twice.

Radiance units: a white Lambertian surface under overhead sunlight is `1.0`, so where the sun
is high and the air thin the texture shows unchanged. `renderer.toneMappingExposure` (1.3 in
`viewer.js`) then scales everything as before.

### The air

The atmosphere is three things, each with a vertical optical depth per colour channel, i.e.
the fraction of the overhead sun's light that channel loses on its way straight down is
`1 - exp(-depth)`:

| | what | profile | default depth (R, G, B) |
|---|---|---|---|
| Rayleigh | air molecules; scatter blue ~5x more than red | exponential, 8 km scale height | `0.051, 0.099, 0.238` |
| ozone | absorbs, mostly orange-red (Chappuis band) | given the Rayleigh profile | `0.040, 0.015, 0.0` |
| Mie | aerosol haze; grey, scatters mostly forward | exponential, 1.2 km scale height | `0.08` |

Optical depth along any ray is computed in closed form with the Chapman function (a rational
fit, exact straight up and along the horizon, within 6% between; `scripts/chapman_check.py`
checks it), so finding how much sunlight reaches a point costs two square roots and two
exponentials, with no inner loop toward the sun.

`scatterAlong` walks a view ray in 8 segments (12 for the limb glow). For each segment it
takes the exact transmittance across it from Chapman differences, and the light it scatters
toward the camera is *the light that segment removes from the view path*, lit by the sun at
the segment's middle and weighted by the phase functions. Extinction and in-scatter are
therefore always consistent: a thick stretch of air both hides what is behind it and glows,
in proportion. Light scattered more than once is approximated by a boost proportional to how
much of the path was scattered at all (`multipleScattering`).

### Why the old shader looked the way it did

The old `common/atmosphere.glsl` dimmed the surface by `exp(-k * path)` with
`k = (0.133, 0.197, 0.349)` and `path = 3 * (airMass - 1)`, and added back
`0.4 * (1 - exp(-k * path / 5))`. The two are not related to each other: the extinction was
three times a real atmosphere's and the in-scatter about a quarter of what that much air
would scatter. At a view angle of 70° from vertical (`muView = 0.3`) a white cloud lost
`(60%, 74%, 91%)` of its red, green and blue and got back only `(0.07, 0.09, 0.15)`, which
is the orange band of cloud that shows a third of the way in from the limb. The same
mismatch is why the haze never whitened (the in-scatter only saturates at `path ~ 15`, well
past the limb) and why the glow was lit with a reddened sun. The ocean was purple because
the Blue Marble's water colour (blue:green 4.5:1, no air over it) was shown as is: the real
ocean from space is mostly Rayleigh-scattered sunlight from the air above it, which is
blue-cyan, and the shader only added air "beyond the straight-down path".

With the new model the same cloud at `muView = 0.3` comes out `(0.41, 0.43, 0.41)`: a neutral
white, dimmed by the air in front of it, which is what EPIC and ISS images show for clouds
toward the limb.

## Parameters

All of these are in `parameters` in `src/earth.js`. Most can be changed live from the console
or a GUI with `earth.setParameter(name, value)`; the exceptions are noted.

### Sunlight

**`sunColor`** (`'#ffffff'`). Colour and strength of sunlight above the atmosphere. White means
the picture is white-balanced to the sun, as a camera in daylight is. The sun is a 5778 K
black body, slightly warm against a D65 display white: `'#ffeedd'` (linear `1.07, 1.0, 0.89`)
gives that look. Brightness goes here too (`'#cccccc'` dims everything 20%), though the
renderer's `toneMappingExposure` is the better place for an overall exposure change.

### The air

**`atmosphereHeightScale`** (`3`). The real atmosphere is thin: 8 km is about a pixel at the
default view, so the glow beyond the limb would be a hairline. This stretches the heights of
the air (8 km → 24 km, 1.2 km → 3.6 km, top 100 km → 300 km) without changing how much air there
is: every optical depth stays the same, so the colours on the disk are unaffected to within a
few percent. Only the thickness of the limb glow and the width of the twilight band change.
`1` is the real atmosphere. Not applied live: it also sets the size of the shell the glow is
drawn on.

**`rayleighDepth`** (`[0.051, 0.099, 0.238]`). Vertical optical depth of Rayleigh scattering in
the red, green and blue channels, derived spectrally for the sRGB primaries from the sea-level
value `tau(550 nm) = 0.098`. This is the single most important colour setting:

- The **blue : red ratio** (4.7 here) sets how blue thin air is and how red the sun becomes
  near the terminator. Bruneton's widely used `[0.046, 0.108, 0.265]` (ratio 5.8) gives a
  deeper, more saturated ocean and limb, closer to EPIC's narrow-band natural-colour
  composites; `[0.065, 0.098, 0.21]` is flatter and greyer.
- **Scaling all three together** is the amount of air. It raises the haze over the disk, the
  blue over the ocean, and how soon the limb saturates to white. It also moves the
  terminator's reddening inward.

**`ozoneDepth`** (`[0.040, 0.015, 0.0]`). Absorption by ozone (300 Dobson units), which sits in
the red channel because the Chappuis band peaks near 600 nm. It only matters along long
paths: it keeps the twilight band and the thick air at the limb blue rather than letting
them drift to yellow. `[0, 0, 0]` removes it.

**`mieDepth`** (`0.08`). Aerosol optical depth at 550 nm, grey. `0.05` is a very clean marine
atmosphere, `0.1` a global average, `0.3` and up dusty or polluted. More aerosol whitens the
haze over the disk, whitens the ocean, and brightens the limb when the sun is behind the
Earth (aerosols scatter forward). If the haze looks too blue and too clean, raise this; if
clouds near the centre of the disk lose contrast, lower it.

**`mieAlbedo`** (`0.9`). Of the light aerosols take out of a beam, the fraction they scatter
rather than absorb. Sea salt and sulfate are near 1; soot and dust pull it down toward 0.7,
which darkens the haze without changing its reach.

**`mieAnisotropy`** (`0.76`). Henyey-Greenstein `g` of the aerosol phase function: `0` scatters
evenly, `1` all forward. Real haze is 0.7-0.8. Lower values spread the aerosol's light over
the whole disk (a brighter, whiter haze everywhere); higher values concentrate it into the
sunward limb.

**`multipleScattering`** (`1.0`). Light that is scattered more than once before reaching the
camera, as a multiple of the single-scattered light, applied in proportion to how much of
the view path's light was scattered at all (so it does nothing where the air is thin and
doubles the glow where it is opaque). `0` is pure single scattering: a darker, bluer limb.
Full solutions of the transfer equation sit around 1-2 for an Earth-like atmosphere. This
is the knob for how bright the white rim at the limb is.

**`skylight`** (`1.0`). Scales the diffuse skylight on the ground and cloud tops. The model
takes half of the sunlight scattered out of the direct beam on its way down as skylight,
which is about 6% of the overhead sun in red and 13% in blue. It lights cloud shadows and
the shadowed sides of cloud banks blue, and it is what is left of the daylight in the last
few degrees before the terminator, where the direct beam has been absorbed. `1.5` is a
reasonable allowance for multiple scattering; `0` makes shadows black.

### Clouds

**`cloudBrightness`** (`1.0`). Scales the reflectance read from the cloud texture.

**`cloudShadowHeight`** (`30` km), **`cloudRelief`** (`0.6`). Unchanged: the height field the
shadows are cast from (exaggerated from the real 12 km so shadows are visible at globe scale)
and the slope shading of cloud tops.

**`cloudShadowAmbient`** (`0.3`). Direct sunlight a cloud top shaded by another cloud still
gets, scattered to it by the cloud around it; it always gets the skylight on top of that.
`0` leaves shadowed cloud lit by the sky alone (blue-grey, as in geostationary imagery near
the terminator); `1` switches cloud-on-cloud shadows off.

The old `cloudTwilightTint` is gone: cloud tops near the terminator redden because the
direct beam has crossed a long path of air, by exactly the amount `rayleighDepth` and
`ozoneDepth` give, and keep blue in their shadows from the skylight.

**`nightCloudLight`** (`0.02`). Brightness of cloud on the night side (moonlight, airglow,
city light scattered up), as a fraction of its daytime reflectance; it is tinted faintly
blue. The city lights in the Black Marble are on the same scale, so `0.02` keeps thick cloud
just visible against the dark ocean without competing with the lights.

### The night side and the terminator

The sunlit side is lit physically: brightness falls with the cosine of the sun's elevation,
and the direct beam reddens and fades through the last 10° before the terminator. The
night side gets no sunlight at all. A real single exposure would show nothing of it, so the
city lights are the night side's own exposure, blended in by:

**`nightFadeAngle`** (`12` degrees). How far below the horizon the sun has to be for the
city lights (and the Black Marble's faint land) to show at full brightness. They fade in
smoothly from the terminator. Civil twilight ends at 6°, astronomical at 18°; smaller values
bring the lights up close behind the terminator, larger ones leave a wider dark band.

**`cityLightSpread`** (`12` km). Unchanged: the blur of lights under cloud.

The old `dayColor`, `twilightColor` and the 18° "twilight" that kept the day texture lit past
the terminator are gone. The soft edge of the day side now comes from the skylight and the
reddened direct beam, and its width from `rayleighDepth`.

### Sea surface

**`windSpeed`** (`7.5` m/s). Sets the spread of wave slopes in the Cox & Munk glint; calmer
seas give a smaller, sharper glint.

**`glintBrightness`** (`0.75`). Scales the glint. The glint is a mirror image of the sun, so
it now takes the colour of the direct beam at that point (red near the terminator) and is
then seen through the air on the way up, like everything else. Its brightest part rolls off
softly like a saturating sensor (`glintMax` in the shader), since the real glint is many
times brighter than any cloud.

### Sea ice

`seaIceColor`, `seaIceFloeThreshold`, `seaIceFloeSize`: unchanged. The ice is an albedo like
the rest of the ground and gets the same lighting.

## Tone mapping

`viewer.js` uses `THREE.LinearToneMapping` with exposure 1.3. The scene is now in consistent
radiance units, so switching to `THREE.ACESFilmicToneMapping` (exposure around 1.0-1.2)
works and will keep the sunward limb and the glint from clipping to flat white, at the cost
of a slightly lower-contrast disk. Either is fine; the colours above were checked with the
linear setting.

## Recipes

- **More, whiter haze over the whole disk** (hazier, more like a wide-angle ISS photo):
  `mieDepth: 0.15`.
- **A clearer, bluer, higher-contrast disk** (more like a processed EPIC frame): `mieDepth:
  0.04`, `rayleighDepth: [0.046, 0.108, 0.265]`.
- **A brighter rim at the limb**: `multipleScattering: 2`. A thicker one: `atmosphereHeightScale: 5`.
- **The terminator too hard**: `skylight: 1.5` lifts the last few degrees; the width of the
  reddening is set by the air (`rayleighDepth`), not by a parameter.
- **Night lights starting too late or too early**: `nightFadeAngle`.
- **Cloud shadows too dark**: `cloudShadowAmbient: 0.5` or `skylight: 1.5`.
- **Everything too dark or too bright**: `renderer.toneMappingExposure`.

## Checking a change without the app

`scripts/atmosphere_prototype.py` is a numpy port of the model (the same functions, same
sampling) that renders the globe with the repository's Blue Marble textures and procedural
clouds from a chosen camera and sun position, and prints or saves linear and sRGB values. It
is how the defaults above were chosen:

```
python scripts/atmosphere_prototype.py '{"mieDepth": 0.15}' out.png
```
