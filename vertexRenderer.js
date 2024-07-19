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
const scaleFactor = radius / 6171; // scaling between scene radius and true Earth radius.
const geometry = new THREE.SphereGeometry(radius, 32, 32);
const textureLoader = new THREE.TextureLoader();
const dayTexture = textureLoader.load('./BlueMarble_4096x2048.jpg');
const material = new THREE.MeshBasicMaterial({
    map: dayTexture
});
const sphere = new THREE.Mesh(geometry, material);
scene.add(sphere);
const now = new Date();
const gmst = satellite.gstime(now);
sphere.rotation.y = gmst;

/* Satellite handling code */

// Create the buffer geometry for the satellites
function initializeSatelliteBuffer(tleLines) {
    const geometry = new THREE.BufferGeometry();

    var satVerts = new Float32Array(Math.floor(tleLines.length / 3));
    // Create satellites one at a time, using BufferGeometry
    for (let i = 0; i < tleLines.length; i += 3) {
        const satrec = satellite.twoline2satrec(
            tleLines[i+1],
            tleLines[i+2]
        );

        const positionVelocity = satellite.propagate(
            satrec,
            now
        );
        const positionEci = positionVelocity.position;
        satVerts[i/3]     =  positionEci.x * scaleFactor;
        satVerts[(i/3)+1] =  positionEci.z * scaleFactor;
        satVerts[(i/3)+2] = -positionEci.y * scaleFactor;

    }
    geometry.setAttribute(
        'position',
        new THREE.BufferAttribute(satVerts, 3)
    );
    const material = new THREE.MeshBasicMaterial( { color: 0xff0000 } );
    const mesh = new THREE.Mesh(geometry, material);
    return mesh;
}

// Read the science TLE file
const response = await fetch('/science_tles.txt');
if (!response.ok) {
    throw new Error('Network response was not ok ' + response.statusText);
}
// Split the file content by line breaks to get an array of strings
const data = await response.text();
const tleLines = data.split('\n');
const bufferMesh = initializeSatelliteBuffer(tleLines);
scene.add(bufferMesh);

// Add ambient light
const ambientLight = new THREE.AmbientLight(0xcccccc, 0.5);
scene.add(ambientLight);

// Add controls
const controls = new OrbitControls(camera, renderer.domElement);
camera.position.z = 10;
controls.update();

// Handle window resize
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// Function to animate the scene
function animate() {
    requestAnimationFrame(animate);
    
    renderer.render(scene, camera);
}

animate();