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

// Create the sphere geometry and material using the Blue Marble texture
const radius = 5;
const geometry = new THREE.SphereGeometry(radius, 32, 32);
const textureLoader = new THREE.TextureLoader();
const dayTexture = textureLoader.load('./BlueMarble_4096x2048.jpg');
const nightTexture = textureLoader.load('./BlackMarble_4096x2048.jpg');

/*
// Phong Material stuff for testing normal map
const normalTexture = textureLoader.load('earth_normalmap.png');
const material = new THREE.MeshPhongMaterial();
material.map = dayTexture;
material.normalMap = normalTexture;
material.normalScale.set(2, 2);

// A point light is needed to test the normal map
const light = new THREE.PointLight(0xffffff, 200);
light.position.set(0, 7, 10);
scene.add(light);
*/

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

//const now = new Date(Date.UTC(2024,2,24,3,6,0,0)); // Vernal Equinox 2024, helpful for testing
const now = new Date(); // Get current time
// Use satelliteJS to get the sidereal time, which describes a rotation
const gmst = satellite.gstime(now);
const uniforms = {
    dayTexture: { type: 't', value: dayTexture },
    nightTexture: { type: 't', value: nightTexture },
    declinationAngle: { type: 'f', value: getSolarDeclinationAngle(now) },
    twilightAngle: { type: 'f', value: getTwilightAngle() },
    gmst: { type: 'f', value: gmst },
    solarTime: { type: 'f', value: getSolarTime(now) }
};

// Shader material
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

// Create the sun pointing helper
const length = 7;
const color = 0x00ffff;
const sunHelper = new THREE.ArrowHelper(
    getSunPointingAngle(gmst, getSolarTime(now), getSolarDeclinationAngle(now)),
    new THREE.Vector3(0, 0, 0),
    length,
    color
);
scene.add(sunHelper);


/* Satellite code -- very rough */

// Satellite JS Example TLE Data
const tleLine1 = "1 25544U 98067A   24197.73434340 -.00003641  00000+0 -55873-4 0  9998";
const tleLine2 = "2 25544  51.6386 173.9126 0010242  70.8365 108.5623 15.49867467462978";
const tleLine3 = "1 43873U 18109A   24196.25380453 -.00000006  00000+0  00000+0 0  9991";
const tleLine4 = "2 43873  55.3065 119.9592 0029353 194.3360 337.8959  2.00557396 40976";
const tleLine5 = "1 43252U 18030D   24197.61300312  .00000155  00000+0  48304-4 0  9990";
const tleLine6 = "2 43252  86.3962 223.6120 0002684  90.2873 269.8630 14.34218458329634";

// Calculate Satellite Position
const satrec = satellite.twoline2satrec(tleLine1, tleLine2);
const positionAndVelocity = satellite.propagate(satrec, now);
const positionEci = positionAndVelocity.position;
const velocityEci = positionAndVelocity.velocity;
const scaleFactor = radius / 6371;
const scenePosition = new THREE.Vector3(
    positionEci.x * scaleFactor,
    positionEci.z * scaleFactor,
    -positionEci.y * scaleFactor
);
const instVelocity = new THREE.Vector3(
    velocityEci.x * scaleFactor,
    velocityEci.z * scaleFactor,
    -velocityEci.y * scaleFactor
);

// Create ECI Satellite Mesh
const satGeometry = new THREE.SphereGeometry(0.1, 16, 16);
const satMaterial = new THREE.MeshBasicMaterial({ color: 0xff0000 });
const onesat = new THREE.Mesh(satGeometry, satMaterial);
onesat.position.copy(scenePosition);
scene.add(onesat);

// Calculate Satellite Position
const satrec2 = satellite.twoline2satrec(tleLine3, tleLine4);
const positionAndVelocity2 = satellite.propagate(satrec2, now);
const positionEci2 = positionAndVelocity2.position;
const scenePosition2 = new THREE.Vector3(
    positionEci2.x * scaleFactor,
    positionEci2.z * scaleFactor,
    -positionEci2.y * scaleFactor
);

// Create ECI Satellite Mesh
const satGeometry2 = new THREE.SphereGeometry(0.1, 16, 16);
const satMaterial2 = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
const twosat = new THREE.Mesh(satGeometry2, satMaterial2);
twosat.position.copy(scenePosition2);
scene.add(twosat);

// Calculate Satellite Position
const satrec3 = satellite.twoline2satrec(tleLine5, tleLine6);
const positionAndVelocity3 = satellite.propagate(satrec3, now);
const positionEci3 = positionAndVelocity3.position;
const scenePosition3 = new THREE.Vector3(
    positionEci3.x * scaleFactor,
    positionEci3.z * scaleFactor,
    -positionEci3.y * scaleFactor
);

// Create ECI Satellite Mesh
const satGeometry3 = new THREE.SphereGeometry(0.1, 16, 16);
const satMaterial3 = new THREE.MeshBasicMaterial({ color: 0x0000ff });
const threesat = new THREE.Mesh(satGeometry3, satMaterial3);
threesat.position.copy(scenePosition3);
scene.add(threesat);

/*
// Create a test plane for checking sidereal vs solar day issues.
const planeGeometry = new THREE.BoxGeometry(0.1, 10, 10);
const planeMaterial = new THREE.MeshBasicMaterial({ color: 0x0000ff });
const plane = new THREE.Mesh(planeGeometry, planeMaterial);
scene.add(plane);
*/


// Add ambient light
const ambientLight = new THREE.AmbientLight(0xcccccc, 0.5);
scene.add(ambientLight);

// Add controls
const controls = new OrbitControls(camera, renderer.domElement);
//controls.enablePan = false;
//controls.enableZoom = false;

// The Earth should go one full rotation in scene space every sidereal day (23 hours, 56 minutes)
// if the simulation is running at 1x speed. Note that the day/night cycle in the frag shader should
// complete one full rotation every solar day (24 hours) TO DO: verify this
const siderealDaySeconds = 86164.0905;
const rotationRate = (2 * Math.PI) / siderealDaySeconds;

// Factor to run the rotation faster than real time, 3600 ~= 1 rotation/minute
const speedFactor = 60;
const satelliteFrameRate = 10.0; // frames per second
var elapsedSecond = 0;
var elapsedTime = 0;
camera.position.x = -10 * Math.cos(-gmst);
camera.position.z = -10 * Math.sin(-gmst);
camera.lookAt(sphere.position);

// Function to animate the scene
function animate() {
    requestAnimationFrame(animate);

    const delta = clock.getDelta();
    const scaledDelta = speedFactor * delta;
    
    // Rotate the sphere at the speedFactor x real time speed
    //sphere.rotation.y += rotationRate * scaledDelta;
    elapsedTime += scaledDelta;
    elapsedSecond += scaledDelta;
    if (elapsedSecond >= speedFactor / satelliteFrameRate) {
        const deltaNow = new Date(now.getTime() + elapsedTime * 1000);
        const deltaGmst = satellite.gstime(deltaNow);
        const deltaSolarT = getSolarTime(deltaNow);
        const deltaSolarD = getSolarDeclinationAngle(deltaNow);
        sphere.rotation.y = deltaGmst;
        sunHelper.setDirection(getSunPointingAngle(deltaGmst, deltaSolarT, deltaSolarD));
        uniforms.declinationAngle.value = deltaSolarD;
        uniforms.gmst.value = deltaGmst;
        uniforms.solarTime.value = deltaSolarT;
        const deltaPosVel = satellite.propagate(satrec, deltaNow);
        const deltaPosVel3 = satellite.propagate(satrec3, deltaNow);
        const deltaPosEci = deltaPosVel.position;
        const deltaPosEci3 = deltaPosVel3.position;
        const deltaPos = new THREE.Vector3(
            deltaPosEci.x * scaleFactor,
            deltaPosEci.z * scaleFactor,
            -deltaPosEci.y * scaleFactor
        );
        const deltaPos3 = new THREE.Vector3(
            deltaPosEci3.x * scaleFactor,
            deltaPosEci3.z * scaleFactor,
            -deltaPosEci3.y * scaleFactor
        )
        onesat.position.copy(deltaPos);
        threesat.position.copy(deltaPos3);
        /* Weird camera control experimentation
        const deltaCam = new THREE.Vector3(
            -10 * Math.cos(-deltaGmst),
            camera.position.y,
            -10 * Math.sin(-deltaGmst)
        );
        camera.position.copy(deltaCam);
        controls.update();
        // Update the controls target to the object's position
        //camera.position.copy(threesat.position).add(cameraOffset);
        //controls.update();
        //camera.position.copy(threesat.position + cameraToSat);
        //controls.update();
        */
        elapsedSecond = 0;
    }
    renderer.render(scene, camera);
}

// Function to position the camera based on the user's time zone offset. No need to use precise location information for a toy.
function getUserLongitude() {
    const now = new Date();
    // function returns value in mins, convert to hours
    const timeZoneOffset = now.getTimezoneOffset() / 60;

    // Longitude corresponding to the user's time zone
    // Each hour difference corresponds to 15 degrees of longitude
    // Convert this value to radians
    const longitude = (-timeZoneOffset * 15) * Math.PI / 180.0;
    return longitude;
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
