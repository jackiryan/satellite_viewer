import * as THREE from 'three';
import * as satellite from 'satellite.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

// ThreeJS Initialization
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
const renderer = new THREE.WebGLRenderer();
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

// Add Globe
const radius = 1;
const geometry = new THREE.SphereGeometry(radius, 32, 32);
const textureLoader = new THREE.TextureLoader();
const material = new THREE.MeshBasicMaterial({
  map: textureLoader.load('./BlueMarble_4096x2048.jpg')
});
const globe = new THREE.Mesh(geometry, material);
scene.add(globe);

// Position Camera
camera.position.z = 2;

// Satellite JS Example TLE Data
const tleLine1 = "1 25544U 98067A   24196.87887973  .00024315  00000+0  43401-3 0  9998";
const tleLine2 = "2 25544  51.6406 178.1499 0010661  68.1448  15.0403 15.49862093462842";

// Calculate Satellite Position
const satrec = satellite.twoline2satrec(tleLine1, tleLine2);
const date = new Date();
const positionAndVelocity = satellite.propagate(satrec, date);
const positionEci = positionAndVelocity.position;
const scaleFactor = radius / 6371;
const scenePosition = new THREE.Vector3(
    -positionEci.x * scaleFactor,
    -positionEci.y * scaleFactor,
    -positionEci.z * scaleFactor
);

/*
const velocityEci = new THREE.Vector3(positionAndVelocity.velocity);
const mu = 3.986004418e14;
const evec = ((Math.pow(velocityEci.length(), 2) - mu / positionEci.length()) * positionEci - positionEci.dot(velocityEci) * velocityEci) / mu;
const e = evec.length();
const energy = Math.pow(velocityEci.length(), 2) / 2 - mu / positionEci.length();
const a = -mu / (2 * energy);
const b = a * Math.sqrt(1 - Math.pow(e, 2));
*/



// Convert Latitude and Longitude to 3D Coordinates
function latLonToVector3(lat, lon, radius = 1) {
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (lon + 180) * (Math.PI / 180);
  const x = -radius * Math.sin(phi) * Math.cos(theta);
  const y = radius * Math.cos(phi);
  const z = radius * Math.sin(phi) * Math.sin(theta);
  return new THREE.Vector3(x, y, z);
}

// Do all this extra crap to calculate lat lon
const gmst = satellite.gstime(date);
const positionGd = satellite.eciToGeodetic(positionEci, gmst);
const longitude = positionGd.longitude;
const latitude = positionGd.latitude;
const satellitePosition = latLonToVector3(THREE.MathUtils.radToDeg(latitude), THREE.MathUtils.radToDeg(longitude));

// Create ECI Satellite Mesh
const satGeometry = new THREE.SphereGeometry(0.02, 16, 16);
const satMaterial = new THREE.MeshBasicMaterial({ color: 0xff0000 });
const onesat = new THREE.Mesh(satGeometry, satMaterial);
onesat.position.copy(scenePosition);
scene.add(onesat);

// Create Geodetic Satellite Mesh
const sat2Geometry = new THREE.SphereGeometry(0.02, 16, 16);
const sat2Material = new THREE.MeshBasicMaterial({ color: 0xff0000 });
const twosat = new THREE.Mesh(sat2Geometry, sat2Material);
twosat.position.copy(satellitePosition);
scene.add(twosat);

// Animation Loop
function animate() {
  requestAnimationFrame(animate);
  renderer.render(scene, camera);
}

// Add controls
const controls = new OrbitControls(camera, renderer.domElement);

// Handle window resize
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

animate();