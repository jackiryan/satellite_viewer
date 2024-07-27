// Import necessary Three.js components
import * as THREE from 'three';
import * as satellite from 'satellite.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import GUI from 'lil-gui';
import earthVertexShader from './shaders/earth/earthVertex.glsl';
import earthFragmentShader from './shaders/earth/earthFragment.glsl';
import atmosphereVertexShader from './shaders/atmosphere/atmosphereVertex.glsl'
import atmosphereFragmentShader from './shaders/atmosphere/atmosphereFragment.glsl'

/* Boilerplate */

// Debug
const gui = new GUI();

// Initialize scene...
const scene = new THREE.Scene();

// ... the camera, which will be in a fixed intertial reference, so the Earth will rotate ...
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.z = -10;

// ... and the renderer
const renderer = new THREE.WebGLRenderer({
    antialias: true
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor('#000011');
document.body.appendChild(renderer.domElement);

// Loader
const textureLoader = new THREE.TextureLoader();

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
    // For some reason doubling the number gives me a result that's closer to reality
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


/* Earth */
// Create the Earth geometry and material using NASA Blue/Black Marble mosaics. These are from 2004 (Day) and 2012 (Night),
// but were chosen so that snowy regions would approximately line up between day and night.
const earthParameters = {
    radius: 5,
    dayColor: '#ffffff',
    twilightColor: '#ff6600'
};

// gui debug controls
gui
    .addColor(earthParameters, 'dayColor')
    .onChange(() =>
    {
        earthMaterial.uniforms.dayColor.value.set(earthParameters.dayColor);
        atmosphereMaterial.uniforms.dayColor.value.set(earthParameters.dayColor);
    });
gui
    .addColor(earthParameters, 'twilightColor')
    .onChange(() =>
    {
        earthMaterial.uniforms.twilightColor.value.set(earthParameters.twilightColor);
        atmosphereMaterial.uniforms.twilightColor.value.set(earthParameters.twilightColor);
    });

// Textures
const dayTexture = textureLoader.load('./BlueMarble_4096x2048.jpg');
dayTexture.colorSpace = THREE.SRGBColorSpace;
dayTexture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
const nightTexture = textureLoader.load('./BlackMarble_4096x2048.jpg');
nightTexture.colorSpace = THREE.SRGBColorSpace;
nightTexture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

// Mesh
const earthGeometry = new THREE.SphereGeometry(earthParameters.radius, 64, 64);

// Shader material
const earthMaterial = new THREE.ShaderMaterial({
    uniforms: {
        dayTexture: new THREE.Uniform(dayTexture),
        nightTexture: new THREE.Uniform(nightTexture),
        sunDirection: new THREE.Uniform(new THREE.Vector3(0, 0, 1)),
        twilightAngle: new THREE.Uniform(getTwilightAngle()),
        dayColor: new THREE.Uniform(new THREE.Color(earthParameters.dayColor)),
        twilightColor: new THREE.Uniform(new THREE.Color(earthParameters.twilightColor))
    },
    vertexShader: earthVertexShader,
    fragmentShader: earthFragmentShader
});
const earth = new THREE.Mesh(earthGeometry, earthMaterial);
scene.add(earth);

// Atmosphere
const atmosphereMaterial = new THREE.ShaderMaterial({
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
const atmosphereGeometry = new THREE.SphereGeometry(earthParameters.radius * 1.015, 64, 64);
const atmosphere = new THREE.Mesh(atmosphereGeometry, atmosphereMaterial);
scene.add(atmosphere);

/* Debug stuff for Earth rotation
//const now = new Date(Date.UTC(2024,2,24,3,6,0,0)); // Vernal Equinox 2024, helpful for testing
// Create a test plane for checking sidereal vs solar day issues.
const planeGeometry = new THREE.BoxGeometry(0.1, 10, 10);
const planeMaterial = new THREE.MeshBasicMaterial({ color: 0x0000ff });
const plane = new THREE.Mesh(planeGeometry, planeMaterial);
scene.add(plane);
*/

// Determine the initial rotation of the sphere based on the current sidereal time
const now = new Date(); // Get current time
// Use satelliteJS to get the sidereal time, which describes the sidereal rotation of the Earth.
const gmst = satellite.gstime(now);
earth.rotation.y = gmst;
atmosphere.rotation.y = gmst;

// Create the sun pointing helper
const length = 7;
const color = 0x00ffff;
const sunHelper = new THREE.ArrowHelper(
    getSunPointingAngle(now),
    new THREE.Vector3(0, 0, 0),
    length,
    color
);
scene.add(sunHelper);

// Add ambient light
const ambientLight = new THREE.AmbientLight(0xcccccc, 0.5);
scene.add(ambientLight);

// Add controls
const controls = new OrbitControls(camera, renderer.domElement);
controls.enablePan = false;
controls.update();

// Handle window resize
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
});

/* Animation
 * Uses a renderFrameRate and speedFactor to control the "choppiness" and speed of the animation, respectively. */
// Factor to run the rotation faster than real time, 3600 ~= 1 rotation/minute
const renderParameters = {
    speedFactor: 1, // multiple of realtime
    animFrameRate: 30.0 // frames per second
};
// gui debug controls
gui
    .add(renderParameters, 'speedFactor')
    .min(1)
    .max(3600);

gui
    .add(renderParameters, 'animFrameRate')
    .min(10)
    .max(60);

// Vars that are used for rendering at a fixed framerate while
// being able to adjust the simulation speed
var elapsedSecond = 0;
var elapsedTime = 0;
// Function to animate the scene
function animate() {
    const delta = clock.getDelta();
    const scaledDelta = renderParameters.speedFactor * delta;
    
    elapsedTime += scaledDelta;
    elapsedSecond += delta;

    // This is jank, use a render clock if you want fixed frame rate
    if (elapsedSecond >= 1.0 / renderParameters.animFrameRate) {
        // Update the rotations of things
        const deltaNow = new Date(now.getTime() + elapsedTime * 1000);
        const deltaGmst = satellite.gstime(deltaNow);
        earth.rotation.y = deltaGmst;
        //atmosphere.rotation.y = deltaGmst;
        sunHelper.setDirection(getSunPointingAngle(deltaNow));

        // reset the render clock
        elapsedSecond = 0;
    }
    
    controls.update();

    renderer.render(scene, camera);
    requestAnimationFrame(animate);
}

// Start the animation loop
const clock = new THREE.Clock();
animate();
