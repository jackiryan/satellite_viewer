/* landing.js - main JavaScript source for the index.html of my personal website */
import * as THREE from 'three';
import { initSky } from './skybox.js';
import { initEarth } from './earth.js';

let camera, scene, renderer;
let earth, skybox;

// Determine the initial time for the simulation
const now = new Date();

// Earth parameters needed for bounding box calculation
const earthRadius = 5;

/* Animation
 * Uses a renderFrameRate and speedFactor to control the "choppiness" and speed of
 * the animation, respectively. */
// Factor to run the rotation faster than real time, 3600 ~= 1 rotation/minute
const renderParameters = {
    speedFactor: 60, // multiple of realtime
    animFrameRate: 60.0 // frames per second
};

// mutable that is used for adjusting simulation speed
let elapsedTime = 0;
const renderClock = new THREE.Clock();
const sceneBoundingBox = new THREE.Box3(
    new THREE.Vector3(-0.5 * earthRadius, -10, -5),
    new THREE.Vector3(100 + 0.5 * earthRadius, 10, 5)
);

await init().then(async () => {
    await initSky({ sceneObj: scene }).then((sky) => {
        skybox = sky;
    });
    // clouds are disabled for now until further details get worked out in the shader
    // await earth.loadCloudTexture();
    requestAnimationFrame(animate);
});

async function init() {
    /* Boilerplate */
    camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.x = -25;
    fitCameraToBbox(camera, sceneBoundingBox, 1.8 / camera.aspect);
    camera.rotation.y = -Math.PI;

    const canvas = document.querySelector('#webgl-canvas');
    renderer = new THREE.WebGLRenderer({ antialias: true, canvas });
    renderer.setClearColor(0x000000);
    renderer.toneMapping = THREE.LinearToneMapping;
    renderer.toneMappingExposure = 1.3;

    scene = new THREE.Scene();

    // Add ambient light
    const ambientLight = new THREE.AmbientLight(0xcccccc, 1);
    scene.add(ambientLight);

    // Initialize the Earth
    // Passing the renderer to the earth so it can use its capabilities
    scene.renderer = renderer;
    // give the init function the scene, time, interactiveLayer (unused in this
    // context), and tell it to use low res textures
    earth = await initEarth(scene, now, 1, true);
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
        // setting the offset argument to 1.8 / camera.aspect causes relative positioning
        // to stay constant
        fitCameraToBbox(camera, sceneBoundingBox, 1.8 / camera.aspect);
    }
}

function fitCameraToBbox(camera, bbox, offset) {
    /* 
    * This is a modified version of the code from this forum thread:
    * https://discourse.threejs.org/t/camera-zoom-to-fit-object/936
    * Here we are using 1 / camera.aspect as the offset factor to cause
    * the relative positioning of objects in the scene to appear the
    * same regardless of window size.
    */
    offset = offset || 1.25;

    const dummy = new THREE.Vector3();
    const size = bbox.getSize(dummy);

    // get the max side of the bounding box (fits to width OR height as needed )
    const maxDim = Math.max(size.x, size.y, size.z);
    let cameraZ = Math.abs(maxDim / 4 * Math.tan(camera.fov * 2));
    cameraZ *= offset;

    // importantly, we only adjust the camera Z position here, we don't want to do camera.lookAt(earth)
    // because the camera is *supposed* to keep the Earth on the left side of the page.
    camera.position.z = -cameraZ;

    const minZ = bbox.min.z;
    const cameraToFarEdge = (minZ < 0) ? -minZ + cameraZ : cameraZ - minZ;

    // Setting camera.far is probably unimportant in this context, but it doesn't hurt
    camera.far = cameraToFarEdge;
    camera.updateProjectionMatrix();
}

function animate() {
    // the speedFactor should be enough that the earth will move while the user is on the page,
    // but not so much that it will be obvious at a glance. It's a tricky little detail for
    // people who are paying attention :)
    const delta = renderParameters.speedFactor * renderClock.getDelta();
    elapsedTime += delta;
    const deltaNow = new Date(now.getTime() + elapsedTime * 1000);

    onWindowResize();

    // Update the earth with the current simulation time
    if (earth) {
        earth.update(deltaNow);

        // Get the sun direction from the earth to update skybox
        if (skybox !== undefined && skybox.isStarry()) {
            const sunDirection = earth.earthMaterial?.uniforms.sunDirection.value;
            if (sunDirection) {
                skybox.material.uniforms.uSunDirection.value.copy(sunDirection);
            }
        }
    }

    renderer.render(scene, camera);
    requestAnimationFrame(animate);
}