/* earth.js - Earth globe rendering for Satellite Demo */
import * as THREE from 'three';
import gstime from './gstime.js';
import getSunPointingAngle from './sunangle.js';
import earthVertexShader from './shaders/earth/earthVertex.glsl';
import earthFragmentShader from './shaders/earth/earthFragment.glsl';
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
            twilightColor: '#fd5e53'
        };

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

    // Function to get the cloud texture URL with the proper date parameter
    getCloudTextureUrl(initialDate) {
        // Get previous day's date
        const prevDay = new Date(initialDate);
        prevDay.setDate(prevDay.getDate() - 2);

        // Format as ISO string and extract the date part (YYYY-MM-DD)
        const dateStr = prevDay.toISOString().split('T')[0] + 'T00:00:00Z';

        // Use the proxied URL path instead of direct access to localhost:3000
        return `/api/cloud-texture?tileMatrix=3&date=${dateStr}`;
    }

    // Function to load cloud texture from API endpoint
    async loadCloudTexture() {
        if (!this.earthMaterial) {
            console.warn('Earth material not initialized, cannot load cloud texture');
            return null;
        }

        const url = this.getCloudTextureUrl(this.initialDate);
        console.log('Loading cloud texture from:', url);

        try {
            const cloudTexture = await this.loadTexture(url);

            // Set up the texture properties similar to other textures
            cloudTexture.colorSpace = THREE.SRGBColorSpace;
            cloudTexture.anisotropy = Math.min(8,
                this.scene.renderer?.capabilities.getMaxAnisotropy() || 8);

            // For proper transparent cloud textures
            cloudTexture.transparent = true;
            cloudTexture.needsUpdate = true;

            // Add to Earth material uniforms
            this.earthMaterial.uniforms.cloudTexture.value = cloudTexture;
            this.earthMaterial.uniforms.showClouds.value = true;

            console.log('Cloud texture loaded successfully');
            return cloudTexture;
        } catch (error) {
            console.error('Failed to load cloud texture:', error);
            // Ensure showClouds is false if loading failed
            this.earthMaterial.uniforms.showClouds.value = false;
            return null;
        }
    }

    // Function to toggle cloud visibility
    toggleClouds(visible = null) {
        if (!this.earthMaterial || !this.earthMaterial.uniforms.showClouds) {
            console.warn('Earth material or cloud uniform not available');
            return false;
        }

        // If visible is null, toggle the current state
        if (visible === null) {
            this.earthMaterial.uniforms.showClouds.value = !this.earthMaterial.uniforms.showClouds.value;
        } else {
            // Otherwise, set to the specified value
            this.earthMaterial.uniforms.showClouds.value = Boolean(visible);
        }

        console.log(`Clouds are now ${this.earthMaterial.uniforms.showClouds.value ? 'visible' : 'hidden'}`);
        return this.earthMaterial.uniforms.showClouds.value;
    }

    // Main initialization function for the globe
    async initialize(interactiveLayer, useLowRes = false) {
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

            // Load cloud texture asynchronously after Earth is initialized
            // We don't await this call since we want it to happen in the background
            this.loadCloudTexture().catch(err =>
                console.warn('Could not load cloud texture, proceeding without clouds:', err));

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
                // Add cloud texture uniforms with default values
                cloudTexture: new THREE.Uniform(null),
                showClouds: new THREE.Uniform(false)
            },
            vertexShader: earthVertexShader,
            fragmentShader: earthFragmentShader
        });

        this.earth = new THREE.Mesh(earthGeometry, this.earthMaterial);
        this.scene.add(this.earth);
        this.earth.name = 'earth';

        // Set initial rotation based on sidereal time
        this.earth.rotation.y = this.gmst;

        // Enable raycaster collisions with this object to prevent selecting satellites on the
        // backside of the earth
        if (interactiveLayer !== undefined) {
            this.earth.layers.enable(interactiveLayer);
        }

        return this.earth;
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
                dayColor: new THREE.Uniform(new THREE.Color(this.parameters.dayColor)),
                twilightColor: new THREE.Uniform(new THREE.Color(this.parameters.twilightColor)),
                twilightAngle: new THREE.Uniform(twilightAngle),
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
    }
}

// Function to create and initialize an Earth instance
export async function initEarth(scene, initialDate, interactiveLayer, useLowRes = false) {
    // Yes, I'm a proud globehead :p
    const globe = new Earth(scene, initialDate);
    await globe.initialize(interactiveLayer, useLowRes);
    return globe;
}
