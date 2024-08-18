
import * as THREE from 'three';
import GUI from 'lil-gui';
import skyVertexShader from './shaders/skybox/skyVertex.glsl';
import skyFragmentShader from './shaders/skybox/skyFragment.glsl';

var skybox;

export class Sky extends THREE.Mesh {
    constructor(textures) {
        textures[0].type = THREE.HalfFloatType;
        textures[0].minFilter = THREE.LinearFilter;
        textures[0].magFilter = THREE.LinearFilter;
        textures[0].needsUpdate = true;

        const uniforms = {
            'uStarData': { type: 't', value: textures[0] },
            'uTempData': { type: 't', value: textures[1] },
            'uPixelSize': { type: 'f', value: 1024.0 },
            'uSigma': { type: 'f', value: 150.0 },
            'uScaleFactor': { type: 'f', value: 0.0 },
            'uBrightnessScale': { type: 'f', value: 20.0 },
            'uSkyboxCubemap': { type: 't', value: textures[2] },
            'uRotY': { type: 'f', value: 0.0 },
            'uRotX': { type: 'f', value: 0.0 },
            'uRotZ': { type: 'f', value: 0.0 },
            'uMwBright': { type: 'f', value: 1.0 },
        };
        const material = new THREE.ShaderMaterial({
            name: 'StarShader',
            uniforms: uniforms,
            vertexShader: skyVertexShader,
            fragmentShader: skyFragmentShader,
            side: THREE.BackSide,
            depthWrite: false
        });
        super( new THREE.SphereGeometry(1, 32, 32), material );
        this.isSky = true;
        
    }

}

function loadTexture(url) {
    return new Promise((resolve, reject) => {
        const loader = new THREE.TextureLoader();
        loader.load(
            url,
            texture => {
                // Resolve the promise with the loaded texture
                resolve(texture);
            },
            undefined,
            error => {
                // Reject the promise if there's an error
                reject(new Error(`Failed to load texture from ${url}: ${error.message}`));
            }
        );
    });
}

function loadCubemap() {
    const prefix = 'sky_pos';
    const extension = 'avif';
    const loader = new THREE.CubeTextureLoader();
    const texture = loader.load([
        `./skybox/${prefix}_px.${extension}`, // positive x
        `./skybox/${prefix}_nx.${extension}`, // negative x
        `./skybox/${prefix}_py.${extension}`, // positive y
        `./skybox/${prefix}_ny.${extension}`, // negative y
        `./skybox/${prefix}_pz.${extension}`, // positive z
        `./skybox/${prefix}_nz.${extension}`  // negative z
    ]);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}

export async function initSky(scene, gui = undefined) {
    const texPromises = [
        loadTexture('./skybox/2_StarData16bit.png'),
        loadTexture('./skybox/2_Tmap8bit.png'),
        Promise.resolve(loadCubemap())
    ]
    Promise.all(texPromises).then((textures) => {
        skybox = new Sky(textures);
        skybox.scale.setScalar(450000);
        skybox.name = 'sky';
        scene.add(skybox);

        if (gui != undefined) {
            initTweaks(gui);
        }

        return skybox;

    })
    .catch(error => {
        console.error('An error occurred while loading one of the textures:', error);
    });
}

function initTweaks(gui) {
    const effectController = {
        pixelSize: 1024.0,
        sigma: 150.0,
        scaleFactor: 0.0,
        brightnessScale: 20.0,
        mwBright: 1.0,
        rotY: 90.0,
        rotX: 180.0,
        rotZ: 56.0
    };

    gui.add( effectController, 'sigma', 0.0, 500.0, 0.1 ).onChange( guiChanged );
    gui.add( effectController, 'scaleFactor', 0.0, 10.0, 0.01 ).onChange( guiChanged );
    gui.add( effectController, 'brightnessScale', 0.0, 1000.0, 0.1 ).onChange( guiChanged );
    gui.add( effectController, 'mwBright', 0.0, 1.0, 0.01 ).onChange( guiChanged );
    gui.add( effectController, 'rotX', -90, 90, 1 ).onChange( guiChanged );
    gui.add( effectController, 'rotY', -180, 180, 1 ).onChange( guiChanged );
    gui.add( effectController, 'rotZ', -180, 180, 1 ).onChange( guiChanged );

    function guiChanged() {
        
        const uniforms = skybox.material.uniforms;
        uniforms[ 'uSigma' ].value = effectController.sigma;
        uniforms[ 'uScaleFactor' ].value = effectController.scaleFactor;
        uniforms[ 'uBrightnessScale' ].value = effectController.brightnessScale;
        uniforms[ 'uMwBright' ].value = effectController.mwBright;
        uniforms[ 'uRotY' ].value = effectController.rotY;
        uniforms[ 'uRotX' ].value = effectController.rotX;
        uniforms[ 'uRotZ' ].value = effectController.rotZ;
    
    }
}