/* skyboxcolor.js
 * Implements a class that uses a shader to map 8th Magnitude or brighter stars onto a skybox,
 * and displays a sun using SDFs. The stars in this shader are colored based on their B magnitudes
 * minus their V magnitudes, which approximates a blackbody color temperature when no such data is
 * available. This is currently incorrect in some cases, and I have it on my list to fix it, but I
 * would need to clean up the pre-processing script used to generate the datapack texture.
 * 
 * Almost the exact same code is implemented in skybox.js, except that there is a sun defined using SDFs
 * and the stars are not colored. I could have used inheritance to avoid "repeating myself", but I felt
 * it would reduce the readability of the code at no tangible benefit to the functionality of these demos.
 */
import * as THREE from 'three';
import skyVertexShader from './shaders/skybox/skyVertex.glsl';
import skyFragmentShader from './shaders/skybox/skyFragment.glsl';

export class Sky extends THREE.Mesh {
    constructor() {
        const bgColor = getComputedStyle(document.documentElement).getPropertyValue('--default-bg-color').trim();
        // prior to initialization, use a blank skybox with our default color
        const blankMaterial = new THREE.MeshBasicMaterial({
            color: bgColor,
            side: THREE.BackSide,
            depthWrite: false
        });

        super(new THREE.SphereGeometry(1, 32, 32), blankMaterial);

        // used to avoid highlighting with mouseMove event
        this.name = 'sky';
        this.blankMaterial = blankMaterial;
        this.starsEnabled = false;
        this.isSky = true;
        // Setting the scale to be huge so that zooming in and out will not affect
        // the position of the stars.
        this.scale.setScalar(450000);
        this.loader = new THREE.ImageBitmapLoader();
        this.loader.setCrossOrigin('anonymous'); // required due to the COEP
        // although the shader flips Y again, the juice was not worth the squeeze on trying
        // to optimize out the webgl call to flipY
        this.loader.setOptions({ imageOrientation: 'flipY' });
        this.attempt = 0;
        this.maxAttempts = 3;
        this.delayMs = 100;
    }

    async initMaterial(textureUrls) {
        if (textureUrls.length !== 3) {
            throw new Error('initMaterial requires exactly three texture URLs');
        }

        try {
            const textures = await Promise.all(textureUrls.map(url => this.loadTexture(url)));
            // this will become less tedious when moving to a single starmap texture
            for (let i = 0; i < 3; i++) {
                if (i === 0) {
                    // 16-bit datapack texture
                    textures[i].type = THREE.HalfFloatType;
                }
                if (i === 0 || i === 1) {
                    // 8- or 16-bit datapacks should not mipmap
                    textures[i].minFilter = THREE.LinearFilter;
                    textures[i].magFilter = THREE.LinearFilter;
                } else {
                    // Milky way texture -- use sRGBColorSpace
                    textures[i].colorSpace = THREE.SRGBColorSpace;
                    // since we don't have the renderer capabilities in scope, this should work
                    // on all devices we care about. This texture is barely visible anyways
                    textures[i].anisotropy = 2;
                }
                textures[i].needsUpdate = true;
            }

            // uPixelSize should not be adjusted at runtime -- its value is based on the
            // resolution of the datapack texture uStarData
            const uniforms = {
                'uStarData': { type: 't', value: textures[0] },
                'uTempData': { type: 't', value: textures[1] },
                'uPixelSize': { type: 'f', value: 1024.0 },
                'uSigma': { type: 'f', value: 100.0 },
                'uScaleFactor': { type: 'f', value: 0.0 },
                'uBrightnessScale': { type: 'f', value: 30.0 },
                'uSkybox': { type: 't', value: textures[2] },
                'uMwBright': { type: 'f', value: 0.10 },
            };
            this.starMaterial = new THREE.ShaderMaterial({
                name: 'StarShader',
                uniforms: uniforms,
                vertexShader: skyVertexShader,
                fragmentShader: skyFragmentShader,
                side: THREE.BackSide,
                depthWrite: false
            });

            this.material = this.starMaterial;
            // This is effectively "private" and should be accessed with this.isStarry()
            this.starsEnabled = true;
        } catch (error) {
            console.error('Failed to initialize starmap material:', error);
        }
    }

    loadTexture(url) {
        return new Promise((resolve, reject) => {
            this.loader.load(
                url,
                image => {
                    resolve(new THREE.CanvasTexture(image));
                },
                undefined,
                error => {
                    console.error('Loading failed:', {
                        url: url,
                        error: error,
                        attempt: this.attempt + 1
                    });
                    this.attempt++;
                    if (this.attempt < this.maxAttempts) {
                        console.log(`Retrying in ${this.delayMs}ms (attempt ${this.attempt + 1}/${this.maxAttempts})`);
                        setTimeout(() => {
                            this.loadTexture(url).then(resolve).catch(reject);
                        }, this.delayMs);
                    } else {
                        reject(error);
                    }
                }
            );
        });
    }

    loadCubemap(prefix, extension) {
        return new Promise((resolve, reject) => {
            const loader = new THREE.CubeTextureLoader();
            loader.load(
                [
                    `${prefix}_px.${extension}`, // positive x
                    `${prefix}_nx.${extension}`, // negative x
                    `${prefix}_py.${extension}`, // positive y
                    `${prefix}_ny.${extension}`, // negative y
                    `${prefix}_pz.${extension}`, // positive z
                    `${prefix}_nz.${extension}`  // negative z
                ],
                texture => {
                    resolve(texture);
                },
                undefined,
                error => {
                    reject(
                        new Error(`Failed to load cubemap from ${prefix}_*.${extension}: ${error.message}`)
                    );
                }
            );
        });
    }

    toggleStars() {
        this.starsEnabled = !this.starsEnabled;
        if (this.starsEnabled) {
            this.material = this.starMaterial;
        } else {
            this.material = this.blankMaterial;
        }
    }

    isStarry() {
        return this.starsEnabled;
    }
}

export async function initSky({ sceneObj, stars = true, guiObj = undefined } = {}) {
    // This function is needed because asynchronous texture loading should generally occur
    // outside of the constructor for an object. In previous iterations, it was also sometimes
    // desired to compare between using a cubemap and equirectangular map for testing.
    const baseUrl = window.location.origin;
    const textureUrls = [
        `${baseUrl}/skybox/StarData_1024x1024_16bit.png`,
        `${baseUrl}/skybox/2_Tmap8bit.png`,
        `${baseUrl}/skybox/milkyway_2020_1024x512.avif`
    ];
    const skybox = new Sky();
    sceneObj.add(skybox);
    if (stars) {
        await skybox.initMaterial(textureUrls);
        if (guiObj !== undefined) {
            initTweaks(guiObj, skybox);
        }
    }
    return skybox;
}

function initTweaks(gui, skybox) {
    const uniforms = skybox.material.uniforms;
    const effectController = {
        sigma: uniforms['uSigma'].value,
        scaleFactor: uniforms['uScaleFactor'].value,
        brightnessScale: uniforms['uBrightnessScale'].value,
        mwBright: uniforms['uMwBright'].value
    };

    gui.add(effectController, 'sigma', 0.0, 500.0, 0.1).onChange(guiChanged);
    gui.add(effectController, 'scaleFactor', 0.0, 10.0, 0.01).onChange(guiChanged);
    gui.add(effectController, 'brightnessScale', 0.0, 100.0, 0.1).onChange(guiChanged);
    gui.add(effectController, 'mwBright', 0.0, 1.0, 0.01).onChange(guiChanged);

    function guiChanged() {
        const uniforms = skybox.material.uniforms;
        uniforms['uSigma'].value = effectController.sigma;
        uniforms['uScaleFactor'].value = effectController.scaleFactor;
        uniforms['uBrightnessScale'].value = effectController.brightnessScale;
        uniforms['uMwBright'].value = effectController.mwBright;
    }

    // run the initialization function once to set uniforms to their starting values
    // in the effectController
    guiChanged();
}
