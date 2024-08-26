// Import necessary Three.js components
import * as THREE from 'three';
import * as satellite from 'satellite.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { populateButtonGroup } from './buttonGroup.js';
import { SatelliteGroupMap } from './satelliteGroupMap.js';
import { initSky } from './skybox.js';
import GUI from 'lil-gui';
import earthVertexShader from './shaders/earth/earthVertex.glsl';
import earthFragmentShader from './shaders/earth/earthFragment.glsl';
import atmosphereVertexShader from './shaders/atmosphere/atmosphereVertex.glsl';
import atmosphereFragmentShader from './shaders/atmosphere/atmosphereFragment.glsl';
import Stats from 'three/addons/libs/stats.module.js';

var gui, camera, scene, renderer, controls, stats;
var earth, earthMaterial, atmosphere, atmosphereMaterial, groupMap;

var raycaster, mouseMove, tooltip;

const earthParameters = {
    radius: 5,
    dayColor: '#d7eaf9',
    twilightColor: '#fd5e53'
};
//const scaleFactor = earthParameters.radius / 6378;
// Determine the initial rotation of the Earth based on the current sidereal time
const now = new Date(); // Get current time
// Use satelliteJS to get the sidereal time, which describes the sidereal rotation (relative to fixed stars aka camera) of the Earth.
const gmst = satellite.gstime(now);



const clockElement = document.getElementById('clock');

/* Animation
 * Uses a renderFrameRate and speedFactor to control the "choppiness" and speed of the animation, respectively. */
// Factor to run the rotation faster than real time, 3600 ~= 1 rotation/minute
const renderParameters = {
    speedFactor: 1, // multiple of realtime
    animFrameRate: 60.0 // frames per second
};
// Var that is used for adjusting simulation speed
var elapsedTime = 0;

function getOffsetHeight() {
    //const container = document.querySelector('.top-container');
    //return container.offsetHeight == 0 ? 56 : container.offsetHeight;
    return 0;
}

async function init() {
    /* Boilerplate */
    gui = new GUI();
    scene = new THREE.Scene();

    // The camera will be in a fixed intertial reference, so the Earth will rotate
    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.z = -13;

    renderer = new THREE.WebGLRenderer({
        antialias: true
    });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // should return 0x000011
    const bgColor = getComputedStyle(document.documentElement).getPropertyValue('--default-bg-color').trim();
    renderer.setClearColor(bgColor);
    renderer.domElement.classList.add('webgl');
    const topContainer = document.querySelector('.top-container');

    // Create a div to contain the Three.js canvas
    const canvasContainer = document.createElement('div');
    canvasContainer.className = 'canvas-container';
    topContainer.appendChild(canvasContainer);

    // Set the renderer's DOM element to the canvas container
    canvasContainer.appendChild(renderer.domElement);

    // Add ambient light
    const ambientLight = new THREE.AmbientLight(0xcccccc, 0.5);
    scene.add(ambientLight);

    // Add controls
    controls = new OrbitControls(camera, renderer.domElement);
    controls.minDistance = 5.5;
    controls.maxDistance = 1000;
    controls.enablePan = false;
    controls.update();

    const textureLoader = new THREE.TextureLoader();

    /* Earth */
    // Create the Earth geometry and material using NASA Blue/Black Marble mosaics. These are from 2004 (Day) and 2012 (Night),
    // but were chosen so that snowy regions would approximately line up between day and night.
    const earthGeometry = new THREE.SphereGeometry(earthParameters.radius, 64, 64);
    // Textures
    const dayTexturePromise = Promise.resolve(textureLoader.load('./BlueMarble_8192x4096.avif'));
    const nightTexturePromise = Promise.resolve(textureLoader.load('./BlackMarble_8192x4096.avif'));
    const specularMapTexturePromise = Promise.resolve(textureLoader.load('./EarthSpec_4096x2048.avif'));
    Promise.all([dayTexturePromise, nightTexturePromise, specularMapTexturePromise]).then((textures) => {
        textures[0].colorSpace = THREE.SRGBColorSpace;
        textures[0].anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
        textures[1].colorSpace = THREE.SRGBColorSpace;
        textures[1].anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
        textures[2].anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

        // Shader material can only be created after all three textures have loaded
        earthMaterial = new THREE.ShaderMaterial({
            uniforms: {
                dayTexture: new THREE.Uniform(textures[0]),
                nightTexture: new THREE.Uniform(textures[1]),
                specularMapTexture: new THREE.Uniform(textures[2]),
                sunDirection: new THREE.Uniform(new THREE.Vector3(0, 0, 1)),
                twilightAngle: new THREE.Uniform(getTwilightAngle()),
                dayColor: new THREE.Uniform(new THREE.Color(earthParameters.dayColor)),
                twilightColor: new THREE.Uniform(new THREE.Color(earthParameters.twilightColor))
            },
            vertexShader: earthVertexShader,
            fragmentShader: earthFragmentShader
        });

        earth = new THREE.Mesh(earthGeometry, earthMaterial);
        scene.add(earth);
        earth.name = "earth";

        /* Atmosphere  -- don't load this until the Earth has been added or it will look weird */
        const atmosphereGeometry = new THREE.SphereGeometry(earthParameters.radius * 1.015, 64, 64);
        atmosphereMaterial = new THREE.ShaderMaterial({
            vertexShader: atmosphereVertexShader,
            fragmentShader: atmosphereFragmentShader,
            uniforms:
            {
                sunDirection: new THREE.Uniform(new THREE.Vector3(0, 0, 1)),
                dayColor: new THREE.Uniform(new THREE.Color(earthParameters.dayColor)),
                twilightColor: new THREE.Uniform(new THREE.Color(earthParameters.twilightColor)),
                twilightAngle: new THREE.Uniform(getTwilightAngle()),
            },
            side: THREE.BackSide,
            transparent: true
        });
        atmosphere = new THREE.Mesh(atmosphereGeometry, atmosphereMaterial);
        scene.add(atmosphere);
        atmosphere.name = "atm";

        // Refer back to definition of gmst if you are confused
        earth.rotation.y = gmst;
        atmosphere.rotation.y = gmst;

        /* Debug stuff for checking seasonal variation and other long-term issues
        // Vernal Equinox 2024, the terminator will be along prime meridian
        const now = new Date(Date.UTC(2024,2,24,3,6,0,0)); 
        // Create a test plane for checking sidereal vs solar day issues.
        const planeGeometry = new THREE.BoxGeometry(0.1, 10, 10);
        const planeMaterial = new THREE.MeshBasicMaterial({ color: 0x0000ff });
        const plane = new THREE.Mesh(planeGeometry, planeMaterial);
        scene.add(plane);
        */

        // Initialize the clock immediately
        updateClock(now);
        controls.update();
        renderer.render(scene, camera);
    });

    // Create the sun pointing helper, if needed
    /*
    const length = 7;
    const color = 0x00ffff;
    const sunHelper = new THREE.ArrowHelper(
        getSunPointingAngle(now),
        new THREE.Vector3(0, 0, 0),
        length,
        color
    );
    scene.add(sunHelper);
    */

    initGuiTweaks();
    addStats();

    raycaster = new THREE.Raycaster();
    mouseMove = new THREE.Vector2();

    // Create an HTML element to display the name
    tooltip = document.createElement('div');
    tooltip.style.fontFamily = 'AudioLink Mono';
    tooltip.style.fontWeight = '300';
    tooltip.style.position = 'absolute';
    tooltip.style.backgroundColor = 'rgba(255, 255, 255, 0.7)';
    tooltip.style.padding = '5px';
    tooltip.style.borderRadius = '3px';
    tooltip.style.display = 'none';
    canvasContainer.appendChild(tooltip);

    window.addEventListener('resize', onWindowResize, false);
    canvasContainer.addEventListener('mousemove', onMouseMove, false);
}

async function initSatellites() {
    // satellite data is stored in this data structure, position state is handled in a separate webworker
    groupMap = new SatelliteGroupMap(scene);
    window.addEventListener('displayGroup', onGroupDisplayed, false);
    window.addEventListener('hideGroup', onGroupHidden, false);
    
    // Set the space stations (ISS & CSS) and the OneWeb constellation to show
    // on page load. Why OneWeb? Because it looks cool, I guess!
    const defaultGroups = new Set(["Space Stations", "OneWeb"]);
    await populateButtonGroup(defaultGroups);
}

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

function initGuiTweaks() {
    // gui debug controls
    gui
        .add(renderParameters, 'speedFactor')
        .min(1)
        .max(3600)
        .onChange(() => {
            groupMap.setSpeed(renderParameters.speedFactor);
        });
}

/* Sun Angle Calculations */
function dayOfYear(date) {
    // Calculate the day of the year for a given date
    const start = new Date(date.getFullYear(), 0, 0);
    const diff = date - start;
    const oneDay = 1000 * 60 * 60 * 24;
    const day = Math.floor(diff / oneDay);
    return day;
}

// Calculate Solar Declination angle (the angle between the sun and the equator used to calculate the terminator)
function getSolarDeclinationAngle(date) {
    const N = dayOfYear(date);
    const obliquityAngle = 23.44 * Math.PI / 180.0;
    // Simplified formula for calculating declination angle https://solarsena.com/solar-declination-angle-calculator/
    const declinationAngle = -obliquityAngle * Math.cos((360 / 365) * (N + 10) * (Math.PI / 180));
    return declinationAngle;
}

function getTwilightAngle() {
    // Civil, Nautical, and Astronomical Twilight account for sun angles up to about 18 degrees past the horizon
    // I am only using the first two for this value since Astronomical Twilight is essentially night
    return 12.0 * Math.PI / 180.0;
}

function getSolarTime(date) {
    const hours = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
    return ((hours - 12) / 24) * 2 * Math.PI;
}

function getSunPointingAngle(tPrime) {
    const siderealTime = satellite.gstime(tPrime);
    const solarTime = getSolarTime(tPrime);
    const declinationAngle = getSolarDeclinationAngle(tPrime);

    // The solar azimuth in ECI is siderealTime (the GMST) - solarTime (the LST)
    const solarAzimuthEci = siderealTime - solarTime;
    // The solar elevation relative to the equator (the x-z plane in scene space) is the declinationAngle
    const solarElevationEci = declinationAngle;
    // Get the unit vector of the sun angle, accounting for the modified axis convention
    const sunDirection = new THREE.Vector3(
        Math.cos(solarElevationEci) * Math.cos(solarAzimuthEci),
        Math.sin(solarElevationEci),
        -Math.cos(solarElevationEci) * Math.sin(solarAzimuthEci)
    );
    earthMaterial.uniforms.sunDirection.value.copy(sunDirection);
    atmosphereMaterial.uniforms.sunDirection.value.copy(sunDirection);
    return sunDirection;
}

function addStats() {
    const canvasContainer = document.getElementsByClassName('canvas-container')[0];
    stats = new Stats();
    stats.domElement.style.position = 'absolute';
    stats.domElement.style.top = '500px';
    canvasContainer.appendChild(stats.domElement);
}

function onMouseMove(event) {
    event.preventDefault();
    // Update the mouse variable
    mouseMove.x = ((event.clientX) / window.innerWidth) * 2 - 1;
    mouseMove.y = -((event.clientY - getOffsetHeight()) / window.innerHeight) * 2 + 1;

    // Update the raycaster with the camera and mouse position
    raycaster.setFromCamera(mouseMove, camera);

    // Calculate objects intersecting the raycaster
    var intersects = raycaster.intersectObjects(scene.children, true);

    if (intersects.length > 0) {
        // Show tooltip with the name
        const intersectedObject = intersects[0].object;
        if (intersectedObject.name == 'earth' || intersectedObject.name == 'atm' || intersectedObject.name == 'sky') {
            tooltip.style.display = 'none';
            return;
        }
        if (groupMap.hasGroup(intersectedObject.name)) {
            const groupName = intersectedObject.name;
            const satelliteName = groupMap.map.get(groupName).names[intersects[0].instanceId];
            tooltip.style.left = `${event.clientX + 5}px`;
            tooltip.style.top = `${event.clientY + 5}px`;
            tooltip.style.display = 'block';
            tooltip.innerHTML = satelliteName;
        }
    } else {
        // Hide the tooltip
        tooltip.style.display = 'none';
    }
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
}

// Function to animate the scene
function animate() {
    const delta = clock.getDelta();
    const scaledDelta = renderParameters.speedFactor * delta;
    elapsedTime += scaledDelta;

    // Update the rotations of things
    const deltaNow = new Date(now.getTime() + elapsedTime * 1000);
    const deltaGmst = satellite.gstime(deltaNow);
    earth.rotation.y = deltaGmst;
    //sunHelper.setDirection(getSunPointingAngle(deltaNow));
    getSunPointingAngle(deltaNow);

    updateClock(deltaNow);

    groupMap.update();

    controls.update();
    stats.update();

    renderer.render(scene, camera);
    requestAnimationFrame(animate);
}

function updateClock(deltaNow) {
    const utcDate = deltaNow.toUTCString().split(' ').slice(1, 4).join(' ');
    const utcTime = deltaNow.toISOString().split('T')[1].split('.')[0];
    clockElement.innerHTML = `${utcDate}<br />${utcTime} Z`;
}

await init();
await initSky({ sceneObj: scene });
await initSatellites();
// Start the animation loop
const clock = new THREE.Clock();
animate();

