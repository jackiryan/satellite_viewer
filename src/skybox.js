
import * as THREE from 'three';
import GUI from 'lil-gui';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import skyVertexShader from './shaders/skybox/skyVertex.glsl';
import skyFragmentShader from './shaders/skybox/skyFragment.glsl';

var scene, renderer, camera, controls, skybox, effectController;

export class Sky extends THREE.Mesh {
    constructor(textures) {
        for (let i = 0; i <= 2; i++) {
            textures[i].format = THREE.RedFormat;
            textures[i].type = THREE.HalfFloatType;
            textures[i].minFilter = THREE.LinearFilter;
            textures[i].magFilter = THREE.LinearFilter;
            textures[i].needsUpdate = true;
        }

        const uniforms = {
            'uYOffData': { type: 't', value: textures[0] },
            'uXOffData': { type: 't', value: textures[1] },
            'uMagData': { type: 't', value: textures[2] },
            'uTempData': { type: 't', value: textures[3] },
            'uPixelSize': { type: 'f', value: 1024.0 },
            'uSigma': { type: 'f', value: 75.0 },
            'uScaleFactor': { type: 'f', value: 0.0 },
            'uBrightnessScale': { type: 'f', value: 8.0 },
            'uSkyboxCubemap': { type: 't', value: textures[4] },
            'uRotY': { type: 'f', value: 0.0 },
            'uRotX': { type: 'f', value: 0.0 },
            'uRotZ': { type: 'f', value: 0.0 },
            'uMwBright': { type: 'f', value: 0.0 },
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
    const extension = 'png';
    const loader = new THREE.CubeTextureLoader();
    const texture = loader.load([
        `./skybox/${prefix}_px.${extension}`, // positive x
        `./skybox/${prefix}_nx.${extension}`, // negative x
        `./skybox/${prefix}_py.${extension}`, // positive y
        `./skybox/${prefix}_ny.${extension}`, // negative y
        `./skybox/${prefix}_pz.${extension}`, // positive z
        `./skybox/${prefix}_nz.${extension}`  // negative z
    ]);
    return texture;
}

async function init() {
    scene = new THREE.Scene();
    
    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.z = 3;

    renderer = new THREE.WebGLRenderer();
    renderer.setSize(window.innerWidth, window.innerHeight);
    document.body.appendChild(renderer.domElement);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.update();

    // Add ambient light
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambientLight);

    effectController = {
        pixelSize: 1024.0,
        sigma: 75.0,
        scaleFactor: 0.0,
        brightnessScale: 8.0,
        mwBright: 0.05,
        rotY: 0.0,
        rotX: 36.0,
        rotZ: 94.6
    };
    const gui = new GUI();

    const texPromises = [
        loadTexture('./skybox/2_yoff16BIT.png'),
        loadTexture('./skybox/2_xoff16BIT.png'),
        loadTexture('./skybox/2_Vmap16BIT.png'),
        loadTexture('./skybox/2_Tmap8bit.png'),
        Promise.resolve(loadCubemap())
    ]
    Promise.all(texPromises).then((textures) => {
        skybox = new Sky(textures);
        skybox.scale.setScalar(450000);
        scene.add(skybox);

        gui.add( effectController, 'sigma', 0.0, 500.0, 0.1 ).onChange( guiChanged );
        gui.add( effectController, 'scaleFactor', 0.0, 10.0, 0.01 ).onChange( guiChanged );
        gui.add( effectController, 'brightnessScale', 0.0, 1000.0, 0.1 ).onChange( guiChanged );
        gui.add( effectController, 'mwBright', 0.0, 1.0, 0.01 ).onChange( guiChanged );
        gui.add( effectController, 'rotX', -180, 180, 1 ).onChange( guiChanged );
        gui.add( effectController, 'rotY', -90, 90, 1 ).onChange( guiChanged );
        gui.add( effectController, 'rotZ', -180, 180, 1 ).onChange( guiChanged );
        guiChanged();
    })
    .catch(error => {
        console.error('An error occurred while loading one of the textures:', error);
    });

    // Handle window resize
    window.addEventListener('resize', function () {
        const width = window.innerWidth;
        const height = window.innerHeight;
        renderer.setSize(width, height);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
    });

}

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

function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
}

await init();
animate();