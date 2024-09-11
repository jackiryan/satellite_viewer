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
}

const now = new Date();
*/

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
    /*
    gui
        .add(renderParameters, 'speedFactor')
        .min(1)
        .max(7200);
    */
    await initSky({ sceneObj: scene, guiObj: gui }).then((sky) => {
        skybox = sky;
        clock = new THREE.Clock();
        requestAnimationFrame(animate);
    });
}

function animate() {
    /* 
    const delta = renderParameters.speedFactor * clock.getDelta();
    elapsedTime += delta;
    const deltaNow = new Date(now.getTime() + elapsedTime * 1000);

    skybox.material.uniforms.uSunDirection.value.copy(getSunPointingAngle(deltaNow));
    */

    onWindowResize();
    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(animate);
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