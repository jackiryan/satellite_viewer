
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import skyVertexShader from './shaders/skybox/skyVertex.glsl';
import skyFragmentShader from './shaders/skybox/skyFragment.glsl';

export class Sky extends THREE.Mesh {
    constructor() {
        const shader = Sky.SkyShader;

        const material = new THREE.ShaderMaterial({
            name: shader.name,
            uniforms: THREE.UniformsUtils.clone( shader.uniforms ),
            vertexShader: skyVertexShader,
            fragmentShader: skyFragmentShader,
            side: THREE.BackSide,
            depthWrite: false
        });
        super( new THREE.BoxGeometry(1, 1, 1), material );

        this.isSky = true;
    }

}

function loadCubemap() {
    const prefix = 'sky_pos';
    const loader = new THREE.CubeTextureLoader();
    const texture = loader.load([
        `./skybox/${prefix}_px.png`, // positive x
        `./skybox/${prefix}_nx.png`, // negative x
        `./skybox/${prefix}_py.png`, // positive y
        `./skybox/${prefix}_ny.png`, // negative y
        `./skybox/${prefix}_pz.png`, // positive z
        `./skybox/${prefix}_nz.png`  // negative z
    ]);
    return texture;
}

Sky.SkyShader = {
    name: 'SkyShader',
    uniforms: {
        'skyboxCubemap': { type: 't', value: loadCubemap() },
        'rotX': { type: 'f', value: 0.0 },
        'rotY': { type: 'f', value: 0.0 },
        'rotY': { type: 'f', value: 0.0 },
        'speed': { type: 'f', value: 0.0 },
    },
    vertexShader: skyVertexShader,
    fragmentShader: skyFragmentShader
};

var scene, renderer, camera, controls, skybox;

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

    skybox = new Sky();
    skybox.scale.setScalar(450000);
    scene.add(skybox);
    

    // Handle window resize
    window.addEventListener('resize', function () {
        const width = window.innerWidth;
        const height = window.innerHeight;
        renderer.setSize(width, height);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
    });

}

function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
}

await init();
animate();