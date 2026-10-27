/* earth.js - Earth globe rendering for Satellite Demo */
import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import gstime from './gstime.js';
import getSunPointingAngle from './sunangle.js';
import earthVertexShader from './shaders/earth/earthVertex.glsl';
import earthFragmentShader from './shaders/earth/earthFragment.glsl';
import nightGlowVertexShader from './shaders/earth/nightGlowVertex.glsl';
import nightGlowFragmentShader from './shaders/earth/nightGlowFragment.glsl';
import atmosphereVertexShader from './shaders/atmosphere/atmosphereVertex.glsl';
import atmosphereFragmentShader from './shaders/atmosphere/atmosphereFragment.glsl';

// Taken from this very popular stackoverflow thread: https://stackoverflow.com/questions/11381673/detecting-a-mobile-browser
// no I do not intend to support iemobile or blackberry, but it doesn't hurt anything to have them in there.
window.mobileAndSafariCheck = function () {
    // Detect Safari
    const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

    // Detect mobile devices (including tablets)
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

    return isSafari || isMobile;
};

// Widths of the day and night textures on the server (BlueMarble_WxH.avif and
// BlackMarble_WxH.avif, H = W / 2). The globe starts with the smallest, which satellites.html
// preloads, and moves up a size when the view shows more detail than the texture has.
const EARTH_TEXTURE_WIDTHS = [2048, 4096, 8192];

// Cloud texture sizes the gibs-cloud-texture worker makes. tileMatrix is the lowest GIBS level
// with at least as many pixels as the texture, so the worker shrinks the tiles rather than
// enlarging them; these match what its hourly job keeps ready (PREWARM_TILE_MATRIX in
// gibs-cloud-texture/wrangler.jsonc).
const CLOUD_RESOLUTIONS = [
    { name: '2k', width: 2048, tileMatrix: '3' },
    { name: '4k', width: 4096, tileMatrix: '3' },
    { name: '8k', width: 8192, tileMatrix: '4' }
];
const CLOUD_WIDTHS = CLOUD_RESOLUTIONS.map((r) => r.width);

// A texture has enough detail while it has at least this many texels per screen pixel where
// the globe is closest to the camera (and more everywhere else). Slightly under 1 so that a
// texture that is just short at the default view isn't replaced by one four times the size.
const MIN_TEXELS_PER_PIXEL = 0.8;

// Larger textures start loading once the camera's distance has held still this long (ms), so
// that zooming in loads the size for where the zoom ends, not every size on the way there
const DETAIL_SETTLE_MS = 250;

// Earth globe class to encapsulate all earth rendering functionality
export class Earth {
    constructor(scene, initialDate) {
        this.scene = scene;
        this.initialDate = initialDate || new Date();
        this.earth = null;
        this.atmosphere = null;
        this.earthMaterial = null;
        this.atmosphereMaterial = null;
        this.atmosphereUniforms = null; // shared by both materials (createAtmosphereUniforms)
        this.sunHelper = null; // unused except when debugging
        // this.sunHelper = this.initSunPointingHelper();

        // Parameters for globe rendering. The lighting and atmosphere ones are explained, with
        // what to change to get a given look, in docs/atmosphere-shader.md. They can be changed
        // at runtime through setParameter().
        this.parameters = {
            radius: 5,
            // color and strength of sunlight above the atmosphere (sRGB). White means the scene
            // is white-balanced to the sun, as a camera in daylight is; '#ffeedd' would reference
            // it to a D65 display white instead (the sun is slightly warm by that standard)
            sunColor: '#ffffff',

            // ---- the air (common/atmosphere.glsl) ----
            // The real atmosphere is thin: at the default view 8 km is about a pixel, so the glow
            // beyond the limb would be a hairline. This stretches the air's heights (the limb
            // glow's thickness and the twilight band's width) without changing how much air
            // there is, so the colors on the disk stay the same. 1 = the real atmosphere.
            atmosphereHeightScale: 3,
            // vertical optical depth of Rayleigh scattering (air molecules) in the red, green and
            // blue channels: how much of the overhead sun each channel loses to scattering on
            // its way down. The blue/red ratio is what makes the sky blue and the sunset red.
            // Derived spectrally for the sRGB primaries from tau(550 nm) = 0.098 (sea level).
            rayleighDepth: [0.046, 0.108, 0.265], // [0.051, 0.099, 0.238],
            // vertical optical depth of ozone absorption (the Chappuis band, 300 Dobson units):
            // mostly red, so long twilight paths come out bluer than Rayleigh alone would give
            ozoneDepth: [0.040, 0.015, 0.0],
            // vertical optical depth of aerosol haze (grey, at 550 nm). 0.05 is a very clean
            // marine atmosphere, 0.1 a typical global average, 0.3+ a dusty or polluted one.
            // More aerosol whitens the haze and the ocean and brightens the limb toward the sun.
            mieDepth: 0.04, // 0.08,
            // fraction of the light aerosols take out of a beam that they scatter rather than
            // absorb (soot lowers it, sea salt is near 1)
            mieAlbedo: 0.9,
            // how strongly aerosols scatter forward (Henyey-Greenstein g, 0 = evenly, 1 = all
            // forward); 0.7-0.8 for real haze
            mieAnisotropy: 0.76,
            // extra light from sunlight scattered more than once, as a multiple of what single
            // scattering gives, applied where the air is optically thick (the limb). 0 = single
            // scattering only (a darker, bluer limb); 1-2 is about what full solutions give.
            multipleScattering: 2.0, // 1.0,
            // scales the diffuse skylight on the ground and cloud tops: it is blue, it lights
            // cloud shadows and the shadowed side of cloud banks, and it is what is left of the
            // daylight in the last few degrees before the terminator
            skylight: 1.0,

            // ---- clouds ----
            // scales cloud reflectance; above 1 brightens thin clouds, below 1 makes them sheerer
            cloudBrightness: 1.0,
            // top height (km) of the thickest clouds, used to cast shadows (thinner clouds are
            // lower). Real cloud tops reach about 12 km; shadows from that are under a pixel at
            // globe scale except near the terminator, so this is exaggerated
            cloudShadowHeight: 30,
            // shading of cloud tops by their slope toward or away from the sun (0 = flat)
            cloudRelief: 0.6,
            // direct sunlight a cloud top shaded by another cloud still gets, scattered to it by
            // the cloud around it (0 = only skylight, 1 = shadows have no effect)
            cloudShadowAmbient: 0.3,
            // brightness of cloud on the night side (moonlight, airglow), relative to the
            // cloud's daytime reflectance; the night texture's lights are on the same scale
            nightCloudLight: 0.02,

            // ---- the observer: twilight and the night side (observerAdaptation() in
            // earthFragment.glsl) ----
            // A single exposure shows the band either side of the terminator as black: the ground
            // there gets under 1% of the noon sun's light. The eye adapts to the light around
            // what it looks at, so it sees the clouds in that band, and the city lights beyond it.
            // How far the dim ground near the terminator is brightened: 0 = one fixed exposure
            // (the physical falloff), 1 = everything shown as in full daylight. With 0.6, clouds
            // stay visible to about 4 degrees past the terminator, where the lights have come up.
            twilightAdaptation: 0.8, // 0.6,
            // illumination (fraction of the overhead sun's) above which the eye doesn't adapt, so
            // the sunlit disk looks exactly as the physics gives it. 0.3 is the sun ~20 degrees up.
            adaptationKnee: 0.3,
            // the illumination at which the view is half day- and half night-adapted: the city
            // lights are at half brightness here, full well below it and gone well above it. It
            // also caps how far the twilight is brightened. 1e-3 is the sun ~2.5 degrees below the
            // horizon; larger values bring the lights in sooner (closer to the terminator).
            nightAdaptationLevel: 1e-3,
            // how far city light spreads sideways inside cloud before it escapes (km, one standard
            // deviation of the glow). Real cloud spreads it over a few km to ten, which is about a
            // pixel at globe scale, so this is a little exaggerated; much more and neighbouring
            // cities run together
            cityLightSpread: 12,

            // ---- sea ice ----
            // color of sea ice (sRGB): nearly white, as snow-covered floes are. Loose floes are
            // drawn a little greyer (thinner ice), and the sea shows between them. At night the
            // sea ice takes the Black Marble's color for the ice sheets instead, read from the
            // night texture (blackMarbleIce() in earthFragment.glsl)
            seaIceColor: '#f1f5f8',
            // concentration from which sea ice is drawn as solid pack; below it, the ice breaks up
            // into floes that get smaller and further apart as the concentration falls
            seaIceFloeThreshold: 0.9,
            // size (km) of the cells holding the large floes; small floes are a quarter of this.
            // Real floes are mostly smaller, but these are what makes the 25 km data look like
            // broken ice at globe scale. They show once a cell is a few pixels across.
            seaIceFloeSize: 80,

            // ---- sea surface ----
            // sea surface wind speed (m/s): calmer seas give a smaller, sharper sun glint
            windSpeed: 5.0,
            // scales the sun glint (its brightest part rolls off softly, like a saturating sensor)
            glintBrightness: 0.75
        };

        // Whether the viewer wants clouds and sea ice shown (the settings menu); each appears once
        // its texture has loaded
        this.cloudsVisible = true;
        this.seaIceVisible = true;

        // Texture sizes in use and being loaded (see updateDetail). The upgrades stop at the
        // largest size the device gets (getMaxTextureWidth), and skip sizes that failed to load.
        this.isMobileOrSafari = window.mobileAndSafariCheck();
        this.useLowRes = false;
        this.earthTextureWidth = 0;
        this.earthTextureLoading = null;
        this.earthTextureFailed = new Set();
        this.cloudResolution = null;
        this.cloudLoading = null;
        this.cloudFailed = new Set();
        this.cameraDistance = 0;
        this.cameraMovedAt = -Infinity;

        // Whether the textured globe is in the scene (initialize() has finished)
        this.ready = false;

        // Resolves when the textured globe goes into the scene, so the clouds can start
        // downloading before then (loadCloudTexture waits for it before applying them)
        this.materialReady = new Promise((resolve) => {
            this.resolveMaterialReady = resolve;
        });

        // Calculate initial rotation based on sidereal time
        this.gmst = gstime(this.initialDate);

        // Create temporary sphere while textures load
        this.createTemporaryEarth();
    }

    createTemporaryEarth() {
        const earthGeometry = new THREE.SphereGeometry(this.parameters.radius, 64, 64);
        this.tempEarth = new THREE.Mesh(
            earthGeometry,
            new THREE.MeshBasicMaterial({ color: 0x0e1118 })
        );
        this.scene.add(this.tempEarth);
        return this.tempEarth;
    }

    // Enhanced texture loading function with retry capability
    // This functionality was added in response to texture loads failing on first
    // load on some devices due to a non-deterministic race condition
    async loadTexture(url, options = {}, retryCount = 3, retryDelay = 100) {
        const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

        const attemptLoad = async (remainingAttempts) => {
            try {
                if (!window.mobileAndSafariCheck() && 'createImageBitmap' in window) {
                    // ImageBitmapLoader is preferred for loading textures onto the
                    // globe as it reduces memory usage and load times
                    return await this.loadWithImageBitmap(url, options);
                } else {
                    // TextureLoader is a fallback method for Safari and mobile devices
                    return await this.loadWithTextureLoader(url);
                }
            } catch (error) {
                if (remainingAttempts > 0) {
                    console.warn(`Attempt failed for ${url}, retrying in ${retryDelay}ms. Attempts remaining: ${remainingAttempts}`);
                    await delay(retryDelay);
                    return attemptLoad(remainingAttempts - 1);
                }
                throw error;
            }
        };

        return attemptLoad(retryCount);
    }

    // Helper function for ImageBitmapLoader logic
    loadWithImageBitmap(url, options = {}) {
        return new Promise((resolve, reject) => {
            const imageLoader = new THREE.ImageBitmapLoader();
            imageLoader.setCrossOrigin('anonymous');
            imageLoader.setOptions({ imageOrientation: 'flipY', ...options });

            imageLoader.load(
                url,
                imageBitmap => {
                    const texture = new THREE.CanvasTexture(imageBitmap);
                    resolve(texture);
                },
                undefined,
                error => {
                    reject(new Error(`Failed to load texture from ${url}: ${error.message}`));
                }
            );
        });
    }

    // Helper function for TextureLoader logic
    loadWithTextureLoader(url) {
        return new Promise((resolve, reject) => {
            const textureLoader = new THREE.TextureLoader();
            textureLoader.setCrossOrigin('anonymous');

            textureLoader.load(
                url,
                texture => {
                    resolve(texture);
                },
                undefined,
                error => {
                    reject(new Error(`Failed to load texture from ${url}: ${error.message}`));
                }
            );
        });
    }

    // Day, night and specular textures at the given width of the day and night textures. The
    // specular map (land/ocean mask) is only ever 2048 wide; it has no fine detail.
    getTextureUrls(width = EARTH_TEXTURE_WIDTHS[0]) {
        const baseUrl = window.location.origin || '.';
        return [
            `${baseUrl}/BlueMarble_${width}x${width / 2}.avif`,
            `${baseUrl}/BlackMarble_${width}x${width / 2}.avif`,
            `${baseUrl}/EarthSpec_2048x1024.avif`
        ];
    }

    // The largest day/night texture this device gets. Mobile devices and Safari stay at 2048 x 1024:
    // Safari chokes on loading images as bitmaps, and the creation of a WebGL context can fail on
    // lower-end mobile devices when decompressing large textures. The landing page (useLowRes)
    // also stays at 2048.
    getMaxTextureWidth(widths) {
        if (this.isMobileOrSafari || this.useLowRes) {
            return widths[0];
        }
        const maxTextureSize = this.scene.renderer?.capabilities.maxTextureSize ?? 4096;
        return widths.filter((w) => w <= maxTextureSize).pop() ?? widths[0];
    }

    // The first cloud texture: 2048 x 1024 wherever the Earth textures are capped at 2048
    // (mobile, Safari, the landing page), otherwise 4096 x 2048, which has more than a texel per
    // pixel at the default view even on high-DPI screens. 8192 x 4096 (18 MB) only loads once
    // the camera is close enough to need it (updateDetail).
    getInitialCloudResolution() {
        return this.getMaxTextureWidth(CLOUD_WIDTHS) > 2048 ? CLOUD_RESOLUTIONS[1] : CLOUD_RESOLUTIONS[0];
    }

    // URL of the cloud texture made by the gibs-cloud-texture worker (proxied at /cloud-texture).
    // product=albedo returns a greyscale PNG of the clouds' visible reflectance, worked out from
    // NOAA-20 VIIRS cloud optical thickness. GIBS takes about two days to finish a day's data,
    // so ask for the day two days before the scene time (never later than now).
    getCloudTextureUrl(resolution) {
        const sceneTime = Math.min(this.initialDate.getTime(), Date.now());
        const date = new Date(sceneTime - 2 * 86400000).toISOString().slice(0, 10);
        const params = new URLSearchParams({
            date,
            tileMatrix: resolution.tileMatrix,
            outputRes: resolution.name,
            product: 'albedo'
        });
        return `${window.location.origin || '.'}/cloud-texture?${params}`;
    }

    // Load one of the gibs-cloud-texture worker's data textures: a greyscale PNG whose single
    // channel holds a value per texel rather than a color. RedFormat keeps it at one byte per
    // texel on the GPU (32 MB at 8k instead of 128 MB as RGBA).
    async loadDataTexture(url) {
        // premultiplyAlpha must be passed explicitly: setOptions replaces ImageBitmapLoader's defaults
        const texture = await this.loadTexture(url, { premultiplyAlpha: 'none' }, 2, 1000);
        texture.format = THREE.RedFormat;
        texture.colorSpace = THREE.NoColorSpace;
        // wrap across the antimeridian (the cloud shadow lookups step over it)
        texture.wrapS = THREE.RepeatWrapping;
        texture.anisotropy = Math.min(8,
            this.scene.renderer?.capabilities.getMaxAnisotropy() || 8);
        texture.needsUpdate = true;
        return texture;
    }

    // Load the cloud texture in the background and switch the clouds on once it arrives. This
    // can be called before initialize() has finished (the download starts right away and the
    // texture is applied once the globe exists). The globe renders normally in the meantime, and
    // stays cloudless if loading fails. Called again with a larger resolution, it replaces the
    // current texture once the new one has loaded.
    async loadCloudTexture(resolution = this.getInitialCloudResolution()) {
        this.cloudLoading = resolution;
        const url = this.getCloudTextureUrl(resolution);
        try {
            // sqrt(cloud reflectance) per texel
            const cloudTexture = await this.loadDataTexture(url);

            await this.materialReady;
            // Upload it now, in its own task, rather than in the middle of the next frame
            this.scene.renderer?.initTexture(cloudTexture);

            const uniforms = this.earthMaterial.uniforms;
            const previous = uniforms.cloudTexture.value;
            uniforms.cloudTexture.value = cloudTexture;
            // unless the viewer hid the clouds while they were loading
            uniforms.showClouds.value = this.cloudsVisible;
            disposeTexture(previous);
            this.cloudResolution = resolution;
            return cloudTexture;
        } catch (error) {
            // Keep the clouds already shown, if any, and don't try this size again
            console.error('Failed to load cloud texture:', error);
            this.cloudFailed.add(resolution.width);
            if (this.cloudResolution === null && this.earthMaterial) {
                this.earthMaterial.uniforms.showClouds.value = false;
            }
            return null;
        } finally {
            this.cloudLoading = null;
        }
    }

    // URL of the sea ice texture made by the gibs-cloud-texture worker (proxied at
    // /sea-ice-texture): sea ice concentration (0-1) per texel from the NSIDC Sea Ice Index's
    // daily Arctic and Antarctic grids. NSIDC publishes a day's grids the next day, so ask for
    // the day before the scene time (never later than now); the worker serves the newest day it
    // has at or before that. The grids are 25 km, so 4096x2048 (about 10 km per texel north to
    // south) already shows all their detail, and 2048x1024 wherever the Earth textures drop to
    // low resolution. Both are what the worker's hourly job keeps ready.
    getSeaIceTextureUrl(useLowRes = false) {
        const sceneTime = Math.min(this.initialDate.getTime(), Date.now());
        const params = new URLSearchParams({
            date: new Date(sceneTime - 86400000).toISOString().slice(0, 10),
            outputRes: this.isMobileOrSafari || useLowRes ? '2k' : '4k'
        });
        return `${window.location.origin || '.'}/sea-ice-texture?${params}`;
    }

    // Load the sea ice texture in the background, as for clouds: the globe renders without sea
    // ice until it arrives, and carries on without it if loading fails. Can be called before
    // initialize() has finished; the texture is applied once the globe exists.
    async loadSeaIceTexture() {
        const url = this.getSeaIceTextureUrl(this.useLowRes);
        try {
            const seaIceTexture = await this.loadDataTexture(url);

            await this.materialReady;
            this.scene.renderer?.initTexture(seaIceTexture);

            const uniforms = this.earthMaterial.uniforms;
            const previous = uniforms.seaIceTexture.value;
            uniforms.seaIceTexture.value = seaIceTexture;
            // unless the viewer hid the sea ice while it was loading
            uniforms.showSeaIce.value = this.seaIceVisible;
            previous?.dispose();
            return seaIceTexture;
        } catch (error) {
            console.error('Failed to load sea ice texture:', error);
            if (this.earthMaterial) {
                this.earthMaterial.uniforms.showSeaIce.value = false;
            }
            return null;
        }
    }

    // Texels needed across the full width (360 degrees) of a texture for it to have
    // MIN_TEXELS_PER_PIXEL where the globe is closest to the camera, which is where the texture
    // is magnified the most. A degree of longitude there spans radius / (distance - radius) of
    // the camera's view, in radians.
    getRequiredTextureWidth(camera) {
        const canvas = this.scene.renderer?.domElement;
        if (!canvas || !camera?.isPerspectiveCamera) {
            return 0;
        }
        const radius = this.parameters.radius;
        const altitude = Math.max(camera.position.distanceTo(this.earth.position) - radius, 0.01 * radius);
        const pixelsPerRadian = (radius / altitude) * camera.zoom * canvas.height /
            (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
        return 2 * Math.PI * pixelsPerRadian * MIN_TEXELS_PER_PIXEL;
    }

    // Called every frame: starts loading larger day/night or cloud textures when the camera has
    // come close enough to show more detail than the current ones have (and has stopped moving
    // toward or away from the globe; see DETAIL_SETTLE_MS). Textures are never
    // swapped for smaller ones (moving away keeps the larger texture, which the GPU's mipmaps
    // already handle), so each size loads at most once.
    updateDetail(camera) {
        if (!this.ready || this.useLowRes) {
            return;
        }
        const now = performance.now();
        const distance = camera.position.distanceTo(this.earth.position);
        if (Math.abs(distance - this.cameraDistance) > 0.002 * distance) {
            this.cameraMovedAt = now;
        }
        this.cameraDistance = distance;
        if (now - this.cameraMovedAt < DETAIL_SETTLE_MS) {
            return;
        }
        const required = this.getRequiredTextureWidth(camera);

        if (this.earthTextureLoading === null) {
            const width = this.pickTextureWidth(EARTH_TEXTURE_WIDTHS, required, this.earthTextureFailed);
            if (width > this.earthTextureWidth) {
                this.loadEarthTextures(width);
            }
        }

        // Upgrades start from the first cloud texture, and not while the clouds are hidden
        if (this.cloudLoading === null && this.cloudResolution !== null && this.cloudsVisible) {
            const width = this.pickTextureWidth(CLOUD_WIDTHS, required, this.cloudFailed);
            if (width > this.cloudResolution.width) {
                this.loadCloudTexture(CLOUD_RESOLUTIONS.find((r) => r.width === width));
            }
        }
    }

    // The smallest of the widths that is at least the required width, or else the largest,
    // leaving out those the device doesn't get and those that failed to load
    pickTextureWidth(widths, required, failed) {
        const maxWidth = this.getMaxTextureWidth(widths);
        const usable = widths.filter((w) => w <= maxWidth && !failed.has(w));
        return usable.find((w) => w >= required) ?? usable[usable.length - 1] ?? 0;
    }

    // Replace the day and night textures with larger ones (see updateDetail)
    async loadEarthTextures(width) {
        this.earthTextureLoading = width;
        try {
            const [dayUrl, nightUrl] = this.getTextureUrls(width);
            const [day, night] = await Promise.all(
                [dayUrl, nightUrl].map((url) => this.loadTexture(url, {}, 1, 500))
            );
            this.configureEarthTextures(day, night);

            // Upload them a frame apart, so neither upload lands in the same task as the other
            // or as the night glow redraw that follows
            const renderer = this.scene.renderer;
            renderer?.initTexture(day);
            await nextFrame();
            renderer?.initTexture(night);
            await nextFrame();

            const uniforms = this.earthMaterial.uniforms;
            const previousDay = uniforms.dayTexture.value;
            const previousNight = uniforms.nightTexture.value;
            uniforms.dayTexture.value = day;
            uniforms.nightTexture.value = night;
            // the glow is made at up to 4096 wide, limited by the night texture's width
            this.nightGlow.needsUpdate = true;
            disposeTexture(previousDay);
            disposeTexture(previousNight);
            this.earthTextureWidth = width;
        } catch (error) {
            // e.g. a size that isn't on the server: keep the current textures, and skip this size
            console.warn(`Failed to load the ${width}-wide Earth textures:`, error);
            this.earthTextureFailed.add(width);
        } finally {
            this.earthTextureLoading = null;
        }
    }

    configureEarthTextures(day, night) {
        const anisotropy = Math.min(8, this.scene.renderer?.capabilities.getMaxAnisotropy() || 8);
        for (const texture of [day, night]) {
            texture.colorSpace = THREE.SRGBColorSpace;
            texture.anisotropy = anisotropy;
        }
        // the night glow blur reads across the antimeridian
        night.wrapS = THREE.RepeatWrapping;
    }


    // Show or hide the clouds (null flips them). This is the viewer's choice, so it also holds
    // for clouds still loading: they appear when they arrive only if clouds are on. Returns
    // whether clouds are on.
    toggleClouds(visible = null) {
        this.cloudsVisible = visible === null ? !this.cloudsVisible : Boolean(visible);
        const uniforms = this.earthMaterial?.uniforms;
        if (uniforms) {
            uniforms.showClouds.value = this.cloudsVisible && uniforms.cloudTexture.value !== null;
        }

        console.log(`Clouds are now ${this.cloudsVisible ? 'visible' : 'hidden'}`);
        return this.cloudsVisible;
    }

    // Show or hide the sea ice (null flips it), the same way as toggleClouds. Returns whether
    // sea ice is on.
    toggleSeaIce(visible = null) {
        this.seaIceVisible = visible === null ? !this.seaIceVisible : Boolean(visible);
        const uniforms = this.earthMaterial?.uniforms;
        if (uniforms) {
            uniforms.showSeaIce.value = this.seaIceVisible && uniforms.seaIceTexture.value !== null;
        }

        console.log(`Sea ice is now ${this.seaIceVisible ? 'visible' : 'hidden'}`);
        return this.seaIceVisible;
    }

    // Main initialization function for the globe
    async initialize(interactiveLayer, useLowRes = false) {
        this.useLowRes = useLowRes;
        // Always start with the smallest textures (preloaded by satellites.html): they show the
        // globe soonest, and at the default view on a standard-DPI screen they already have a
        // texel per pixel. updateDetail() loads larger ones when the screen or the zoom needs them.
        const earthImageUrls = this.getTextureUrls(EARTH_TEXTURE_WIDTHS[0]);

        try {
            // Load all textures
            const textures = await Promise.all(
                earthImageUrls.map(url => this.loadTexture(url, {}, 3, 100))
            );

            const [blueMarble, blackMarble, earthSpec] = textures;
            this.configureEarthTextures(blueMarble, blackMarble);
            this.earthTextureWidth = EARTH_TEXTURE_WIDTHS[0];

            await this.createEarth(blueMarble, blackMarble, earthSpec, interactiveLayer);
            await this.createAtmosphere();

            // Compile the globe's shaders before showing it. Where the browser has
            // KHR_parallel_shader_compile (Chrome, Edge, Firefox, Safari) they compile in the
            // background, so the frame that first shows the globe doesn't stall on them.
            // (Capped at a few seconds in case the context is lost while compiling.)
            const renderer = this.scene.renderer;
            if (renderer?.compileAsync && renderer.extensions.has('KHR_parallel_shader_compile')) {
                const camera = new THREE.PerspectiveCamera();
                const compiled = Promise.all([this.earth, this.atmosphere].map(
                    (mesh) => renderer.compileAsync(mesh, camera, this.scene)));
                await Promise.race([compiled, new Promise((resolve) => setTimeout(resolve, 3000))]);
            }
            this.scene.add(this.earth);
            this.scene.add(this.atmosphere);
            this.ready = true;
            this.resolveMaterialReady();

            // Remove temporary earth
            if (this.tempEarth) {
                this.scene.remove(this.tempEarth);
                this.tempEarth = null;
            }

            // Debug plane for checking seasonal variation (if needed)
            if (this.initialDate.getTime() === Date.UTC(2024, 2, 24, 3, 6, 0, 0)) {
                this.initSunPointingHelper();
            }

            return this;
        } catch (error) {
            console.error('Failed to load Earth textures:', error);
            throw error;
        }
    }

    // The uniforms declared in shaders/common/atmosphere.glsl, which both the Earth and the
    // atmosphere shaders include. The two materials share these objects, so changing a value
    // here (setParameter) changes it for both, and the haze on the disk always matches the glow
    // beyond the limb.
    createAtmosphereUniforms() {
        const p = this.parameters;
        this.atmosphereUniforms = {
            sunDirection: new THREE.Uniform(new THREE.Vector3(0, 0, 1)),
            sunColor: new THREE.Uniform(new THREE.Color(p.sunColor)),
            earthRadius: new THREE.Uniform(p.radius),
            atmosphereHeightScale: new THREE.Uniform(p.atmosphereHeightScale),
            rayleighDepth: new THREE.Uniform(new THREE.Vector3(...p.rayleighDepth)),
            ozoneDepth: new THREE.Uniform(new THREE.Vector3(...p.ozoneDepth)),
            mieDepth: new THREE.Uniform(p.mieDepth),
            mieAlbedo: new THREE.Uniform(p.mieAlbedo),
            mieAnisotropy: new THREE.Uniform(p.mieAnisotropy),
            multipleScattering: new THREE.Uniform(p.multipleScattering),
            skylight: new THREE.Uniform(p.skylight)
        };
        return this.atmosphereUniforms;
    }

    // Radius of the shell the limb glow is drawn on: the top of the atmosphere as the shaders
    // see it (100 km, stretched by atmosphereHeightScale), with a little margin
    atmosphereShellRadius() {
        return this.parameters.radius * (1 + 100 / 6371 * this.parameters.atmosphereHeightScale) * 1.005;
    }

    // Change a rendering parameter while the scene is running, e.g. from a GUI or the console:
    //   earth.setParameter('mieDepth', 0.2)
    //   earth.setParameter('rayleighDepth', [0.046, 0.108, 0.265])
    //   earth.setParameter('sunColor', '#ffeedd')
    // Parameters that shape geometry or textures (radius, cityLightSpread, seaIceFloeSize)
    // and atmosphereHeightScale, which sets the glow shell's size, are not applied live.
    setParameter(name, value) {
        if (!(name in this.parameters)) {
            throw new Error(`Unknown parameter ${name}`);
        }
        this.parameters[name] = value;
        const uniforms = this.earthMaterial?.uniforms;
        if (!uniforms) return;
        const setters = {
            sunColor: () => uniforms.sunColor.value.set(value),
            rayleighDepth: () => uniforms.rayleighDepth.value.fromArray(value),
            ozoneDepth: () => uniforms.ozoneDepth.value.fromArray(value),
            seaIceColor: () => uniforms.seaIceColor.value.set(value),
            cloudShadowHeight: () => { uniforms.cloudShadowHeight.value = value * this.parameters.radius / 6371; }
        };
        if (setters[name]) {
            setters[name]();
        } else if (name in uniforms) {
            uniforms[name].value = value;
        }
    }

    async createEarth(blueMarble, blackMarble, earthSpec, interactiveLayer) {
        const earthGeometry = new THREE.SphereGeometry(this.parameters.radius, 64, 64);

        // Shader material with added cloud and sea ice texture uniforms
        this.earthMaterial = new THREE.ShaderMaterial({
            uniforms: {
                ...this.createAtmosphereUniforms(),
                dayTexture: new THREE.Uniform(blueMarble),
                nightTexture: new THREE.Uniform(blackMarble),
                specularMapTexture: new THREE.Uniform(earthSpec),
                twilightAdaptation: new THREE.Uniform(this.parameters.twilightAdaptation),
                adaptationKnee: new THREE.Uniform(this.parameters.adaptationKnee),
                nightAdaptationLevel: new THREE.Uniform(this.parameters.nightAdaptationLevel),
                nightCloudLight: new THREE.Uniform(this.parameters.nightCloudLight),
                // Clouds: set by loadCloudTexture() once the texture has arrived
                cloudTexture: new THREE.Uniform(null),
                showClouds: new THREE.Uniform(false),
                cloudBrightness: new THREE.Uniform(this.parameters.cloudBrightness),
                cloudShadowHeight: new THREE.Uniform(this.parameters.cloudShadowHeight * this.parameters.radius / 6371),
                cloudRelief: new THREE.Uniform(this.parameters.cloudRelief),
                cloudShadowAmbient: new THREE.Uniform(this.parameters.cloudShadowAmbient),
                // Sea ice: set by loadSeaIceTexture() once the texture has arrived
                seaIceTexture: new THREE.Uniform(null),
                showSeaIce: new THREE.Uniform(false),
                seaIceColor: new THREE.Uniform(new THREE.Color(this.parameters.seaIceColor)),
                seaIceFloeThreshold: new THREE.Uniform(this.parameters.seaIceFloeThreshold),
                // cells per unit of the shader's polar plane, which is 2 Earth radii at the pole
                seaIceFloeScale: new THREE.Uniform(2 * 6371 / this.parameters.seaIceFloeSize),
                windSpeed: new THREE.Uniform(this.parameters.windSpeed),
                glintBrightness: new THREE.Uniform(this.parameters.glintBrightness),
                time: new THREE.Uniform(0.0),
                // set in onBeforeRender below
                retinaStrength: new THREE.Uniform(0.0),
                // made from the night texture the first time the globe is drawn (bakeNightGlow)
                nightGlowTexture: new THREE.Uniform(null)
            },
            vertexShader: earthVertexShader,
            fragmentShader: earthFragmentShader
        });

        this.createNightGlow();

        // added to the scene by initialize(), once its shaders are compiled
        this.earth = new THREE.Mesh(earthGeometry, this.earthMaterial);
        this.earth.name = 'earth';

        // The retina effect only depends on the camera and the sun, so work it out once per
        // frame here instead of in every fragment (this was retinaEffect() in the shader)
        const cameraPosition = new THREE.Vector3();
        const sunToCamera = new THREE.Vector3();
        const { smoothstep } = THREE.MathUtils;
        this.earth.onBeforeRender = (renderer, scene, camera) => {
            const uniforms = this.earthMaterial.uniforms;
            if (this.nightGlow?.needsUpdate) {
                this.bakeNightGlow(renderer);
            }
            cameraPosition.setFromMatrixPosition(camera.matrixWorld);
            sunToCamera.copy(uniforms.sunDirection.value).multiplyScalar(-1000).add(cameraPosition).normalize();
            const b = 2 * sunToCamera.dot(cameraPosition);
            const c = cameraPosition.lengthSq() - this.parameters.radius * this.parameters.radius;
            const disc = (b * b - 4 * c) * smoothstep(b, 0, 2);
            uniforms.retinaStrength.value = smoothstep(disc, 10, 100);
        };

        // Set initial rotation based on sidereal time
        this.earth.rotation.y = this.gmst;

        // Enable raycaster collisions with this object to prevent selecting satellites on the
        // backside of the earth
        if (interactiveLayer !== undefined) {
            this.earth.layers.enable(interactiveLayer);
        }

        return this.earth;
    }

    // City lights under cloud become soft glows (see nightGlowFragment.glsl). The glow is the
    // night texture blurred by cityLightSpread, which never changes, so it is drawn once, the first
    // time the globe is rendered, and the Earth shader reads one texel of it per pixel under cloud.
    // Set this.nightGlow.needsUpdate = true after changing cityLightSpread to redraw it.
    createNightGlow() {
        const material = new THREE.ShaderMaterial({
            uniforms: {
                source: new THREE.Uniform(null),
                spread: new THREE.Uniform(0),
                eastWest: new THREE.Uniform(true),
                sourceLod: new THREE.Uniform(0),
                targetWidth: new THREE.Uniform(1)
            },
            vertexShader: nightGlowVertexShader,
            fragmentShader: nightGlowFragmentShader,
            depthTest: false,
            depthWrite: false
        });
        this.nightGlow = { quad: new FullScreenQuad(material), target: null, needsUpdate: true };
    }

    // Draws the glow. Called from the globe's onBeforeRender, so it runs inside the frame's render
    // (as three's Reflector does) and needs no renderer of its own.
    bakeNightGlow(renderer) {
        const glow = this.nightGlow;
        const night = this.earthMaterial.uniforms.nightTexture.value;
        const nightWidth = night?.image?.width;
        if (!nightWidth) return;

        // Enough resolution for about 1.25 texels per standard deviation, which bilinear
        // filtering turns into smooth round glows: 4096 x 2048 (45 MB with mipmaps) at the default
        // 12 km, or 2048 x 1024 (11 MB) for spreads of 20 km and up and wherever the night
        // texture itself is 2048 wide
        const spread = this.parameters.cityLightSpread / 6371;
        const ideal = 1.25 * 2 * Math.PI / spread;
        const width = Math.min(Math.max(2 ** Math.round(Math.log2(ideal)), 256), 4096, nightWidth);
        const height = width / 2;

        // The glow is stored sRGB-encoded in 8 bits, like the night texture itself, which keeps the
        // dim edges of the glows free of banding. The first pass's output is only needed briefly.
        const options = {
            depthBuffer: false,
            colorSpace: THREE.SRGBColorSpace,
            magFilter: THREE.LinearFilter,
            wrapS: THREE.RepeatWrapping
        };
        const eastWest = new THREE.WebGLRenderTarget(width, height, { ...options, minFilter: THREE.LinearFilter });
        if (!glow.target || glow.target.width !== width) {
            glow.target?.dispose();
            glow.target = new THREE.WebGLRenderTarget(width, height, {
                ...options,
                generateMipmaps: true,
                minFilter: THREE.LinearMipmapLinearFilter
            });
        }

        const uniforms = glow.quad.material.uniforms;
        uniforms.spread.value = spread;
        uniforms.targetWidth.value = width;
        const previousTarget = renderer.getRenderTarget();

        uniforms.source.value = night;
        uniforms.eastWest.value = true;
        uniforms.sourceLod.value = Math.max(Math.log2(nightWidth / width), 0);
        renderer.setRenderTarget(eastWest);
        glow.quad.render(renderer);

        uniforms.source.value = eastWest.texture;
        uniforms.eastWest.value = false;
        uniforms.sourceLod.value = 0;
        renderer.setRenderTarget(glow.target);
        glow.quad.render(renderer); // three makes the mipmaps afterwards

        renderer.setRenderTarget(previousTarget);
        uniforms.source.value = null;
        eastWest.dispose();

        this.earthMaterial.uniforms.nightGlowTexture.value = glow.target.texture;
        glow.needsUpdate = false;
    }

    async createAtmosphere() {
        // The glow beyond the limb is drawn on the inside of a sphere just outside the top of
        // the atmosphere; the globe itself draws the air in front of the disk
        const atmosphereGeometry = new THREE.SphereGeometry(this.atmosphereShellRadius(), 64, 64);

        this.atmosphereMaterial = new THREE.ShaderMaterial({
            vertexShader: atmosphereVertexShader,
            fragmentShader: atmosphereFragmentShader,
            // the same uniform objects as the Earth material (createAtmosphereUniforms)
            uniforms: this.atmosphereUniforms,
            side: THREE.BackSide,
            transparent: true,
            depthWrite: false
        });

        // added to the scene by initialize(), once its shaders are compiled
        this.atmosphere = new THREE.Mesh(atmosphereGeometry, this.atmosphereMaterial);
        this.atmosphere.name = 'atm';

        // Set initial rotation based on sidereal time
        this.atmosphere.rotation.y = this.gmst;

        return this.atmosphere;
    }

    initSunPointingHelper() {
        // Create the sun pointing helper for debugging
        const length = 7;
        const color = 0x00ffff;
        this.sunHelper = new THREE.ArrowHelper(
            getSunPointingAngle(this.initialDate),
            new THREE.Vector3(0, 0, 0),
            length,
            color
        );
        this.scene.add(this.sunHelper);
    }

    // Update method called during animation
    update(currentDate) {
        if (!this.earth || !this.atmosphere) return;

        // Update rotation based on current time
        const siderealTime = gstime(currentDate);
        this.earth.rotation.y = siderealTime;
        this.atmosphere.rotation.y = siderealTime;

        // Update the sun direction (the uniform is shared by the earth and atmosphere materials)
        const sunDirection = getSunPointingAngle(currentDate);
        this.atmosphereUniforms.sunDirection.value.copy(sunDirection);

        this.earthMaterial.uniforms.time.value = performance.now() * 0.001;

        // Update sun helper if present
        if (this.sunHelper) {
            this.sunHelper.setDirection(sunDirection);
        }
    }

    // Clean up resources
    dispose() {
        if (this.earth) {
            this.scene.remove(this.earth);
            this.earth.geometry.dispose();
            this.earthMaterial.dispose();
            this.earth = null;
        }

        if (this.atmosphere) {
            this.scene.remove(this.atmosphere);
            this.atmosphere.geometry.dispose();
            this.atmosphereMaterial.dispose();
            this.atmosphere = null;
        }

        if (this.sunHelper) {
            this.scene.remove(this.sunHelper);
            this.sunHelper = null;
        }

        if (this.nightGlow) {
            this.nightGlow.target?.dispose();
            this.nightGlow.quad.material.dispose();
            this.nightGlow.quad.dispose();
            this.nightGlow = null;
        }
    }
}

// Free a texture's GPU memory and, for one loaded with ImageBitmapLoader, its decoded image
function disposeTexture(texture) {
    if (!texture) {
        return;
    }
    texture.dispose();
    if (typeof ImageBitmap !== 'undefined' && texture.image instanceof ImageBitmap) {
        texture.image.close();
    }
}

function nextFrame() {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

// Function to create and initialize an Earth instance
export async function initEarth(scene, initialDate, interactiveLayer, useLowRes = false) {
    // Yes, I'm a proud globehead :p
    const globe = new Earth(scene, initialDate);
    await globe.initialize(interactiveLayer, useLowRes);
    return globe;
}
