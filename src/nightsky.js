import * as THREE from 'three';
import GUI from 'lil-gui';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { initSky } from './skyboxcolor.js';
//import getSunPointingAngle from './sunangle.js';

let scene, renderer, camera, controls, clock, skybox;
// let elapsedTime = 0;

/*
const renderParameters = {
    speedFactor: 1
} */

const now = new Date();

async function init() {
    scene = new THREE.Scene();
    
    camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.z = 1;

    renderer = new THREE.WebGLRenderer();
    renderer.setSize(window.innerWidth, window.innerHeight);
    
    document.body.appendChild(renderer.domElement);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableZoom = false;
    controls.update();

    // Add ambient light
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambientLight);

    const gui = new GUI();
    /*
    gui
        .add(renderParameters, 'speedFactor')
        .min(1)
        .max(7200);
    */
    await initSky({ sceneObj: scene, guiObj: gui }).then((sky) => {
        skybox = sky;
        clock = new THREE.Clock();
        renderer.setAnimationLoop(animate);
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

function animate() {
    //const delta = renderParameters.speedFactor * clock.getDelta();
    //elapsedTime += delta;
    //const deltaNow = new Date(now.getTime() + elapsedTime * 1000);

    //skybox.material.uniforms.uSunDirection.value.copy(getSunPointingAngle(deltaNow));

    controls.update();
    renderer.render(scene, camera);
}

await init();