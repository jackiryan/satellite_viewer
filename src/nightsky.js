/* nightsky.js - main source for Star Map Demo (previously called Night Sky Demo) */
import * as THREE from 'three';
import GUI from 'lil-gui';
import { Timer } from 'three/addons/misc/Timer.js';
import { initSky } from './skyboxcolor.js';
import { initConstellations } from './constellations.js';
import { EclipticOverlay } from './ecliptic.js';
import { raDecToWorld } from './skyCoords.js';
import { SkyControls } from './skyControls.js';

let scene, renderer, camera, controls, timer, skybox, ecliptic, constellations;

await init();

async function init() {
    scene = new THREE.Scene();

    camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);
    // The camera sits at the center of the sky and only turns. It opens looking at Orion
    // (RA 6h), tilted up enough to show the ecliptic above it, with celestial north up.
    camera.lookAt(raDecToWorld(90, 8));

    const canvas = document.querySelector('#webgl-canvas');
    renderer = new THREE.WebGLRenderer({ antialias: true, canvas });
    renderer.setClearColor(0x000000);

    controls = new SkyControls(camera, renderer.domElement);

    const ambientLight = new THREE.AmbientLight(0xffffff, 1.0);
    scene.add(ambientLight);

    // the constellation data loads while the star textures do
    const constellationsLoading = initConstellations({ scene, camera, renderer }).catch((error) => {
        console.error('Failed to load constellations:', error);
        return null;
    });
    ecliptic = new EclipticOverlay({ camera, renderer });
    scene.add(ecliptic.group);

    const gui = new GUI();
    await initSky({ sceneObj: scene, guiObj: gui }).then((sky) => {
        skybox = sky;
        timer = new Timer();
        requestAnimationFrame(animate);
    });
    gui.add(controls, 'resetView').name('Reset View');

    constellations = await constellationsLoading;
    initOverlayTweaks(gui);
}

function initOverlayTweaks(gui) {
    const settings = { constellations: true, ecliptic: true };
    const folder = gui.addFolder('Overlays');
    if (constellations) {
        folder.add(settings, 'constellations').onChange((on) => constellations.setEnabled(on));
    }
    folder.add(settings, 'ecliptic').onChange((on) => ecliptic.setVisible(on));
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

function animate(timestamp) {
    timer.update(timestamp);
    const deltaSeconds = timer.getDelta();
    onWindowResize();
    controls.update(deltaSeconds);
    ecliptic.update();
    constellations?.update(deltaSeconds);
    renderer.render(scene, camera);
    requestAnimationFrame(animate);
}
