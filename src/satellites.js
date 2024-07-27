import * as THREE from 'three';
import * as satellite from 'satellite.js';

/* Satellite code -- very rough */

/* Hardcoded test TLE data
const tleLines = [
    // ISS (ZARYA)
    "1 25544U 98067A   24197.73434340 -.00003641  00000+0 -55873-4 0  9998",
    "2 25544  51.6386 173.9126 0010242  70.8365 108.5623 15.49867467462978",
    // Some high altitude satellite (I forgor)
    "1 43873U 18109A   24196.25380453 -.00000006  00000+0  00000+0 0  9991",
    "2 43873  55.3065 119.9592 0029353 194.3360 337.8959  2.00557396 40976",
    // IRIDIUM-140
    "1 43252U 18030D   24197.61300312  .00000155  00000+0  48304-4 0  9990",
    "2 43252  86.3962 223.6120 0002684  90.2873 269.8630 14.34218458329634"
];
*/

// Read the science TLE file
const response = await fetch('/science_tles.txt');
if (!response.ok) {
    throw new Error('Network response was not ok ' + response.statusText);
}
// Split the file content by line breaks to get an array of strings
const data = await response.text();
const tleLines = data.split('\n');

const scaleFactor = radius / 6371;
function addSatellite(satrec, color, name) {
    const positionAndVelocity = satellite.propagate(satrec, now);
    // This app uses ECI coordinates, so there is no need to convert to Geodetic
    const positionEci = positionAndVelocity.position;
    // Create Satellite Mesh and copy in an initial position
    const satGeometry = new THREE.SphereGeometry(0.1, 16, 16);
    const satMaterial = new THREE.MeshBasicMaterial(color);
    const scenePosition = new THREE.Vector3(
        positionEci.x * scaleFactor,
        positionEci.z * scaleFactor,
        -positionEci.y * scaleFactor
    );
    const sat = new THREE.Mesh(satGeometry, satMaterial);
    sat.position.copy(scenePosition);
    sat.name = name;
    return sat;
}

// Modifies the position of a given satellite mesh sat with the propagated SPG4
// position at time t, as a side effect. No retval.
function updateSatellitePosition(satrec, sat, t) {
    const deltaPosVel = satellite.propagate(satrec, t);
    const deltaPosEci = deltaPosVel.position;
    const deltaPos = new THREE.Vector3(
        deltaPosEci.x * scaleFactor,
        deltaPosEci.z * scaleFactor,
        -deltaPosEci.y * scaleFactor
    );
    sat.position.copy(deltaPos);
}

const satrecs = [];
const satellites = [];
const colors = [
    { color: 0xff0000 },
    { color: 0x00ff00 },
    { color: 0x0000ff }
];
// Create satellites one at a time, eventually this should be BufferGeometry
for (let i = 0; i < tleLines.length; i += 3) {
    let satreci = satellite.twoline2satrec(
        tleLines[i+1],
        tleLines[i+2]
    );
    satrecs.push(satreci);
    let sat = addSatellite(satreci, colors[(i / 3) % 3], tleLines[i]);
    satellites.push(sat);
    scene.add(satellites.at(-1));
}

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

// Create an HTML element to display the name
const tooltip = document.createElement('div');
tooltip.style.position = 'absolute';
tooltip.style.backgroundColor = 'rgba(255, 255, 255, 0.7)';
tooltip.style.padding = '5px';
tooltip.style.borderRadius = '3px';
tooltip.style.display = 'none';
document.body.appendChild(tooltip);
renderer.domElement.addEventListener('mousemove', onMouseMove, false);

function onMouseMove(event) {
    event.preventDefault();
    // Update the mouse variable
    mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

    // Update the raycaster with the camera and mouse position
    raycaster.setFromCamera(mouse, camera);

    // Calculate objects intersecting the raycaster
    var intersects = raycaster.intersectObjects(satellites, true);

    if (intersects.length > 0) {
        // Show tooltip with the name
        const intersectedObject = intersects[0].object;
        tooltip.style.left = `${event.clientX + 5}px`;
        tooltip.style.top = `${event.clientY + 5}px`;
        tooltip.style.display = 'block';
        tooltip.innerHTML = intersectedObject.name;
    } else {
        // Hide the tooltip
        tooltip.style.display = 'none';
    }
}

// Function to animate the scene
function animate() {
    requestAnimationFrame(animate);

    const delta = clock.getDelta();
    const scaledDelta = speedFactor * delta;
    
    // Rotate the sphere at the speedFactor x real time speed
    //sphere.rotation.y += rotationRate * scaledDelta;
    elapsedTime += scaledDelta;
    elapsedSecond += scaledDelta;
    // This is jank, use a render clock if you want fixed frame rate
    if (elapsedSecond >= speedFactor / renderFrameRate) {
        // Update the rotations of things
        const deltaNow = new Date(now.getTime() + elapsedTime * 1000);
        const deltaGmst = satellite.gstime(deltaNow);
        const deltaSolarT = getSolarTime(deltaNow);
        const deltaSolarD = getSolarDeclinationAngle(deltaNow);
        sphere.rotation.y = deltaGmst;
        sunHelper.setDirection(getSunPointingAngle(deltaGmst, deltaSolarT, deltaSolarD));
        uniforms.declinationAngle.value = deltaSolarD;
        uniforms.gmst.value = deltaGmst;
        uniforms.solarTime.value = deltaSolarT;

        // Update satellite positions
        for (let j = 0; j < satellites.length; j++) {
            updateSatellitePosition(
                satrecs[j],
                satellites[j],
                deltaNow
            );
        }

        elapsedSecond = 0;
    }
    renderer.render(scene, camera);
}