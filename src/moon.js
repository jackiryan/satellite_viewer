/* moon.js - Moon rendering for Satellite Demo
 *
 * The Moon is drawn at true size and distance, placed and oriented for the scene time by
 * moonephemeris.js, and lit by the Sun, including the Earth's shadow during lunar eclipses.
 * It is not added to the interactive layer, so the satellite hover/click raycast ignores it.
 */
import * as THREE from 'three';
import { getMoonEphemeris } from './moonephemeris.js';
import moonVertexShader from './shaders/moon/moonVertex.glsl';
import moonFragmentShader from './shaders/moon/moonFragment.glsl';

// Same km -> scene unit conversion as satelliteWorker.js (the Earth's radius of 5 = 6371 km)
const KM_TO_SCENE = 5 / 6371;
const EARTH_RADIUS_KM = 6371;
const MOON_RADIUS_KM = 1737.4; // IAU mean radius, also the reference sphere of the SVS CGI Moon Kit
const SUN_RADIUS_KM = 695700;  // IAU nominal solar radius

// moonephemeris.js returns TEME vectors (z = north). The scene uses the same axes as
// satelliteWorker.js and sunangle.js: scene (x, y, z) = TEME (x, z, -y).
function temeToScene(v, target) {
    return target.set(v[0], v[2], -v[1]);
}

// Moon class to encapsulate all moon rendering functionality
export class Moon {
    constructor(scene, initialDate) {
        this.scene = scene;
        this.initialDate = initialDate || new Date();
        this.moon = null;
        this.moonMaterial = null;

        // Parameters for globe rendering
        this.parameters = {
            radius: MOON_RADIUS_KM * KM_TO_SCENE,
            textureUrl: `${window.location.origin || '.'}/lroc_color_poles_thm.avif`,
            brightness: 1.0,
            // light at the edge of the umbra in a typical (Danjon L = 2-3) total lunar
            // eclipse; the shader darkens it toward the center of the shadow
            umbraColor: '#4a1204'
        };

        // Scratch objects reused by update()
        this.axisX = new THREE.Vector3();
        this.axisY = new THREE.Vector3();
        this.axisZ = new THREE.Vector3();
        this.basis = new THREE.Matrix4();

        // Draw the Moon right away with a flat gray placeholder; initialize() swaps in the texture
        this.createMoon();
        this.update(this.initialDate);
    }

    createMoon() {
        const placeholder = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);
        placeholder.colorSpace = THREE.SRGBColorSpace;
        placeholder.needsUpdate = true;

        this.moonMaterial = new THREE.ShaderMaterial({
            uniforms: {
                moonTexture: new THREE.Uniform(placeholder),
                sunPosition: new THREE.Uniform(new THREE.Vector3(1, 0, 0)),
                sunRadius: new THREE.Uniform(SUN_RADIUS_KM * KM_TO_SCENE),
                earthRadius: new THREE.Uniform(EARTH_RADIUS_KM * KM_TO_SCENE),
                brightness: new THREE.Uniform(this.parameters.brightness),
                umbraColor: new THREE.Uniform(new THREE.Color(this.parameters.umbraColor))
            },
            vertexShader: moonVertexShader,
            fragmentShader: moonFragmentShader
        });

        // SphereGeometry maps the middle of the texture (0 deg longitude in the SVS map) to
        // +X, the top edge (north) to +Y, and three quarters across (90 deg E) to -Z.
        // update() relies on this when it orients the mesh.
        const moonGeometry = new THREE.SphereGeometry(this.parameters.radius, 64, 64);
        this.moon = new THREE.Mesh(moonGeometry, this.moonMaterial);
        this.moon.name = 'moon';
        this.scene.add(this.moon);
        return this.moon;
    }

    // Same strategy as Earth.loadTexture: ImageBitmapLoader where it is reliable, and
    // TextureLoader on Safari and mobile devices (mobileAndSafariCheck is defined in
    // earth.js), retrying a few times
    async loadTexture(url, retryCount = 3, retryDelay = 100) {
        const useImageBitmap = !window.mobileAndSafariCheck?.() && 'createImageBitmap' in window;

        for (let attempt = 0; ; attempt++) {
            try {
                if (useImageBitmap) {
                    const imageLoader = new THREE.ImageBitmapLoader();
                    imageLoader.setCrossOrigin('anonymous');
                    imageLoader.setOptions({ imageOrientation: 'flipY' });
                    return new THREE.CanvasTexture(await imageLoader.loadAsync(url));
                }
                const textureLoader = new THREE.TextureLoader();
                textureLoader.setCrossOrigin('anonymous');
                return await textureLoader.loadAsync(url);
            } catch (error) {
                if (attempt >= retryCount) {
                    throw new Error(`Failed to load texture from ${url}: ${error.message ?? error}`);
                }
                console.warn(`Attempt failed for ${url}, retrying in ${retryDelay}ms. Attempts remaining: ${retryCount - attempt}`);
                await new Promise(resolve => setTimeout(resolve, retryDelay));
            }
        }
    }

    // Load the surface texture. If it fails, the Moon stays visible with the gray placeholder.
    async initialize() {
        try {
            const texture = await this.loadTexture(this.parameters.textureUrl);
            texture.colorSpace = THREE.SRGBColorSpace;
            texture.needsUpdate = true;

            const placeholder = this.moonMaterial.uniforms.moonTexture.value;
            this.moonMaterial.uniforms.moonTexture.value = texture;
            placeholder.dispose();
        } catch (error) {
            console.error('Failed to load Moon texture:', error);
        }
        return this;
    }

    // Update method called during animation
    update(currentDate) {
        if (!this.moon) return;

        const { moonPosition, sunPosition, moonToTeme: m } = getMoonEphemeris(currentDate);

        temeToScene(moonPosition, this.moon.position).multiplyScalar(KM_TO_SCENE);
        temeToScene(sunPosition, this.moonMaterial.uniforms.sunPosition.value).multiplyScalar(KM_TO_SCENE);

        // The columns of moonToTeme are the Moon's body axes in TEME: x toward 0 deg
        // longitude, y toward 90 deg E, z toward the north pole. Given the SphereGeometry
        // mapping above, the mesh's local +X, +Y and +Z must line up with body x, z and -y.
        temeToScene([m[0], m[3], m[6]], this.axisX);
        temeToScene([m[2], m[5], m[8]], this.axisY);
        temeToScene([m[1], m[4], m[7]], this.axisZ).negate();
        this.basis.makeBasis(this.axisX, this.axisY, this.axisZ);
        this.moon.quaternion.setFromRotationMatrix(this.basis);
    }

    // Clean up resources
    dispose() {
        if (this.moon) {
            this.scene.remove(this.moon);
            this.moon.geometry.dispose();
            this.moonMaterial.uniforms.moonTexture.value?.dispose();
            this.moonMaterial.dispose();
            this.moon = null;
            this.moonMaterial = null;
        }
    }
}

// Function to create and initialize a Moon instance
export async function initMoon(scene, initialDate) {
    const moon = new Moon(scene, initialDate);
    await moon.initialize();
    return moon;
}