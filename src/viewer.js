/* viewer.js - main source for Satellite Demo */
import * as THREE from 'three';
import gstime from './gstime.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { populateButtonGroup, setButtonState } from './buttonGroup.js';
import { loadGltfGeometry } from './gltfGeometry.js';
import { SatelliteGroupMap } from './satelliteGroupMap.js';
import { initSky } from './skybox.js';
import { Earth, renderPixelRatio } from './earth.js';
import { initMoon } from './moon.js';
import Stats from 'three/addons/libs/stats.module.js';
import { Timer } from 'three/addons/misc/Timer.js';
import { HoverIntentHandler } from './hoverIntentHandler.js';
import { markFrame } from './perfMarks.js';

let camera, controls, scene, renderer, stats;
let earth, moon, skybox, groupMap;

// Determine the initial rotation of the Earth based on the current sidereal time
const now = new Date(); // Get current time
// Vernal Equinox 2024, the terminator will be along prime meridian
// Uncomment this line if using the debug plane to check solar vs sidereal time drift
// const now = new Date(Date.UTC(2024,2,24,3,6,0,0));

// mutable that is used for adjusting simulation speed
let elapsedTime = 0;
const renderTimer = new Timer();

const mainElement = document.querySelector('main');
let previousClockValue = '';
const clockElement = document.getElementById('clock-time');

/* Animation
 * Uses a renderFrameRate and speedFactor to control the "choppiness" and speed of the animation, respectively. */
// Factor to run the rotation faster than real time, 3600 ~= 1 rotation/minute
const renderParameters = {
    speedFactor: 1, // multiple of realtime
    animFrameRate: 60.0 // frames per second, deprecated
};

// Used for jumping days in the simulation
const secondsPerDay = 86400;

const interactiveLayer = 1;

init();
// Draw from the start: the placeholder globe and blank sky show at once, and each part of the
// scene appears as soon as it has loaded
requestAnimationFrame(animate);


function init() {
    /* Boilerplate */
    // The camera will be in a fixed intertial reference, so the Earth will rotate
    camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 1, 1000);

    const canvas = document.querySelector('#webgl-canvas');
    renderer = new THREE.WebGLRenderer({ antialias: true, canvas });
    renderer.setClearColor(0x000000);
    renderer.toneMapping = THREE.LinearToneMapping;
    renderer.toneMappingExposure = 1.3;

    scene = new THREE.Scene();
    scene.renderer = renderer;

    // Add ambient light
    const ambientLight = new THREE.AmbientLight(0xcccccc, 1);
    scene.add(ambientLight);

    /* Controls */
    controls = new OrbitControls(camera, renderer.domElement);
    controls.minDistance = 7;
    controls.maxDistance = 150;
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.enablePan = true;
    controls.update();

    /* Other objects that are updated during animation callback */
    // Paint the clock immediately
    updateClock(now);

    addStats();

    // Initialize the Earth -- first as a blank, then fill in with textures
    // First create a temporary sphere for camera positioning
    const tempSphere = new THREE.Mesh(
        new THREE.SphereGeometry(5, 16, 16),
        new THREE.MeshBasicMaterial({ color: 0x0e1118 })
    );
    scene.add(tempSphere);
    fitCameraToObject(camera, tempSphere, 5);
    scene.remove(tempSphere);

    // Load everything at once rather than one after another; nothing waits on anything else.
    // The Earth's textures, the star field and the default satellite groups are preloaded by
    // satellites.html, so these mostly pick up downloads that are already under way.
    earth = new Earth(scene, now);
    // Clouds and sea ice load in the background and appear when ready; not awaited so they
    // never hold up the scene
    earth.loadCloudTexture();
    earth.loadSeaIceTexture();
    earth.initialize(interactiveLayer).catch((error) => {
        console.error('Failed to initialize the Earth:', error);
    });

    // The Moon stays off the interactive layer so the satellite raycaster never picks it up.
    // The camera's far plane (1000) already covers the Moon, which sits about 300 scene units out.
    initMoon(scene, now).then((m) => {
        moon = m;
    });

    initSky({ sceneObj: scene }).then((sky) => {
        skybox = sky;
    });

    initSatellites();
}

async function initSatellites() {
    // satellite data is stored in this data structure, position state is handled in a separate webworker
    let satGeo;
    try {
        satGeo = await loadGltfGeometry('./shootingstar3.gltf', 'ShootingStar');
    } catch (error) {
        console.error(`Failed to load satellite model: ${error}`);
        satGeo = new THREE.IcosahedronGeometry(1);
    }
    groupMap = new SatelliteGroupMap(scene, satGeo, interactiveLayer);

    window.addEventListener('displayGroup', onGroupDisplayed, false);
    window.addEventListener('hideGroup', onGroupHidden, false);

    // Set the space stations (ISS & CSS) and the OneWeb constellation to show
    // on page load. Why OneWeb? Because it looks cool, I guess!
    const defaultGroups = new Set(["Space Stations", "OneWeb"]);
    await populateButtonGroup(defaultGroups).then(() => {
        initSettingsMenu();

        // the mouse hover behavior doesn't work well on mobile, but is ok on tablets,
        // at least when a touchpad peripheral is used, so I will leave this behavior in
        // unconditionally
        const hoverHandler = new HoverIntentHandler(renderer, scene, camera, groupMap);
    });
}

function addStats() {
    stats = new Stats();
    stats.domElement.style.position = 'absolute';
    stats.domElement.style.top = '3.5rem';
    // Stats defaults to z-index 10000, which would float it above the group drawer
    stats.domElement.style.zIndex = '1';
    mainElement.appendChild(stats.domElement);
}

function initSettingsMenu() {
    /*
    * This rather large and messy function to set up the UI menu should
    * probably be broken up and moved to a separate source file, but it works,
    * so no need to over-complicate things.
    */
    const settingsMenu = document.querySelector('.settings-menu');
    const toggleButton = document.querySelector('.menu-toggle');
    const menuToggle = document.getElementById('arrowicon-down');

    toggleButton.addEventListener('click', () => {
        settingsMenu.classList.toggle('hidden');
        menuToggle.classList.toggle('on');
    });

    // On narrow screens the satellite group drawer covers this menu, so close it
    // when the drawer opens rather than leaving it open underneath
    window.addEventListener('groupDrawerOpened', () => {
        settingsMenu.classList.add('hidden');
        menuToggle.classList.remove('on');
    });

    const speedStates = new Map([
        [1, '1 sec/s'],
        [10, '10 sec/s'],
        [30, '30 sec/s'],
        [60, '1 min/s'],
        [300, '5 min/s'],
        [1800, '30 min/s'],
        [3600, '1 hr/s']
    ]);

    const plusButton = document.getElementById('plus');
    const minusButton = document.getElementById('minus');
    const speedIndicator = document.getElementById('speed-indicator');
    const realTimeButton = document.getElementById('real-time');
    const realTimeIndicator = document.getElementById('real-time-indicator');
    const projectedIndicator = document.getElementById('projected-indicator');

    const dayBackButton = document.getElementById('day-back');
    const dayForwardButton = document.getElementById('day-forward');

    const starsButton = document.getElementById('stars');
    const cloudsButton = document.getElementById('clouds');
    const seaIceButton = document.getElementById('sea-ice');
    const showAllButton = document.getElementById('show-all');
    const hideAllButton = document.getElementById('hide-all');

    function setRealTime(isRealTime) {
        if (isRealTime) {
            // elapsedTime is in seconds on the main thread due to renderTimer,
            // so remember to divide by 1000 (ms -> s)
            elapsedTime = (Date.now() - now.getTime()) / 1000.0;
            groupMap.setRealTime();
            realTimeIndicator.classList.add('on');
            projectedIndicator.classList.remove('on');
            realTimeButton.classList.add('off');
            realTimeButton.disabled = true;
        } else {
            realTimeIndicator.classList.remove('on');
            projectedIndicator.classList.add('on');
            realTimeButton.classList.remove('off');
            realTimeButton.disabled = false;
        }
    }

    function updateSpeed(currentIndex) {
        groupMap.setSpeed(renderParameters.speedFactor);
        const speedText = speedStates.get(renderParameters.speedFactor);
        speedIndicator.innerHTML = speedText;

        if (currentIndex >= speedStates.size - 1) {
            plusButton.disabled = true;
            plusButton.classList.add('off');
        } else {
            plusButton.disabled = false;
            plusButton.classList.remove('off');
        }
        if (currentIndex <= 0) {
            minusButton.disabled = true;
            minusButton.classList.add('off');
        } else {
            minusButton.disabled = false;
            minusButton.classList.remove('off');
            setRealTime(false);
        }
    }

    plusButton.addEventListener('click', () => {
        const keys = Array.from(speedStates.keys());
        const currentIndex = keys.indexOf(renderParameters.speedFactor);
        if (currentIndex < keys.length - 1) {
            renderParameters.speedFactor = keys[currentIndex + 1];
            updateSpeed(currentIndex + 1);
        }
    });

    minusButton.addEventListener('click', () => {
        const keys = Array.from(speedStates.keys());
        const currentIndex = keys.indexOf(renderParameters.speedFactor);
        if (currentIndex > 0) {
            renderParameters.speedFactor = keys[currentIndex - 1];
            updateSpeed(currentIndex - 1);
        }
    });

    realTimeButton.addEventListener('click', () => {
        renderParameters.speedFactor = 1;
        updateSpeed(renderParameters.speedFactor - 1);
        setRealTime(true);
    });

    // Jump the simulation by a full day. The satellites are propagated inside
    // the workers, so we shift both the main-thread time and every worker's
    // time to keep them in sync.
    function jumpTime(days) {
        elapsedTime += days * secondsPerDay;
        groupMap.shiftTime(days * secondsPerDay);
        // The displayed time no longer tracks the real wall clock.
        setRealTime(false);
    }

    dayBackButton.addEventListener('click', () => jumpTime(-1));
    dayForwardButton.addEventListener('click', () => jumpTime(1));

    starsButton.addEventListener('click', () => {
        if (skybox !== undefined) {
            skybox.toggleStars();
            if (skybox.isStarry()) {
                starsButton.innerHTML = 'Hide Stars';
            } else {
                starsButton.innerHTML = 'Show Stars';
            }
        }
    });

    cloudsButton.addEventListener('click', () => {
        if (earth !== undefined) {
            const visible = earth.toggleClouds();
            cloudsButton.innerHTML = visible ? 'Hide Clouds' : 'Show Clouds';
        }
    });

    seaIceButton.addEventListener('click', () => {
        if (earth !== undefined) {
            const visible = earth.toggleSeaIce();
            seaIceButton.innerHTML = visible ? 'Hide Sea Ice' : 'Show Sea Ice';
        }
    });

    showAllButton.addEventListener('click', async () => {
        await groupMap.toggleAllGroups(true);
        // this is the simplest way I could think of to do this, without creating
        // a spaghetti of state-transferring events
        const groupButtons = document.querySelector('.button-flex').children;
        for (const button of groupButtons) {
            setButtonState(button, true);
        }
    });

    hideAllButton.addEventListener('click', async () => {
        await groupMap.toggleAllGroups(false);
        const groupButtons = document.querySelector('.button-flex').children;
        for (const button of groupButtons) {
            setButtonState(button, false);
        }
    });

}

function initSunPointingHelper() {
    // Create the sun pointing helper, if needed
    const length = 7;
    const color = 0x00ffff;
    sunHelper = new THREE.ArrowHelper(
        getSunPointingAngle(now),
        new THREE.Vector3(0, 0, 0),
        length,
        color
    );
    scene.add(sunHelper);
}

/* Button group event handlers (Show/Hide Satellites) */
function onGroupDisplayed(event) {
    const groupUrl = event.detail;

    if (groupMap.hasGroup(groupUrl)) {
        // Will post a message to the dedicated webworker to start updating
        // transform matrices for the InstancedMesh associated with this group
        groupMap.displayGroup(groupUrl);
    } else {
        // Will post a message to the dedicated webworker to initialize the group,
        // and creates a new InstancedMesh.
        groupMap.onInitGroup(groupUrl);
    }
}

function onGroupHidden(event) {
    const groupUrl = event.detail;
    groupMap.hideGroup(groupUrl);
}

function fitCameraToObject(camera, object, offset) {

    offset = offset || 1.25;

    const boundingBox = new THREE.Box3();

    // get bounding box of object - this will be used to setup controls and camera
    boundingBox.setFromObject(object);

    const dummy = new THREE.Vector3();
    const size = boundingBox.getSize(dummy);

    // get the max side of the bounding box (fits to width OR height as needed )
    const maxDim = Math.max(size.x, size.y, size.z);
    let cameraZ = Math.abs(maxDim / 4 * Math.tan(camera.fov * 2));
    cameraZ *= offset;


    camera.position.z = cameraZ;

    // DO NOT set camera.far in this context! The draw distance should stay fixed. Compare to the
    // version of this function in landing.js
    camera.updateProjectionMatrix();
}

function onWindowResize() {
    const canvas = renderer.domElement;
    const pixelRatio = renderPixelRatio();
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
    renderTimer.update();
    const delta = renderParameters.speedFactor * renderTimer.getDelta();
    elapsedTime += delta;
    const deltaNow = new Date(now.getTime() + elapsedTime * 1000);

    onWindowResize();

    updateClock(deltaNow);

    if (earth !== undefined) {
        earth.update(deltaNow);
        // load larger textures if the camera has zoomed in (or the screen is high-DPI)
        earth.updateDetail(camera);
    }

    if (moon !== undefined) {
        moon.update(deltaNow);
    }

    if (groupMap !== undefined) {
        groupMap.update();
    }

    if (skybox !== undefined && skybox.isStarry()) {
        const sunDirection = earth?.earthMaterial?.uniforms.sunDirection.value;
        if (sunDirection) {
            skybox.material.uniforms.uSunDirection.value.copy(sunDirection);
        }
    }

    controls.update();
    stats.update();

    renderer.render(scene, camera);
    markFrame({
        earthTextured: earth?.ready === true,
        starsVisible: skybox?.isStarry() === true,
        satellitesVisible: groupMap?.anyGroupDisplayed() === true,
        cloudsVisible: earth?.earthMaterial?.uniforms.showClouds.value === true
    });
    requestAnimationFrame(animate);
}

function updateClock(deltaNow) {
    const utcDate = deltaNow.toUTCString().split(' ').slice(1, 4).join(' ');
    const utcTime = deltaNow.toISOString().split('T')[1].split('.')[0];
    const newClockValue = `${utcDate} ${utcTime} Z`;

    if (newClockValue !== previousClockValue) {
        clockElement.textContent = newClockValue;
        previousClockValue = newClockValue;
    }
}
