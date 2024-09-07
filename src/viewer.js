// Import necessary Three.js components
import * as THREE from 'three';
import gstime from './gstime.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { populateButtonGroup } from './buttonGroup.js';
import { SatelliteGroupMap } from './satelliteGroupMap.js';
import { initSky } from './skybox.js';
import getSunPointingAngle from './sunangle.js';
import earthVertexShader from './shaders/earth/earthVertex.glsl';
import earthFragmentShader from './shaders/earth/earthFragment.glsl';
import atmosphereVertexShader from './shaders/atmosphere/atmosphereVertex.glsl';
import atmosphereFragmentShader from './shaders/atmosphere/atmosphereFragment.glsl';
import Stats from 'three/addons/libs/stats.module.js';

let camera, controls, gui, scene, renderer, stats;
let earth, earthMaterial, atmosphere, atmosphereMaterial, skybox, groupMap;
let raycaster, mouseMove, tooltip;
let sunHelper;

const earthParameters = {
    radius: 5,
    dayColor: '#d7eaf9',
    twilightColor: '#fd5e53'
};
// Determine the initial rotation of the Earth based on the current sidereal time
const now = new Date(); // Get current time
// Vernal Equinox 2024, the terminator will be along prime meridian
// Uncomment this line if using the debug plane to check solar vs sidereal time drift
// const now = new Date(Date.UTC(2024,2,24,3,6,0,0));

// Get the sidereal time, which describes the sidereal rotation
// (relative to fixed stars aka camera) of the Earth.
const gmst = gstime(now);

// mutable that is used for adjusting simulation speed
let elapsedTime = 0;
const renderClock = new THREE.Clock();

const mainElement = document.querySelector('main');
const clockElement = document.getElementById('clock-time');

/* Animation
 * Uses a renderFrameRate and speedFactor to control the "choppiness" and speed of the animation, respectively. */
// Factor to run the rotation faster than real time, 3600 ~= 1 rotation/minute
const renderParameters = {
    speedFactor: 1, // multiple of realtime
    animFrameRate: 60.0 // frames per second
};

await init().then( async () => {
    await initSky({ sceneObj: scene }).then((sky) => {
        skybox = sky;
    });
    await initSatellites();
    requestAnimationFrame(animate);
});

async function init() {
    /* Boilerplate */
    // The camera will be in a fixed intertial reference, so the Earth will rotate
    camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.z = -20;

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setClearColor(0x000000);
    renderer.toneMapping = THREE.LinearToneMapping;
    renderer.toneMappingExposure = 1.3;
    renderer.domElement.classList.add('webgl');
    
    mainElement.appendChild(renderer.domElement);

    scene = new THREE.Scene();

    // Add ambient light
    const ambientLight = new THREE.AmbientLight(0xcccccc, 1);
    scene.add(ambientLight);

    /* Controls */
    controls = new OrbitControls(camera, renderer.domElement);
    controls.minDistance = 7;
    controls.maxDistance = 150;
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.enablePan = false;
    controls.update();

    /* Other objects that are updated during animation callback */
    // Paint the clock immediately
    updateClock(now);

    addStats();
    // satellite data is stored in this data structure, position state is handled in a separate webworker
    groupMap = new SatelliteGroupMap(scene);

    const imageLoader = new THREE.ImageBitmapLoader();
    imageLoader.setOptions({ imageOrientation: 'flipY' });
    /* Earth */
    // Create the Earth geometry and material using NASA Blue/Black Marble mosaics. These are from 2004 (Day) and 2012 (Night),
    // but were chosen so that snowy regions would approximately line up between day and night.
    const earthGeometry = new THREE.SphereGeometry(earthParameters.radius, 64, 64);
    // Textures
    const earthImageUrls = [
        './BlueMarble_8192x4096.avif',
        './BlackMarble_8192x4096.avif',
        './EarthSpec_4096x2048.avif'
    ];
    // has to resolve or page load will essentially fail... shaders depend on it
    Promise.all(earthImageUrls.map( (url) => {
            return new Promise((resolve, reject) => {
                imageLoader.load(
                    url,
                    image => {
                        resolve(new THREE.CanvasTexture(image));
                    },
                    undefined,
                    error => {
                        reject(new Error(`Failed to load texture from ${url}: ${error.message}`));
                    }
                );
            });
        })).then((textures) => {
            for (let i = 0; i < textures.length - 1; i++) {
                textures[i].colorSpace = THREE.SRGBColorSpace;
                textures[i].anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
            }

            // Civil, Nautical, and Astronomical Twilight account for sun angles up to about 18 degrees past the horizon
            // I am only using the first two for this value since Astronomical Twilight is essentially night
            const twilightAngle = 12.0 * Math.PI / 180.0;

            // Shader material can only be created after all three textures have loaded
            earthMaterial = new THREE.ShaderMaterial({
                uniforms: {
                    dayTexture: new THREE.Uniform(textures[0]),
                    nightTexture: new THREE.Uniform(textures[1]),
                    specularMapTexture: new THREE.Uniform(textures[2]),
                    sunDirection: new THREE.Uniform(new THREE.Vector3(0, 0, 1)),
                    twilightAngle: new THREE.Uniform(twilightAngle),
                    dayColor: new THREE.Uniform(new THREE.Color(earthParameters.dayColor)),
                    twilightColor: new THREE.Uniform(new THREE.Color(earthParameters.twilightColor))
                },
                vertexShader: earthVertexShader,
                fragmentShader: earthFragmentShader
            });

            earth = new THREE.Mesh(earthGeometry, earthMaterial);
            scene.add(earth);
            earth.name = "earth";

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
                    twilightAngle: new THREE.Uniform(twilightAngle),
                },
                side: THREE.BackSide,
                transparent: true
            });
            atmosphere = new THREE.Mesh(atmosphereGeometry, atmosphereMaterial);
            scene.add(atmosphere);
            atmosphere.name = "atm";

            // Refer back to definition of gmst if you are confused
            earth.rotation.y = gmst;
            atmosphere.rotation.y = gmst;

            /* Debug plane for checking seasonal variation and other long-term issues */
            if (now === Date.UTC(2024,2,24,3,6,0,0)) {
                // If the start time is the 2024 vernal equinox (which is in the past),
                // this plane will align with the terminator at be on the prime meridian
                // on page load
                const planeGeometry = new THREE.BoxGeometry(0.1, 10, 10);
                const planeMaterial = new THREE.MeshBasicMaterial({ color: 0x0000ff });
                const plane = new THREE.Mesh(planeGeometry, planeMaterial);
                scene.add(plane);
                initSunPointingHelper();
            }
    });

    window.addEventListener('resize', onWindowResize, false);
}

async function initSatellites() {
    window.addEventListener('displayGroup', onGroupDisplayed, false);
    window.addEventListener('hideGroup', onGroupHidden, false);

    // Set the space stations (ISS & CSS) and the OneWeb constellation to show
    // on page load. Why OneWeb? Because it looks cool, I guess!
    const defaultGroups = new Set(["Space Stations", "OneWeb"]);
    await populateButtonGroup(defaultGroups).then( () => {
        initSettingsMenu();
        raycaster = new THREE.Raycaster();
        mouseMove = new THREE.Vector2();
        // Create an HTML element to display the name of a satellite on mouse hover
        tooltip = document.createElement('div');
        tooltip.className = 'tooltip';
        tooltip.style.zIndex = 1;
        mainElement.appendChild(tooltip);
        renderer.domElement.addEventListener('pointermove', onMouseMove, false);
    });
}

function addStats() {
    stats = new Stats();
    stats.domElement.style.position = 'absolute';
    stats.domElement.style.top = '3.5rem';
    mainElement.appendChild(stats.domElement);
}

function initSettingsMenu() {
    const settingsMenu = document.querySelector('.settings-menu');
    const toggleButton = document.querySelector('.menu-toggle');
    const menuToggle = document.getElementById('arrowicon-down');

    toggleButton.addEventListener('click', () => {
        settingsMenu.classList.toggle('hidden');
        menuToggle.classList.toggle('on');
    });

    const speedStates = new Map([
        [1, '1 sec/s'],
        [30, '30 sec/s'],
        [60, '1 min/s'],
        [300, '5 min/s'],
        [1800, '30 min/s'],
        [3600, '1 hr/s']
    ]);
    
    const plusButton = document.getElementById('plus');
    const minusButton = document.getElementById('minus');
    const speedIndicator = document.getElementById('speed-indicator');
    const realTimeButton = document.getElementById('real-time');
    const realTimeIndicator = document.getElementById('real-time-indicator');
    const projectedIndicator = document.getElementById('projected-indicator');

    const starsButton = document.getElementById('stars');
    const showAllButton = document.getElementById('show-all');

    function setRealTime(isRealTime) {
        if (isRealTime) {
            // elapsedTime is in seconds on the main thread due to renderClock,
            // so remember to divide by 1000 (ms -> s)
            elapsedTime = (Date.now() - now.getTime()) / 1000.0;
            groupMap.setRealTime();
            realTimeIndicator.classList.add('on');
            projectedIndicator.classList.remove('on');
            realTimeButton.classList.add('off');
            realTimeButton.disabled = true;
        } else {
            realTimeIndicator.classList.remove('on');
            projectedIndicator.classList.add('on');
            realTimeButton.classList.remove('off');
            realTimeButton.disabled = false;
        }
    }

    function updateSpeed(currentIndex) {
        groupMap.setSpeed(renderParameters.speedFactor);
        const speedText = speedStates.get(renderParameters.speedFactor);
        speedIndicator.innerHTML = speedText;

        if (currentIndex >= speedStates.size - 1) {
            plusButton.disabled = true;
            plusButton.classList.add('off');
        } else {
            plusButton.disabled = false;
            plusButton.classList.remove('off');
        }
        if (currentIndex <= 0) {
            minusButton.disabled = true;
            minusButton.classList.add('off');
        } else {
            minusButton.disabled = false;
            minusButton.classList.remove('off');
            setRealTime(false);
        }
    }


    plusButton.addEventListener('click', () => {
        const keys = Array.from(speedStates.keys());
        const currentIndex = keys.indexOf(renderParameters.speedFactor);
        if (currentIndex < keys.length - 1) {
            renderParameters.speedFactor = keys[currentIndex + 1];
            updateSpeed(currentIndex + 1);
        }
    });

    minusButton.addEventListener('click', () => {
        const keys = Array.from(speedStates.keys());
        const currentIndex = keys.indexOf(renderParameters.speedFactor);
        if (currentIndex > 0) {
            renderParameters.speedFactor = keys[currentIndex - 1];
            updateSpeed(currentIndex - 1);
        }
    });

    realTimeButton.addEventListener('click', () => {
        renderParameters.speedFactor = 1;
        updateSpeed(renderParameters.speedFactor - 1);
        setRealTime(true);
    });

    starsButton.addEventListener('click', () => {
        if (skybox !== undefined) {
            skybox.toggleStars();
            if (skybox.isStarry()) {
                starsButton.innerHTML = 'Hide Stars';
            } else {
                starsButton.innerHTML = 'Show Stars';
            }
        }
    });
    showAllButton.addEventListener('click', () => {
        console.log('not implemented');
    });

}

function initSunPointingHelper() {
    // Create the sun pointing helper, if needed
    const length = 7;
    const color = 0x00ffff;
    sunHelper = new THREE.ArrowHelper(
        getSunPointingAngle(now),
        new THREE.Vector3(0, 0, 0),
        length,
        color
    );
    scene.add(sunHelper);
}

/* Button group event handlers (Show/Hide Satellites) */
function onGroupDisplayed(event) {
    const groupUrl = event.detail;

    if (groupMap.hasGroup(groupUrl)) {
        // Will post a message to the dedicated webworker to start updating
        // transform matrices for the InstancedMesh associated with this group
        groupMap.displayGroup(groupUrl);
    } else {
        // Will post a message to the dedicated webworker to initialize the group,
        // and creates a new InstancedMesh.
        groupMap.onInitGroup(groupUrl);
    }
}

function onGroupHidden(event) {
    const groupUrl = event.detail;
    groupMap.hideGroup(groupUrl);
}

/* Other event handlers */
function onMouseMove(event) {
    event.preventDefault();
    // Update the mouse variable
    const rect = renderer.domElement.getBoundingClientRect();
    mouseMove.x = ((event.clientX - rect.left) / (rect.right - rect.left)) * 2 - 1;
    mouseMove.y = -((event.clientY - rect.top) / (rect.bottom - rect.top)) * 2 + 1;

    // Update the raycaster with the camera and mouse position
    raycaster.setFromCamera(mouseMove, camera);

    // Calculate objects intersecting the raycaster
    var intersects = raycaster.intersectObjects(scene.children, true);

    if (intersects.length > 0) {
        // Show tooltip with the name
        const intersectedObject = intersects[0].object;
        // only display tooltip for instancedMesh objects
        if (groupMap.hasGroup(intersectedObject.name)) {
            const groupName = intersectedObject.name;
            const satelliteName = groupMap.map.get(groupName).names[intersects[0].instanceId];
            updateTooltip(satelliteName, event.clientX, event.clientY);
        } else {
            tooltip.style.display = 'none';
        }
    } else {
        // Hide the tooltip
        tooltip.style.display = 'none';
    }
}

function updateTooltip(text, x, y) {
    const tooltipWidth = tooltip.offsetWidth;
    const tooltipHeight = tooltip.offsetHeight;
    const spaceRight = window.innerWidth - x - 10;
    const spaceBottom = window.innerHeight - y - 10;
    if (spaceRight < tooltipWidth) {
        tooltip.style.left = `${x - tooltipWidth - 10}px`;
    } else {
        tooltip.style.left = `${x + 10}px`;
    }
    if (spaceBottom < tooltipHeight) {
        tooltip.style.top = `${y - tooltipHeight - 10}px`;
    } else {
        tooltip.style.top = `${y + 10}px`;
    }
    tooltip.innerHTML = text;
    tooltip.style.display = 'block';
}

function onWindowResize() {
    const canvas = renderer.domElement;
    const pixelRatio = window.devicePixelRatio;
    const width = Math.floor(canvas.clientWidth * pixelRatio);
    const height = Math.floor(canvas.clientHeight * pixelRatio);
    const needsResize = canvas.width !== width || canvas.height !== height;
    //console.log(`${canvas.width}, ${width}, ${canvas.height}, ${height}`);
    if (needsResize) {
        console.log('Setting new size!');
        console.log(`${canvas.width}, ${width}, ${canvas.height}, ${height}`);
        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
    }
}

function animate() {
    const delta = renderParameters.speedFactor * renderClock.getDelta();
    elapsedTime += delta;
    const deltaNow = new Date(now.getTime() + elapsedTime * 1000);
    const sunDirection = getSunPointingAngle(deltaNow);

    onWindowResize();

    if (earth !== undefined) {
        earth.rotation.y = gstime(deltaNow);
        // Uncomment this line if using the sun pointing helper for debugging
        // sunHelper.setDirection(getSunPointingAngle(deltaNow));
        earthMaterial.uniforms.sunDirection.value.copy(sunDirection);
        atmosphereMaterial.uniforms.sunDirection.value.copy(sunDirection);
    }
    if (skybox !== undefined) {
        if (skybox.isStarry()) {
            skybox.material.uniforms.uSunDirection.value.copy(sunDirection);
        }
    }

    updateClock(deltaNow);
    groupMap.update();
    controls.update();
    stats.update();

    renderer.render(scene, camera);
    requestAnimationFrame(animate);
}

function updateClock(deltaNow) {
    const utcDate = deltaNow.toUTCString().split(' ').slice(1, 4).join(' ');
    const utcTime = deltaNow.toISOString().split('T')[1].split('.')[0];
    clockElement.innerHTML = `${utcDate} ${utcTime} Z`;
}
