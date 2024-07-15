// Import necessary Three.js components
import * as THREE from 'three';
import * as satellite from 'satellite.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

// Initialize scene, camera, and renderer
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
const renderer = new THREE.WebGLRenderer();
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

// Create the sphere geometry and material using the Blue Marble texture
const radius = 5;
const geometry = new THREE.SphereGeometry(radius, 32, 32);
const textureLoader = new THREE.TextureLoader();
const dayTexture = textureLoader.load('./BlueMarble_4096x2048.jpg');
const nightTexture = textureLoader.load('./BlackMarble_4096x2048.jpg');

// Calculate Solar Declination angle (the angle between the sun and the equator used to calculate the terminator)
function dayOfYear(date) {
    // Calculate the day of the year for a given date
    const start = new Date(date.getFullYear(), 0, 0);
    const diff = date - start;
    const oneDay = 1000 * 60 * 60 * 24;
    const day = Math.floor(diff / oneDay);
    return day;
}

function getSolarDeclinationAngle() {
    // Get the current date
    const date = new Date();
    const N = dayOfYear(date);
    const obliquityAngle = 23.44 * Math.PI / 180.0;
    // Simplified formula for calculating declination angle https://solarsena.com/solar-declination-angle-calculator/
    const declinationAngle = -obliquityAngle * Math.cos((360 / 365) * (N + 10) * (Math.PI / 180));
    return declinationAngle;
}

function getTwilightAngle() {
    // Civil, Nautical, and Astronomical Twilight account for sun angles up to about 18 degrees past the horizon
    // For some reason doubling the number gives me a result that's closer to reality
    return 18.0 * Math.PI / 180.0;
}

// Shader material
const material = new THREE.ShaderMaterial({
    uniforms: {
        dayTexture: { type: 't', value: dayTexture },
        nightTexture: { type: 't', value: nightTexture },
        declinationAngle: { type: 'f', value: getSolarDeclinationAngle() },
        twilightAngle: { type: 'f', value: getTwilightAngle() }
    },
    vertexShader: `
        varying vec2 vUv;
        varying vec3 vPosition;

        void main() {
            vUv = uv;
            vPosition = (modelMatrix * vec4(position, 1.0)).xyz;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `,
    /*
    fragmentShader: `
        uniform sampler2D dayTexture;
        uniform sampler2D nightTexture;
        uniform float declinationAngle;
        uniform float twilightAngle;
        varying vec2 vUv;
        varying vec3 vPosition;

        void main() {
            float cosAngle = cos(-declinationAngle);
            float sinAngle = sin(-declinationAngle);
            float rotatedX = vPosition.x * cosAngle - vPosition.y * sinAngle;
            vec3 dayColor = texture2D(dayTexture, vUv).rgb;
            vec3 nightColor = texture2D(nightTexture, vUv).rgb;

            // Blend between day and night offset over the 18 degrees of twilight, biased towards the night side
            // Add a 4 degree nudge since civil twilight seems to start when the sun is 2 degrees below the horizon
            // Use 4 because doubling the numbers made it look better visually compared to online resources
            float blendFactor = clamp((3.1415926 / 90.0) + (rotatedX + twilightAngle) / twilightAngle, 0.0, 1.0);
            vec3 color = mix(nightColor, dayColor, blendFactor);
            gl_FragColor = vec4(color, 1.0);
        }
    `,
    */
    fragmentShader: `
    uniform sampler2D dayTexture;
    uniform sampler2D nightTexture;
    uniform float declinationAngle;
    uniform float twilightAngle;
    varying vec2 vUv;
    varying vec3 vPosition;

    void main() {
        float cosAngle = cos(-declinationAngle);
        float sinAngle = sin(-declinationAngle);
        float rotatedX = vPosition.y * cosAngle - vPosition.z * sinAngle;
        vec3 dayColor = texture2D(dayTexture, vUv).rgb;
        vec3 nightColor = texture2D(nightTexture, vUv).rgb;

        // Blend between day and night offset over the 18 degrees of twilight, biased towards the night side
        // Add a 4 degree nudge since civil twilight seems to start when the sun is 2 degrees below the horizon
        // Use 4 because doubling the numbers made it look better visually compared to online resources
        float blendFactor = clamp((3.1415926 / 90.0) + (rotatedX + twilightAngle) / twilightAngle, 0.0, 1.0);
        vec3 color = mix(nightColor, dayColor, blendFactor);
        gl_FragColor = vec4(color, 1.0);
    }
    `,
    side: THREE.DoubleSide
});
const sphere = new THREE.Mesh(geometry, material);
scene.add(sphere);

const now = new Date(); // Current time
// Satellite JS Example TLE Data
const tleLine1 = "1 25544U 98067A   24196.87887973  .00024315  00000+0  43401-3 0  9998";
const tleLine2 = "2 25544  51.6406 178.1499 0010661  68.1448  15.0403 15.49862093462842";
const tleLine3 = "1 43873U 18109A   24196.25380453 -.00000006  00000+0  00000+0 0  9991";
const tleLine4 = "2 43873  55.3065 119.9592 0029353 194.3360 337.8959  2.00557396 40976";

// Calculate Satellite Position
const satrec = satellite.twoline2satrec(tleLine1, tleLine2);
const positionAndVelocity = satellite.propagate(satrec, now);
const positionEci = positionAndVelocity.position;
const scaleFactor = radius / 6371;
const scenePosition = new THREE.Vector3(
    positionEci.x * scaleFactor,
    positionEci.y * scaleFactor,
    positionEci.z * scaleFactor
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
    positionEci2.y * scaleFactor,
    positionEci2.z * scaleFactor
);

// Create ECI Satellite Mesh
const satGeometry2 = new THREE.SphereGeometry(0.1, 16, 16);
const satMaterial2 = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
const twosat = new THREE.Mesh(satGeometry2, satMaterial2);
twosat.position.copy(scenePosition2);
scene.add(twosat);

// Position the camera
camera.position.z = 10;

// Add ambient light
const ambientLight = new THREE.AmbientLight(0xcccccc, 0.5);
scene.add(ambientLight);

// Add controls
const controls = new OrbitControls(camera, renderer.domElement);

// Determine the initial rotation of the sphere based on the current time on Earth
// Calculate time differences
const gmst = satellite.gstime(now);
sphere.rotation.x = Math.PI / 2;
//sphere.rotation.z = -Math.PI / 2;
sphere.rotation.y = gmst;
/*
const msPerDay = 86400000.0; // Number of milliseconds in a day
const daysSinceUnix = 2440587.5; // Julian days from the start of Unix time to J2000
var julianDate =  now / msPerDay + daysSinceUnix;
console.log(julianDate);

const earthRotationAngle = 2 * Math.PI * (0.7790572732640 + 1.00273781191135448 * julianDate);
console.log(earthRotationAngle);
const gmst = earthRotationAngle + 
             (0.014506 + 4612.156534 * julianCenturies + 1.3915817 * Math.pow(julianCenturies, 2) - 0.00000044 * Math.pow(julianCenturies, 3) - 0.000029956 * Math.pow(julianCenturies, 4) - 0.000000368 * Math.pow(julianCenturies, 5));
*/
/*
const daysSinceJ2000 = (now - J2000) / msPerDay;

// Calculate Earth's axial rotation

const secondsSinceJ2000 = daysSinceJ2000 * 86400; // Convert days to seconds

const axialRotationRadians = (secondsSinceJ2000 % siderealDaySeconds) / siderealDaySeconds * 2 * Math.PI;
sphere.rotation.y = axialRotationRadians;
*/
const siderealDaySeconds = 86164.0905;

const rotationRate = (2 * Math.PI) / siderealDaySeconds;
// Factor to run the rotation faster than real time, 3600 = 1 rotation/minute
const speedFactor = 1;

// Function to animate the scene
function animate() {
    requestAnimationFrame(animate);

    const delta = clock.getDelta();
    
    // Rotate the sphere at 60x real time speed
    sphere.rotation.y += speedFactor * rotationRate * delta;
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

// Function to position the camera to point at the user's current time zone
function positionCamera() {
    const longitude = getUserLongitude();
    // Kind of messy, but since we rotate the sphere to account for the current time,
    // moving the camera to account for user longitude requires backing out that rotation
    // Add 90 degrees to account for discrepancy between 0 longitude (where the prime meridian is)
    // and 0 "longitude" on the sphere (where the texture is wrapped, around the date line)
    const initRotation = sphere.rotation.y + Math.PI / 2; 
    camera.position.x = 10 * Math.sin(longitude + initRotation);
    camera.position.z = 10 * Math.cos(longitude + initRotation);
    camera.lookAt(sphere.position);
}


// Handle window resize
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// Set camera initial position based on user tz
positionCamera();

// Start the animation loop
const clock = new THREE.Clock();
animate();
