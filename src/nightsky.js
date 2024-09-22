/* nightsky.js - main source for Star Map Demo (previously called Night Sky Demo) */
import * as THREE from 'three';
import GUI from 'lil-gui';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { initSky } from './skyboxcolor.js';

let scene, renderer, camera, controls, clock, skybox;

await init();

async function init() {
    scene = new THREE.Scene();
    
    camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.z = 1;

    const canvas = document.querySelector('#webgl-canvas');
    renderer = new THREE.WebGLRenderer({ antialias: true, canvas });
    renderer.setClearColor(0x000000);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableZoom = false;
    controls.update();

    const ambientLight = new THREE.AmbientLight(0xffffff, 1.0);
    scene.add(ambientLight);

    const gui = new GUI();
    await initSky({ sceneObj: scene, guiObj: gui }).then((sky) => {
        skybox = sky;
        clock = new THREE.Clock();
        requestAnimationFrame(animate);
    });
}

function onWindowResize() {
    const canvas = renderer.domElement;
    const pixelRatio = window.devicePixelRatio;
    const width = Math.floor(canvas.clientWidth * pixelRatio);
    const height = Math.floor(canvas.clientHeight * pixelRatio);
    const needsResize = canvas.width !== width || canvas.height !== height;
    if (needsResize) {
        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
    }
}

function animate() {
    onWindowResize();
    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(animate);
}
