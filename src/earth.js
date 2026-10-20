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

// Earth globe class to encapsulate all earth rendering functionality
export class Earth {
    constructor(scene, initialDate) {
        this.scene = scene;
        this.initialDate = initialDate || new Date();
        this.earth = null;
        this.atmosphere = null;
        this.earthMaterial = null;
        this.atmosphereMaterial = null;
        this.sunHelper = null; // unused except when debugging
        // this.sunHelper = this.initSunPointingHelper();

        // Parameters for globe rendering
        this.parameters = {
            radius: 5,
            dayColor: '#d7eaf9',
            twilightColor: '#fd5e53',
            // scales cloud reflectance; above 1 brightens thin clouds, below 1 makes them sheerer
            cloudBrightness: 1.0,
            // top height (km) of the thickest clouds, used to cast shadows (thinner clouds are
            // lower). Real cloud tops reach about 12 km; shadows from that are under a pixel at
            // globe scale except near the terminator, so this is exaggerated
            cloudShadowHeight: 30,
            // shading of cloud tops by their slope toward or away from the sun (0 = flat)
            cloudRelief: 0.6,
            // reddening of cloud tops near the terminator (0 = none, 1 = full sunset color)
            cloudTwilightTint: 0.2,
            // how far city light spreads sideways inside cloud before it escapes (km, one standard
            // deviation of the glow). Real cloud spreads it over a few km to ten, which is about a
            // pixel at globe scale, so this is a little exaggerated; much more and neighbouring
            // cities run together
            cityLightSpread: 12,
            // sea surface wind speed (m/s): calmer seas give a smaller, sharper sun glint
            windSpeed: 5,
            glintBrightness: 1.5,
            // haze over the globe toward the limb (0 = none), and the brightness of sunlit haze where
            // it is thick; also used for the glow beyond the limb
            atmosphereHaze: 1.0,
            atmosphereBrightness: 0.4,
            // scene units over which the glow beyond the limb fades with height (the real atmosphere's
            // 8 km would be under a pixel, so this is exaggerated)
            haloScaleHeight: 0.02
        };

        // Whether the viewer wants clouds shown (the settings menu); they appear once loaded
        this.cloudsVisible = true;

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

    getTextureUrls(useLowRes = false) {
        const isMobileOrSafari = window.mobileAndSafariCheck ? window.mobileAndSafariCheck() : false;
        const baseUrl = window.location.origin || '.';

        // Textures - Use a low resolution version on mobile devices, also Safari because it chokes on
        // preloading images as bitmaps. Other than the obvious benefit of improving performance, it
        // can sometimes happen that the creation of a webgl context fails on lower-end mobile devices
        // when decompressing 8k textures.
        if (isMobileOrSafari || useLowRes) {
            return [
                `${baseUrl}/BlueMarble_2048x1024.avif`,
                `${baseUrl}/BlackMarble_2048x1024.avif`,
                `${baseUrl}/EarthSpec_2048x1024.avif`
            ];
        }

        // Use high resolution for desktop browsers with good support
        return [
            `${baseUrl}/BlueMarble_8192x4096.avif`,
            `${baseUrl}/BlackMarble_8192x4096.avif`,
            `${baseUrl}/EarthSpec_2048x1024.avif`
        ];
    }

    // Cloud texture size: 2048x1024 wherever the Earth textures drop to low resolution
    // (mobile, Safari, the landing page), otherwise 8192x4096 if the GPU allows it.
    getCloudResolution(useLowRes = false) {
        const isMobileOrSafari = window.mobileAndSafariCheck ? window.mobileAndSafariCheck() : false;
        if (isMobileOrSafari || useLowRes) {
            return '2k';
        }
        const maxTextureSize = this.scene.renderer?.capabilities.maxTextureSize ?? 4096;
        return maxTextureSize >= 8192 ? '8k' : '4k';
    }

    // URL of the cloud texture made by the gibs-cloud-texture worker (proxied at /cloud-texture).
    // product=albedo returns a greyscale PNG of the clouds' visible reflectance, worked out from
    // NOAA-20 VIIRS cloud optical thickness. GIBS takes about two days to finish a day's data,
    // so ask for the day two days before the scene time (never later than now).
    // The GIBS level (tileMatrix) is the lowest one with at least as many pixels as the texture,
    // so the worker shrinks the tiles rather than enlarging them: level 3 (5120 x 2560) for 2k
    // and 4k, level 4 (10240 x 5120) for 8k. These match what the worker's hourly job keeps ready
    // (PREWARM_TILE_MATRIX in gibs-cloud-texture/wrangler.jsonc).
    getCloudTextureUrl(useLowRes = false) {
        const sceneTime = Math.min(this.initialDate.getTime(), Date.now());
        const date = new Date(sceneTime - 2 * 86400000).toISOString().slice(0, 10);
        const outputRes = this.getCloudResolution(useLowRes);
        const params = new URLSearchParams({
            date,
            tileMatrix: outputRes === '8k' ? '4' : '3',
            outputRes,
            product: 'albedo'
        });
        return `${window.location.origin || '.'}/cloud-texture?${params}`;
    }

    // Load the cloud texture in the background and switch the clouds on once it arrives.
    // The globe renders normally in the meantime, and stays cloudless if loading fails.
    async loadCloudTexture() {
        if (!this.earthMaterial) {
            console.warn('Earth material not initialized, cannot load cloud texture');
            return null;
        }

        const url = this.getCloudTextureUrl(this.useLowRes);
        try {
            // premultiplyAlpha must be passed explicitly: setOptions replaces ImageBitmapLoader's defaults
            const cloudTexture = await this.loadTexture(url, { premultiplyAlpha: 'none' }, 2, 1000);

            // The texture is data, not color: sqrt(reflectance) in a single channel. RedFormat
            // keeps it at one byte per texel on the GPU (32 MB at 8k instead of 128 MB as RGBA).
            cloudTexture.format = THREE.RedFormat;
            cloudTexture.colorSpace = THREE.NoColorSpace;
            // wrap across the antimeridian (shadow lookups step over it)
            cloudTexture.wrapS = THREE.RepeatWrapping;
            cloudTexture.anisotropy = Math.min(8,
                this.scene.renderer?.capabilities.getMaxAnisotropy() || 8);
            cloudTexture.needsUpdate = true;

            const uniforms = this.earthMaterial.uniforms;
            const previous = uniforms.cloudTexture.value;
            uniforms.cloudTexture.value = cloudTexture;
            // unless the viewer hid the clouds while they were loading
            uniforms.showClouds.value = this.cloudsVisible;
            previous?.dispose();
            return cloudTexture;
        } catch (error) {
            console.error('Failed to load cloud texture:', error);
            this.earthMaterial.uniforms.showClouds.value = false;
            return null;
        }
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

    // Main initialization function for the globe
    async initialize(interactiveLayer, useLowRes = false) {
        this.useLowRes = useLowRes;
        const earthImageUrls = this.getTextureUrls(useLowRes);

        try {
            // Load all textures
            const textures = await Promise.all(
                earthImageUrls.map(url => this.loadTexture(url, {}, 3, 100))
            );

            for (let i = 0; i < textures.length - 1; i++) {
                textures[i].colorSpace = THREE.SRGBColorSpace;
                textures[i].anisotropy = Math.min(8,
                    this.scene.renderer?.capabilities.getMaxAnisotropy() || 8);
            }

            const [blueMarble, blackMarble, earthSpec] = textures;
            // the night glow blur reads across the antimeridian
            blackMarble.wrapS = THREE.RepeatWrapping;

            // Civil, Nautical, and Astronomical Twilight account for sun angles up to
            // about 18 degrees past the horizon
            const twilightAngle = 18.0 * Math.PI / 180.0;

            await this.createEarth(
                blueMarble,
                blackMarble,
                earthSpec,
                twilightAngle,
                interactiveLayer
            );
            await this.createAtmosphere(twilightAngle);

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

    async createEarth(blueMarble, blackMarble, earthSpec, twilightAngle, interactiveLayer) {
        const earthGeometry = new THREE.SphereGeometry(this.parameters.radius, 64, 64);

        // Shader material with added cloud texture uniforms
        this.earthMaterial = new THREE.ShaderMaterial({
            uniforms: {
                dayTexture: new THREE.Uniform(blueMarble),
                nightTexture: new THREE.Uniform(blackMarble),
                specularMapTexture: new THREE.Uniform(earthSpec),
                sunDirection: new THREE.Uniform(new THREE.Vector3(0, 0, 1)),
                twilightAngle: new THREE.Uniform(twilightAngle),
                dayColor: new THREE.Uniform(new THREE.Color(this.parameters.dayColor)),
                twilightColor: new THREE.Uniform(new THREE.Color(this.parameters.twilightColor)),
                // Clouds: set by loadCloudTexture() once the texture has arrived
                cloudTexture: new THREE.Uniform(null),
                showClouds: new THREE.Uniform(false),
                cloudBrightness: new THREE.Uniform(this.parameters.cloudBrightness),
                cloudShadowHeight: new THREE.Uniform(this.parameters.cloudShadowHeight * this.parameters.radius / 6371),
                cloudRelief: new THREE.Uniform(this.parameters.cloudRelief),
                cloudTwilightTint: new THREE.Uniform(this.parameters.cloudTwilightTint),
                windSpeed: new THREE.Uniform(this.parameters.windSpeed),
                glintBrightness: new THREE.Uniform(this.parameters.glintBrightness),
                atmosphereHaze: new THREE.Uniform(this.parameters.atmosphereHaze),
                atmosphereBrightness: new THREE.Uniform(this.parameters.atmosphereBrightness),
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

        this.earth = new THREE.Mesh(earthGeometry, this.earthMaterial);
        this.scene.add(this.earth);
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

    async createAtmosphere(twilightAngle) {
        // Atmosphere
        const atmosphereGeometry = new THREE.SphereGeometry(
            this.parameters.radius * 1.015, 64, 64
        );

        this.atmosphereMaterial = new THREE.ShaderMaterial({
            vertexShader: atmosphereVertexShader,
            fragmentShader: atmosphereFragmentShader,
            uniforms: {
                sunDirection: new THREE.Uniform(new THREE.Vector3(0, 0, 1)),
                twilightAngle: new THREE.Uniform(twilightAngle),
                earthRadius: new THREE.Uniform(this.parameters.radius),
                atmosphereRadius: new THREE.Uniform(atmosphereGeometry.parameters.radius),
                atmosphereBrightness: new THREE.Uniform(this.parameters.atmosphereBrightness),
                haloScaleHeight: new THREE.Uniform(this.parameters.haloScaleHeight),
            },
            side: THREE.BackSide,
            transparent: true
        });

        this.atmosphere = new THREE.Mesh(atmosphereGeometry, this.atmosphereMaterial);
        this.scene.add(this.atmosphere);
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

        // Update sun direction for both earth and atmosphere
        const sunDirection = getSunPointingAngle(currentDate);
        this.earthMaterial.uniforms.sunDirection.value.copy(sunDirection);
        this.atmosphereMaterial.uniforms.sunDirection.value.copy(sunDirection);

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

// Function to create and initialize an Earth instance
export async function initEarth(scene, initialDate, interactiveLayer, useLowRes = false) {
    // Yes, I'm a proud globehead :p
    const globe = new Earth(scene, initialDate);
    await globe.initialize(interactiveLayer, useLowRes);
    return globe;
}
