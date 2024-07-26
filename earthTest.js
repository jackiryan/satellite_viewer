// Import necessary Three.js components
import * as THREE from 'three';
import * as satellite from 'satellite.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

// Initialize scene, camera, and renderer
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
const renderer = new THREE.WebGLRenderer({
    antialias: true
});
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

// Calculate Solar Declination angle (the angle between the sun and the equator used to calculate the terminator)
function dayOfYear(date) {
    // Calculate the day of the year for a given date
    const start = new Date(date.getFullYear(), 0, 0);
    const diff = date - start;
    const oneDay = 1000 * 60 * 60 * 24;
    const day = Math.floor(diff / oneDay);
    return day;
}

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
    return 36.0 * Math.PI / 180.0;
}

function getSolarTime(date) {
    const hours = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
    return ((hours - 12) / 24) * 2 * Math.PI;
}

function getSunPointingAngle(siderealTime, solarTime, declinationAngle) {
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
    return sunDirection;
}

const now = new Date(); // Get current time
// Use satelliteJS to get the sidereal time, which describes a rotation
const gmst = satellite.gstime(now);

// Create the sphere geometry and material using the Blue Marble texture
const radius = 5;
const geometry = new THREE.SphereGeometry(radius, 32, 32);
const textureLoader = new THREE.TextureLoader();
const dayTexture = textureLoader.load('./BlueMarble_4096x2048.jpg');
const nightTexture = textureLoader.load('./BlackMarble_4096x2048.jpg');
// Shader material
const uniforms = {
    dayTexture: { type: 't', value: dayTexture },
    nightTexture: { type: 't', value: nightTexture },
    declinationAngle: { type: 'f', value: getSolarDeclinationAngle(now) },
    twilightAngle: { type: 'f', value: getTwilightAngle() },
    gmst: { type: 'f', value: gmst },
    solarTime: { type: 'f', value: getSolarTime(now) }
};
const material = new THREE.ShaderMaterial({
    uniforms: uniforms,
    vertexShader: `
        varying vec2 vUv;
        varying vec3 vPosition;

        void main() {
            vUv = uv;
            vPosition = (modelMatrix * vec4(position, 1.0)).xyz;

            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `,
    fragmentShader: `
    uniform sampler2D dayTexture;
    uniform sampler2D nightTexture;
    uniform float declinationAngle;
    uniform float twilightAngle;
    uniform float gmst;
    uniform float solarTime;
    varying vec2 vUv;
    varying vec3 vPosition;

    void main() {
        float cosAngle = cos(-declinationAngle);
        float sinAngle = sin(-declinationAngle);
        // The sphere is rotated by the gmst in scene space, which cares about sidereal time, but we
        // want a "solar time", so back out the gmst rotation and add in a rotation representing the 
        // difference between solar noon at the prime meridian and the time now.
        float rotatedX = vPosition.x * cos(-gmst + solarTime) + vPosition.z * sin(-gmst + solarTime);
        float rotPos = rotatedX * cosAngle - vPosition.y * sinAngle;
        vec3 dayColor = texture2D(dayTexture, vUv).rgb;
        vec3 nightColor = texture2D(nightTexture, vUv).rgb;

        // Blend between day and night offset over the 18 degrees of twilight, biased towards the night side
        // Note that the degrees of twilight is doubled for aesthetic reasons
        float blendFactor = clamp((rotPos + twilightAngle) / twilightAngle, 0.0, 1.0);
        vec3 color = mix(nightColor, dayColor, blendFactor);
        gl_FragColor = vec4(color, 1.0);
    }
    `,
    side: THREE.DoubleSide
});
const sphere = new THREE.Mesh(geometry, material);
scene.add(sphere);
// Determine the initial rotation of the sphere based on the current sidereal time
sphere.rotation.y = gmst;

// Add a shell that we can apply an atmosphere to
var loader = new THREE.FileLoader();
let vShader = await (await fetch('atmosphereVertex.glsl')).text();
let fShader = await (await fetch('atmosphereFragment.glsl')).text();
//loader.load('atmosphereVertex.glsl',  function ( data ) {vShader =  data;},);
//loader.load('atmosphereFragment.glsl',function ( data ) {fShader =  data;},);
const atmosphereRadius = radius * 1.1;
const shellGeometry = new THREE.SphereGeometry(atmosphereRadius, 32, 32);
const atmosphereUniforms = {
    "color" : {
        type: "c",
        //value: new THREE.Color(0xf0f0f0)
        value: new THREE.Color(0x0000ff)
    },
    "planetCenter": {
        value: sphere.position
    },
    "atmosphereRadius": {
        type: "f",
        value: atmosphereRadius
    }
}
const shellMaterial = new THREE.ShaderMaterial({
    uniforms: atmosphereUniforms,
    vertexShader: vShader,
    fragmentShader: fShader,
});
const shellSphere = new THREE.Mesh(shellGeometry, shellMaterial);
scene.add(shellSphere);
//shellSphere.position.x = -5;

// Add ambient light
const ambientLight = new THREE.AmbientLight(0xcccccc, 0.5);
scene.add(ambientLight);

// Add controls
const controls = new OrbitControls(camera, renderer.domElement);

// Controls should be disabled when tracking a satellite
controls.enablePan = false;

// The Earth should go one full rotation in scene space every sidereal day (23 hours, 56 minutes)
// if the simulation is running at 1x speed. Note that the day/night cycle in the frag shader should
// complete one full rotation every solar day (24 hours) TO DO: verify this
const siderealDaySeconds = 86164.0905;
const rotationRate = (2 * Math.PI) / siderealDaySeconds;

// Factor to run the rotation faster than real time, 3600 ~= 1 rotation/minute
const speedFactor = 3600;
const renderFrameRate = 60.0; // frames per second
var elapsedSecond = 0;
var elapsedTime = 0;
// Camera is fixed inertial reference, globe rotates
camera.position.z = -10;
//camera.rotation.y += Math.PI;
controls.update();


function animate() {
    requestAnimationFrame(animate);

    const delta = clock.getDelta();
    const scaledDelta = speedFactor * delta;
    
    // Rotate the sphere at the speedFactor x real time speed
    //sphere.rotation.y += rotationRate * scaledDelta;
    elapsedTime += scaledDelta;
    elapsedSecond += scaledDelta;
    // This is jank, use a render clock if you want fixed frame rate
    /*
    if (elapsedSecond >= speedFactor / renderFrameRate) {
        // Update the rotations of things
        const deltaNow = new Date(now.getTime() + elapsedTime * 1000);
        const deltaGmst = satellite.gstime(deltaNow);
        const deltaSolarT = getSolarTime(deltaNow);
        const deltaSolarD = getSolarDeclinationAngle(deltaNow);
        
        shellSphere.rotation.y = deltaGmst;
        atmosphereUniforms.gmst.value = deltaGmst;
        atmosphereUniforms.solarTime.value = deltaSolarT;
        //sphere.rotation.y = deltaGmst;
        //uniforms.declinationAngle.value = deltaSolarD;
        //uniforms.gmst.value = deltaGmst;
        //uniforms.solarTime.value = deltaSolarT;

        elapsedSecond = 0;
    }
    */
    renderer.render(scene, camera);
}

// Handle window resize
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// Start the animation loop
const clock = new THREE.Clock();
animate();
