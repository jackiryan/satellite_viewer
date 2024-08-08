// Import necessary Three.js components
import * as THREE from 'three';
import * as satellite from 'satellite.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TrailRenderer } from './trails.js';
import GUI from 'lil-gui';
import earthVertexShader from './shaders/earth/earthVertex.glsl';
import earthFragmentShader from './shaders/earth/earthFragment.glsl';
import atmosphereVertexShader from './shaders/atmosphere/atmosphereVertex.glsl'
import atmosphereFragmentShader from './shaders/atmosphere/atmosphereFragment.glsl'

var gui, camera, scene, renderer, controls;
var earth, earthMaterial, atmosphere, atmosphereMaterial;

var raycaster, mouseMove, tooltip;

const earthParameters = {
    radius: 5,
    dayColor: '#d7eaf9',
    twilightColor: '#fd5e53'
};
const scaleFactor = earthParameters.radius / 6378;
// Determine the initial rotation of the Earth based on the current sidereal time
const now = new Date(); // Get current time
// Use satelliteJS to get the sidereal time, which describes the sidereal rotation (relative to fixed stars aka camera) of the Earth.
const gmst = satellite.gstime(now);

/* Animation
 * Uses a renderFrameRate and speedFactor to control the "choppiness" and speed of the animation, respectively. */
// Factor to run the rotation faster than real time, 3600 ~= 1 rotation/minute
const renderParameters = {
    speedFactor: 1, // multiple of realtime
    animFrameRate: 30.0 // frames per second
};
// Vars that are used for rendering at a fixed framerate while
// being able to adjust the simulation speed
var elapsedSecond = 0;
var elapsedTime = 0;

async function init() {
    /* Boilerplate */
    gui = new GUI();
    scene = new THREE.Scene();

    // The camera will be in a fixed intertial reference, so the Earth will rotate
    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.z = -10;

    renderer = new THREE.WebGLRenderer({
        antialias: true
    });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor('#000011');
    document.body.appendChild(renderer.domElement);

    // Add ambient light
    const ambientLight = new THREE.AmbientLight(0xcccccc, 0.5);
    scene.add(ambientLight);

    // Add controls
    controls = new OrbitControls(camera, renderer.domElement);
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
    
        getSunPointingAngle(now);
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



    raycaster = new THREE.Raycaster();
    mouseMove = new THREE.Vector2();

    // Create an HTML element to display the name
    tooltip = document.createElement('div');
    tooltip.style.position = 'absolute';
    tooltip.style.backgroundColor = 'rgba(255, 255, 255, 0.7)';
    tooltip.style.padding = '5px';
    tooltip.style.borderRadius = '3px';
    tooltip.style.display = 'none';
    document.body.appendChild(tooltip);


    window.addEventListener('resize', onWindowResize, false);
    renderer.domElement.addEventListener('mousemove', onMouseMove, false);
}

// satellite arrays
var satrecs = [];
var satellites = [];

async function initSatellites() {
    /* Satellites */
    const colors = [
        { color: 0xff0000 },
        { color: 0x00ff00 },
        { color: 0x0000ff }
    ];

    try {
        // Read the science TLE file
        const response = await fetch('./active_satellites.txt');
        if (!response.ok) {
            throw new Error('Network response was not ok ' + response.statusText);
        }
        const data = await response.text();

        // Split the file content by line breaks to get an array of strings
        const tleLines = data.split('\n');

        // Create satellites one at a time, eventually this should be BufferGeometry
        for (let i = 0; i < tleLines.length; i += 3) {
            if (tleLines[i].includes("DEB") || tleLines[i].includes("R/B") || tleLines[i] == "") {
                continue;
            }
            let satreci = satellite.twoline2satrec(
                tleLines[i+1],
                tleLines[i+2]
            );
            satrecs.push(satreci);
            let sat = addSatellite(satreci, colors[(i / 3) % 3], tleLines[i]);
            satellites.push(sat);
            scene.add(satellites.at(-1));
        }
        // let trail = addTrail(satellites[0]);
    } catch (error) {
        console.error('There was a problem with the fetch operation:', error);
    }
}

function initGuiTweaks() {
    // gui debug controls
    gui
        .add(renderParameters, 'speedFactor')
        .min(1)
        .max(3600);

    gui
        .add(renderParameters, 'animFrameRate')
        .min(10)
        .max(60);
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

function addSatellite(satrec, color, name) {
    const positionAndVelocity = satellite.propagate(satrec, now);
    // This app uses ECI coordinates, so there is no need to convert to Geodetic
    const positionEci = positionAndVelocity.position;
    // Create Satellite Mesh and copy in an initial position
    const satGeometry = new THREE.IcosahedronGeometry(0.02);
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

function addTrail(sat) {
    let trail = new TrailRenderer(scene, false);
    trail.setAdvanceFrequency(30);
    const trailMaterial = TrailRenderer.createBaseMaterial();
    trailMaterial.uniforms.headColor.value.set(1.0, 0.0, 0.0, 1.0);
    trailMaterial.uniforms.tailColor.value.set(1.0, 0.0, 0.0, 0.0);
    const trailLength = 100.0;
    
    const trailHeadGeometry = [
        new THREE.Vector3(-0.05, 0.0, 0.0),
        new THREE.Vector3(0.0, 0.05, 0.0),
        new THREE.Vector3(0.05, 0.0, 0.0),
        new THREE.Vector3(-0.05, 0.0, 0.0)
    ];

    trail.initialize(trailMaterial, trailLength, false, 0, trailHeadGeometry, sat);
    trail.activate();

    return trail;
}

// Modifies the position of a given satellite mesh sat with the propagated SPG4
// position at time t, as a side effect. No retval.
function updateSatellitePosition(satrec, sat, t) {
    const deltaPosVel = satellite.propagate(satrec, t);
    try {
        const deltaPosEci = deltaPosVel.position;
        const deltaPos = new THREE.Vector3(
            deltaPosEci.x * scaleFactor,
            deltaPosEci.z * scaleFactor,
            -deltaPosEci.y * scaleFactor
        );
        sat.position.copy(deltaPos);
    } catch(error) {
        console.log("Satellite", sat.name, " position unknown!");
        const recNdx = satrecs.indexOf(satrec);
        satrecs.splice(recNdx, 1);
        satellites.splice(recNdx, 1);
        var deorbitedSatellite = scene.getObjectByName(sat.name);
        scene.remove(deorbitedSatellite);
    }
}

function onMouseMove(event) {
    event.preventDefault();
    // Update the mouse variable
    mouseMove.x = (event.clientX / window.innerWidth) * 2 - 1;
    mouseMove.y = -(event.clientY / window.innerHeight) * 2 + 1;

    // Update the raycaster with the camera and mouse position
    raycaster.setFromCamera(mouseMove, camera);

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

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    //renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
}

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

        // Update satellite positions
        for (let j = 0; j < satellites.length; j++) {
            updateSatellitePosition(
                satrecs[j],
                satellites[j],
                deltaNow
            );
        }

        //trail.update();

        // reset the render clock
        elapsedSecond = 0;
    }
    
    controls.update();

    renderer.render(scene, camera);
    requestAnimationFrame(animate);
}

await init();
await initSatellites();
// Start the animation loop
const clock = new THREE.Clock();
animate();

