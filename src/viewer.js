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
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 100, 100000);
camera.position.z = -20000;

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
    radius: 6378,
    dayColor: '#d7eaf9',
    twilightColor: '#fd5e53'
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
const specularMapTexture = textureLoader.load('./EarthSpec_4096x2048.jpg');
specularMapTexture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
// Mesh
const earthGeometry = new THREE.SphereGeometry(earthParameters.radius, 64, 64);

// Shader material
const earthMaterial = new THREE.ShaderMaterial({
    uniforms: {
        dayTexture: new THREE.Uniform(dayTexture),
        nightTexture: new THREE.Uniform(nightTexture),
        specularMapTexture: new THREE.Uniform(specularMapTexture),
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

/* Satellites */
// Read the whole TLE catalog now
//const response = await fetch('https://celestrak.org/NORAD/elements/catalog.txt');
const response = await fetch('./full_catalog.txt')
if (!response.ok) {
    throw new Error('Network response was not ok ' + response.statusText);
}
// Split the file content by line breaks to get an array of strings
const data = await response.text();
const tleLines = data.split('\n').filter(function (el) {
    return el != '';
});
//console.log(tleLines);

const scaleFactor = earthParameters.radius / 6378;
var minXpos = 0.0;

// Create the buffer geometry for the satellites
function initializeSatelliteBuffer(tleLines) {
    const geometry = new THREE.BufferGeometry();


    var satVerts = new Float32Array(Math.floor(tleLines.length));
    // Create satellites one at a time, using BufferGeometry
    for (let i = 0; i < tleLines.length; i += 3) {
        // The unknown objects create issues for some reason I don't want to figure out rn
        //if (tleLines[i].includes("UNKNOWN") || !tleLines[i].includes("ONEWEB")) {
        if (tleLines[i].includes("UNKNOWN")) {
            continue;
        }
        const satrec = satellite.twoline2satrec(
            tleLines[i+1],
            tleLines[i+2]
        );

        const positionVelocity = satellite.propagate(
            satrec,
            now
        );
        const positionEci = positionVelocity.position;
        satVerts[i]     =  positionEci.x * scaleFactor;
        satVerts[i+1] =  positionEci.z * scaleFactor;
        satVerts[i+2] = -positionEci.y * scaleFactor;
    }
    minXpos = Math.min(...satVerts);
    geometry.setAttribute(
        'position',
        new THREE.BufferAttribute(satVerts, 3)
    );
    const material = new THREE.ShaderMaterial({
        uniforms: {
            planeXpos: new THREE.Uniform(0.0)
        },
        vertexShader: `
            uniform float planeXpos;

            varying float vSize;
            void main() {
                vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
                // scale the vertices based on depth, base size 50 units
                float size = 20000.0 / -mvPosition.z;
                vSize = size * step(0.0, position.x - planeXpos);
                //vSize = size;

                gl_Position = projectionMatrix * mvPosition;
                gl_PointSize = vSize;
            }
        `,
        fragmentShader: `
        uniform float planeXpos;
        varying float vSize;
        void main() {
            if (vSize <= 0.0) {
                discard;
            }
            vec3 color = vec3(1.0, 1.0, 1.0);
            gl_FragColor = vec4(color, 1.0);
        }
        `,
        transparent: true
    });
    const mesh = new THREE.Points(geometry, material);
    return mesh;
}

function updateSatelliteCullPoint(xOffset) {
    pointCloud.material.uniforms.planeXpos.value = xOffset;
}

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

const pointCloud = initializeSatelliteBuffer(tleLines);
scene.add(pointCloud);


/*
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
*/

// Create the sun pointing helper
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

// Add quad
const geometry = new THREE.BoxGeometry(1000, 20000, 20000);
const material = new THREE.ShaderMaterial({
    uniforms: {},
    vertexShader: `
        varying vec3 vNormal;
        void main() {
            vNormal = (modelMatrix * vec4(normal, 0.0)).xyz;
            gl_Position = projectionMatrix *  modelViewMatrix * vec4(position, 1.0);
        }
    `,
    fragmentShader: `
    varying vec3 vNormal;
    void main() {
        // pink pink
        vec3 color = vec3(0.9686274509803922, 0.12549019607843137, 0.5686274509803921);
        color.x *= abs(vNormal.x);
        gl_FragColor = vec4(color, 1.0);
    }
    `
});
const quad = new THREE.Mesh(geometry, material);
scene.add(quad);

const sliderParams = {
    enableQuad: false,
};

quad.visible = sliderParams.enableQuad;
if (!sliderParams.enableQuad) {
    updateSatelliteCullPoint(minXpos - 10);
}

gui
    .add(sliderParams, 'enableQuad')
    .onChange(() =>
    {
        quad.visible = sliderParams.enableQuad;
        if (!sliderParams.enableQuad) {
            isDragging = false;
            controls.enabled = true;
            updateSatelliteCullPoint(minXpos - 10);
        } else {
            updateSatelliteCullPoint(quad.position.x);
        }
    });

// Add ambient light
const ambientLight = new THREE.AmbientLight(0xcccccc, 0.5);
scene.add(ambientLight);

//const pointLight = new THREE.PointLight(0xffffff,1,100000,100000);
//pointLight.position.z = 20000;
//scene.add(pointLight);

// Add controls
const controls = new OrbitControls(camera, renderer.domElement);
controls.enablePan = false;
controls.update();


const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

let isDragging = false;
let dragOffset = new THREE.Vector3();

function onMouseMove(event) {
    if (!sliderParams.enableQuad) return;
    event.preventDefault();
    mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

    if (isDragging) {
        raycaster.setFromCamera(mouse, camera);
        const vector = new THREE.Vector3(mouse.x, mouse.y, 0.5).unproject(camera);
        const dir = vector.sub(camera.position).normalize();
        const distance = (quad.position.z - camera.position.z) / dir.z;
        const newPos = camera.position.clone().add(dir.multiplyScalar(distance));
                
        quad.position.x = newPos.x;
        updateSatelliteCullPoint(quad.position.x);
    }
}

function onMouseDown(event) {
    if (!sliderParams.enableQuad) return;
    event.preventDefault();
    mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObject(quad);
    if (intersects.length > 0) {
        isDragging = true;
        controls.enabled = false;
        const intersect = intersects[0];
        dragOffset.copy(intersect.point).sub(quad.position);
    }
}

function onMouseUp(event) {
    if (!sliderParams.enableQuad) return;
    event.preventDefault();
    isDragging = false;
    controls.enabled = true;
}

window.addEventListener('mousemove', onMouseMove, false);
window.addEventListener('mousedown', onMouseDown, false);
window.addEventListener('mouseup', onMouseUp, false);


/*
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
*/

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
        //sunHelper.setDirection(getSunPointingAngle(deltaNow));
        getSunPointingAngle(deltaNow);

        /*
        // Update satellite positions
        for (let j = 0; j < satellites.length; j++) {
            updateSatellitePosition(
                satrecs[j],
                satellites[j],
                deltaNow
            );
        }
        */

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
