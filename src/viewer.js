/* viewer.js - main source for Satellite Demo */
import * as THREE from 'three';
import gstime from './gstime.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { populateButtonGroup, setButtonState } from './buttonGroup.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { SatelliteGroupMap } from './satelliteGroupMap.js';
import { initSky } from './skybox.js';
import getSunPointingAngle from './sunangle.js';
import earthVertexShader from './shaders/earth/earthVertex.glsl';
import earthFragmentShader from './shaders/earth/earthFragment.glsl';
import atmosphereVertexShader from './shaders/atmosphere/atmosphereVertex.glsl';
import atmosphereFragmentShader from './shaders/atmosphere/atmosphereFragment.glsl';
import Stats from 'three/addons/libs/stats.module.js';
import { HoverIntentHandler } from './hoverIntentHandler.js';

let camera, controls, scene, renderer, stats;
let earth, earthMaterial, atmosphere, atmosphereMaterial, skybox, groupMap;
let raycaster, mouseMove, mouseClick, tooltip;
let sunHelper; // unused except when debugging

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
let previousClockValue = '';
const clockElement = document.getElementById('clock-time');

/* Animation
 * Uses a renderFrameRate and speedFactor to control the "choppiness" and speed of the animation, respectively. */
// Factor to run the rotation faster than real time, 3600 ~= 1 rotation/minute
const renderParameters = {
    speedFactor: 1, // multiple of realtime
    animFrameRate: 60.0 // frames per second, deprecated
};

const interactiveLayer = 1;

// Taken from this very popular stackoverflow thread: https://stackoverflow.com/questions/11381673/detecting-a-mobile-browser
// no I do not intend to support iemobile or blackberry, but it doesn't hurt anything to have them in there.
window.mobileAndSafariCheck = function () {
    // Detect Safari
    const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

    // Detect mobile devices (including tablets)
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

    return isSafari || isMobile;
};

await init().then(async () => {
    await initSky({ sceneObj: scene }).then((sky) => {
        skybox = sky;
    });

    requestAnimationFrame(animate);
});

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Enhanced texture loading function with retry capability
async function loadTexture(url, options = {}, retryCount = 3, retryDelay = 100) {
    const attemptLoad = async (remainingAttempts) => {
        try {
            if (!window.mobileAndSafariCheck() && 'createImageBitmap' in window) {
                // Try ImageBitmapLoader first
                return await loadWithImageBitmap(url, options);
            } else {
                // Use TextureLoader for Safari and mobile devices
                return await loadWithTextureLoader(url);
            }
        } catch (error) {
            if (remainingAttempts > 0) {
                console.warn(`Attempt failed for ${url}, retrying in ${retryDelay}ms. Attempts remaining: ${remainingAttempts}`);
                await delay(retryDelay);
                return attemptLoad(remainingAttempts - 1);
            }
            throw error;
        }
    };

    return attemptLoad(retryCount);
}


// Helper function for ImageBitmapLoader logic
function loadWithImageBitmap(url, options = {}) {
    return new Promise((resolve, reject) => {
        const imageLoader = new THREE.ImageBitmapLoader();
        imageLoader.setCrossOrigin('anonymous');
        imageLoader.setOptions({ imageOrientation: 'flipY', ...options });

        imageLoader.load(
            url,
            imageBitmap => {
                const texture = new THREE.CanvasTexture(imageBitmap);
                resolve(texture);
            },
            undefined,
            error => {
                reject(new Error(`Failed to load texture from ${url}: ${error.message}`));
            }
        );
    });
}

// Helper function for TextureLoader logic
function loadWithTextureLoader(url) {
    return new Promise((resolve, reject) => {
        const textureLoader = new THREE.TextureLoader();
        textureLoader.setCrossOrigin('anonymous');

        textureLoader.load(
            url,
            texture => {
                resolve(texture);
            },
            undefined,
            error => {
                reject(new Error(`Failed to load texture from ${url}: ${error.message}`));
            }
        );
    });
}

function getTextureUrls() {
    const isMobileOrSafari = window.mobileAndSafariCheck();

    // Textures - Use a low resolution version on mobile devices, also Safari because it chokes on
    // preloading images as bitmaps. Other than the obvious benefit of improving performance, it 
    // can sometimes happen that the creation of a webgl context fails on lower-end mobile devices
    // when decompressing 8k textures. 
    if (isMobileOrSafari) {
        return [
            './BlueMarble_2048x1024.avif',
            './BlackMarble_2048x1024.avif',
            './EarthSpec_2048x1024.avif'
        ];
    }

    // Use high resolution for desktop browsers with good support
    return [
        './BlueMarble_8192x4096.avif',
        './BlackMarble_8192x4096.avif',
        './EarthSpec_2048x1024.avif'
    ];
}

async function loadFullCloudMap(date) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    
    // For zoom level 2, we need a 4x4 grid of tiles
    canvas.width = 512 * 4;  // Assuming tiles are 512x512
    canvas.height = 512 * 4;
    
    const formattedDate = date.toISOString().split('.')[0] + 'Z';
    
    // Load all tiles for zoom level 1
    for (let row = 0; row < 4; row++) {
        for (let col = 0; col < 4; col++) {
            const url = `http://localhost:3000/clouds?time=2025-03-05T00:00:00Z&tileMatrix=3&tileCol=${col}&tileRow=${row}`;
        
            await new Promise((resolve) => {
                const img = new Image();
                img.crossOrigin = "Anonymous";
                img.onload = () => {
                    ctx.drawImage(img, col * 512, row * 512);
                    resolve();
                };
                img.onerror = () => {
                    console.error(`Failed to load tile at ${row},${col}`);
                    resolve(); // Continue even if one tile fails
                };
                img.src = url;
            });
        }
    }
    
    // Create a texture from the canvas
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    
    return texture;
}

async function init() {
    /* Boilerplate */
    // The camera will be in a fixed intertial reference, so the Earth will rotate
    camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 1, 1000);

    const canvas = document.querySelector('#webgl-canvas');
    renderer = new THREE.WebGLRenderer({ antialias: true, canvas });
    renderer.setClearColor(0x000000);
    renderer.toneMapping = THREE.LinearToneMapping;
    renderer.toneMappingExposure = 1.3;

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
    const modelName = './shootingstar3.gltf';
    const satGeoPromise = new GLTFLoader().loadAsync(modelName, undefined);
    let satGeo = new THREE.IcosahedronGeometry(1);
    //groupMap = new SatelliteGroupMap(scene, satGeo);
    satGeoPromise.then(async (gltf) => {
        const model = gltf.scene;
        model.traverse((node) => {
            if (node.name === "ShootingStar") {
                satGeo = node.geometry;
            }
        });

        groupMap = new SatelliteGroupMap(scene, satGeo, interactiveLayer);
        await initSatellites();
    }).catch((error) => {
        console.error(`Failed to load satellite model: ${error}`);
        groupMap = new SatelliteGroupMap(scene, satGeo, interactiveLayer);
    });

    const imageLoader = new THREE.ImageBitmapLoader();
    imageLoader.setCrossOrigin('anonymous'); // required due to the COEP
    imageLoader.setOptions({ imageOrientation: 'flipY' });
    /* Earth */
    // Create the Earth geometry and material using NASA Blue/Black Marble mosaics. These are from 2004 (Day) and 2012 (Night),
    // but were chosen so that snowy regions would approximately line up between day and night.
    const earthGeometry = new THREE.SphereGeometry(earthParameters.radius, 64, 64);
    const tempearth = new THREE.Mesh(earthGeometry, new THREE.MeshBasicMaterial({ color: 0x0e1118 }));
    scene.add(tempearth);
    fitCameraToObject(camera, tempearth, 5);

    const earthImageUrls = getTextureUrls();
    const texturePromises = earthImageUrls.map(url =>
        loadTexture(url, {}, 3, 100)
    );
    texturePromises.push(loadFullCloudMap(now));

    // has to resolve or page load will essentially fail... shaders depend on it
    // For this reason, texture loading retries thrice with 100 ms intervals before giving up.
    Promise.all(texturePromises).then((textures) => {
        for (let i = 0; i < textures.length - 1; i++) {
            textures[i].colorSpace = THREE.SRGBColorSpace;
            textures[i].anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
        }
        const [blueMarble, blackMarble, earthSpec] = textures;

        // Civil, Nautical, and Astronomical Twilight account for sun angles up to about 18 degrees past the horizon
        // I am only using the first two for this value since Astronomical Twilight is essentially night
        const twilightAngle = 12.0 * Math.PI / 180.0;

        const cloudTexture = textures[textures.length - 1];

        // Shader material can only be created after all three textures have loaded
        earthMaterial = new THREE.ShaderMaterial({
            uniforms: {
                dayTexture: new THREE.Uniform(blueMarble),
                nightTexture: new THREE.Uniform(blackMarble),
                specularMapTexture: new THREE.Uniform(earthSpec),
                cloudTexture: new THREE.Uniform(cloudTexture),
                sunDirection: new THREE.Uniform(new THREE.Vector3(0, 0, 1)),
                twilightAngle: new THREE.Uniform(twilightAngle),
                dayColor: new THREE.Uniform(new THREE.Color(earthParameters.dayColor)),
                twilightColor: new THREE.Uniform(new THREE.Color(earthParameters.twilightColor))
            },
            vertexShader: earthVertexShader,
            fragmentShader: earthFragmentShader
        });

        earth = new THREE.Mesh(earthGeometry, earthMaterial);
        scene.remove(tempearth);
        scene.add(earth);
        earth.name = 'earth';
        // enable raycaster collisions with this object to prevent selecting satellites on the
        // backside of the earth
        earth.layers.enable(interactiveLayer);

        // Atmosphere  -- don't load this until the Earth has been added or it will look weird
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
        atmosphere.name = 'atm';

        // Refer back to definition of gmst if you are confused
        earth.rotation.y = gmst;
        atmosphere.rotation.y = gmst;

        // Debug plane for checking seasonal variation and other long-term issues
        if (now === Date.UTC(2024, 2, 24, 3, 6, 0, 0)) {
            // If the start time is the 2024 vernal equinox (which is in the past),
            // this plane will align with the terminator at be on the prime meridian
            // on page load
            const planeGeometry = new THREE.BoxGeometry(0.1, 10, 10);
            const planeMaterial = new THREE.MeshBasicMaterial({ color: 0x0000ff });
            const plane = new THREE.Mesh(planeGeometry, planeMaterial);
            scene.add(plane);
            initSunPointingHelper();
        }
    })
        .catch(error => {
            console.error('Failed to load textures:', error);
        });
}

async function initSatellites() {
    window.addEventListener('displayGroup', onGroupDisplayed, false);
    window.addEventListener('hideGroup', onGroupHidden, false);

    // Set the space stations (ISS & CSS) and the OneWeb constellation to show
    // on page load. Why OneWeb? Because it looks cool, I guess!
    const defaultGroups = new Set(["Space Stations", "OneWeb"]);
    await populateButtonGroup(defaultGroups).then(() => {
        initSettingsMenu();

        // the mouse hover behavior doesn't work well on mobile, but is ok on tablets,
        // at least when a touchpad peripheral is used, so I will leave this behavior in
        // unconditionally
        const hoverHandler = new HoverIntentHandler(renderer, scene, camera, groupMap);
    });
}

function addStats() {
    stats = new Stats();
    stats.domElement.style.position = 'absolute';
    stats.domElement.style.top = '3.5rem';
    mainElement.appendChild(stats.domElement);
}

function initSettingsMenu() {
    /*
    * This rather large and messy function to set up the UI menu should
    * probably be broken up and moved to a separate source file, but it works,
    * so no need to over-complicate things.
    */
    const settingsMenu = document.querySelector('.settings-menu');
    const toggleButton = document.querySelector('.menu-toggle');
    const menuToggle = document.getElementById('arrowicon-down');

    toggleButton.addEventListener('click', () => {
        settingsMenu.classList.toggle('hidden');
        menuToggle.classList.toggle('on');
    });

    const speedStates = new Map([
        [1, '1 sec/s'],
        [10, '10 sec/s'],
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
    const hideAllButton = document.getElementById('hide-all');

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

    showAllButton.addEventListener('click', async () => {
        await groupMap.toggleAllGroups(true);
        // this is the simplest way I could think of to do this, without creating
        // a spaghetti of state-transferring events
        const groupButtons = document.querySelector('.button-flex').children;
        for (const button of groupButtons) {
            setButtonState(button, true);
        }
    });

    hideAllButton.addEventListener('click', async () => {
        await groupMap.toggleAllGroups(false);
        const groupButtons = document.querySelector('.button-flex').children;
        for (const button of groupButtons) {
            setButtonState(button, false);
        }
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

function fitCameraToObject(camera, object, offset) {

    offset = offset || 1.25;

    const boundingBox = new THREE.Box3();

    // get bounding box of object - this will be used to setup controls and camera
    boundingBox.setFromObject(object);

    const dummy = new THREE.Vector3();
    const size = boundingBox.getSize(dummy);

    // get the max side of the bounding box (fits to width OR height as needed )
    const maxDim = Math.max(size.x, size.y, size.z);
    let cameraZ = Math.abs(maxDim / 4 * Math.tan(camera.fov * 2));
    cameraZ *= offset;


    camera.position.z = cameraZ;

    // DO NOT set camera.far in this context! The draw distance should stay fixed. Compare to the
    // version of this function in landing.js
    camera.updateProjectionMatrix();
}

function onWindowResize() {
    const canvas = renderer.domElement;
    const pixelRatio = window.devicePixelRatio;
    const width = Math.floor(canvas.clientWidth * pixelRatio);
    const height = Math.floor(canvas.clientHeight * pixelRatio);
    const needsResize = canvas.width !== width || canvas.height !== height;
    if (needsResize) {
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
    if (groupMap !== undefined) {
        groupMap.update();
    }
    controls.update();
    stats.update();

    renderer.render(scene, camera);
    requestAnimationFrame(animate);
}

function updateClock(deltaNow) {
    const utcDate = deltaNow.toUTCString().split(' ').slice(1, 4).join(' ');
    const utcTime = deltaNow.toISOString().split('T')[1].split('.')[0];
    const newClockValue = `${utcDate} ${utcTime} Z`;

    if (newClockValue !== previousClockValue) {
        clockElement.textContent = newClockValue;
        previousClockValue = newClockValue;
    }
}
