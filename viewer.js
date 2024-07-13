// Import necessary Three.js components
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

// Initialize scene, camera, and renderer
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
const renderer = new THREE.WebGLRenderer();
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

// Create the sphere geometry and material using the Blue Marble texture
const geometry = new THREE.SphereGeometry(5, 32, 32);
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
    return 36.0 * Math.PI / 180.0;
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
            float blendFactor = clamp((3.1415926 / 45.0) + (rotatedX + twilightAngle) / twilightAngle, 0.0, 1.0);
            vec3 color = mix(nightColor, dayColor, blendFactor);
            gl_FragColor = vec4(color, 1.0);
        }
    `,
    side: THREE.DoubleSide
});
const sphere = new THREE.Mesh(geometry, material);
scene.add(sphere);

// Position the camera
camera.position.z = 10;

// Add ambient light
const ambientLight = new THREE.AmbientLight(0xcccccc, 0.5);
scene.add(ambientLight);

// Add controls
const controls = new OrbitControls(camera, renderer.domElement);

// Determine the initial rotation of the sphere based on the current time on Earth
const now = new Date();
const hours = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;
sphere.rotation.y = ((hours - 12) / 24) * 2 * Math.PI; // Convert hours to radians

// Function to animate the scene
function animate() {
    requestAnimationFrame(animate);
    // Factor to run the rotation faster than real time, 3600 = 1 rotation/minute
    const speedFactor = 1;
    const realTimeSpeed = 24 * 60 * 60 * 60;
    const earthRotationRate = speedFactor * (2 * Math.PI) / realTimeSpeed;
    
    // Rotate the sphere at 60x real time speed
    sphere.rotation.y += earthRotationRate;
    
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
animate();
