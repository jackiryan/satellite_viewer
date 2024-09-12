// Import necessary Three.js components
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

let camera, controls, scene, renderer, stats;
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
let previousClockValue = '';
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
    const satGeoPromise = new GLTFLoader().loadAsync('./teardrop.gltf', undefined);
    let satGeo = new THREE.IcosahedronGeometry(0.02);
    satGeoPromise.then( (gltf) => {
        satGeo = gltf.scene.children[0].geometry;
        groupMap = new SatelliteGroupMap(scene, satGeo);
    }).catch((error) => {
        console.error(`Failed to load satellite model: ${error}`);
        groupMap = new SatelliteGroupMap(scene, satGeo);
    });
   

    const imageLoader = new THREE.ImageBitmapLoader();
    imageLoader.setOptions({ imageOrientation: 'flipY' });
    /* Earth */
    // Create the Earth geometry and material using NASA Blue/Black Marble mosaics. These are from 2004 (Day) and 2012 (Night),
    // but were chosen so that snowy regions would approximately line up between day and night.
    const earthGeometry = new THREE.SphereGeometry(earthParameters.radius, 64, 64);
    const tempearth = new THREE.Mesh(earthGeometry, new THREE.MeshBasicMaterial({ color: 0x0e1118 }));
    scene.add(tempearth);
    fitCameraToObject(camera, tempearth, 10);

    

    window.mobileAndTabletCheck = function() {
        let check = false;
        (function(a){if(/(android|bb\d+|meego).+mobile|avantgo|bada\/|blackberry|blazer|compal|elaine|fennec|hiptop|iemobile|ip(hone|od)|iris|kindle|lge |maemo|midp|mmp|mobile.+firefox|netfront|opera m(ob|in)i|palm( os)?|phone|p(ixi|re)\/|plucker|pocket|psp|series(4|6)0|symbian|treo|up\.(browser|link)|vodafone|wap|windows ce|xda|xiino|android|ipad|playbook|silk/i.test(a)||/1207|6310|6590|3gso|4thp|50[1-6]i|770s|802s|a wa|abac|ac(er|oo|s\-)|ai(ko|rn)|al(av|ca|co)|amoi|an(ex|ny|yw)|aptu|ar(ch|go)|as(te|us)|attw|au(di|\-m|r |s )|avan|be(ck|ll|nq)|bi(lb|rd)|bl(ac|az)|br(e|v)w|bumb|bw\-(n|u)|c55\/|capi|ccwa|cdm\-|cell|chtm|cldc|cmd\-|co(mp|nd)|craw|da(it|ll|ng)|dbte|dc\-s|devi|dica|dmob|do(c|p)o|ds(12|\-d)|el(49|ai)|em(l2|ul)|er(ic|k0)|esl8|ez([4-7]0|os|wa|ze)|fetc|fly(\-|_)|g1 u|g560|gene|gf\-5|g\-mo|go(\.w|od)|gr(ad|un)|haie|hcit|hd\-(m|p|t)|hei\-|hi(pt|ta)|hp( i|ip)|hs\-c|ht(c(\-| |_|a|g|p|s|t)|tp)|hu(aw|tc)|i\-(20|go|ma)|i230|iac( |\-|\/)|ibro|idea|ig01|ikom|im1k|inno|ipaq|iris|ja(t|v)a|jbro|jemu|jigs|kddi|keji|kgt( |\/)|klon|kpt |kwc\-|kyo(c|k)|le(no|xi)|lg( g|\/(k|l|u)|50|54|\-[a-w])|libw|lynx|m1\-w|m3ga|m50\/|ma(te|ui|xo)|mc(01|21|ca)|m\-cr|me(rc|ri)|mi(o8|oa|ts)|mmef|mo(01|02|bi|de|do|t(\-| |o|v)|zz)|mt(50|p1|v )|mwbp|mywa|n10[0-2]|n20[2-3]|n30(0|2)|n50(0|2|5)|n7(0(0|1)|10)|ne((c|m)\-|on|tf|wf|wg|wt)|nok(6|i)|nzph|o2im|op(ti|wv)|oran|owg1|p800|pan(a|d|t)|pdxg|pg(13|\-([1-8]|c))|phil|pire|pl(ay|uc)|pn\-2|po(ck|rt|se)|prox|psio|pt\-g|qa\-a|qc(07|12|21|32|60|\-[2-7]|i\-)|qtek|r380|r600|raks|rim9|ro(ve|zo)|s55\/|sa(ge|ma|mm|ms|ny|va)|sc(01|h\-|oo|p\-)|sdk\/|se(c(\-|0|1)|47|mc|nd|ri)|sgh\-|shar|sie(\-|m)|sk\-0|sl(45|id)|sm(al|ar|b3|it|t5)|so(ft|ny)|sp(01|h\-|v\-|v )|sy(01|mb)|t2(18|50)|t6(00|10|18)|ta(gt|lk)|tcl\-|tdg\-|tel(i|m)|tim\-|t\-mo|to(pl|sh)|ts(70|m\-|m3|m5)|tx\-9|up(\.b|g1|si)|utst|v400|v750|veri|vi(rg|te)|vk(40|5[0-3]|\-v)|vm40|voda|vulc|vx(52|53|60|61|70|80|81|83|85|98)|w3c(\-| )|webc|whit|wi(g |nc|nw)|wmlb|wonu|x700|yas\-|your|zeto|zte\-/i.test(a.substr(0,4))) check = true;})(navigator.userAgent||navigator.vendor||window.opera);
        return check;
    };


    // Textures
    let earthImageUrls = [
        './BlueMarble_2048x1024.avif',
        './BlackMarble_2048x1024.avif',
        './EarthSpec_2048x1024.avif'
    ];
    if (!window.mobileAndTabletCheck()) {
        earthImageUrls = [
            './BlueMarble_8192x4096.avif',
            './BlackMarble_8192x4096.avif',
            './EarthSpec_2048x1024.avif'
        ];
    }
    
    
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
            scene.remove(tempearth);
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
    });
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
        // I saw pointermove in some threejs documentation
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
    let isLeft = false;
    if (spaceRight < tooltipWidth) {
        // display to the left of the cursor
        tooltip.style.left = `${x - tooltipWidth - 10}px`;
        tooltip.style.borderRadius = '3px 0px 3px 3px';
        isLeft = true;
    } else {
        // display to the right of the cursor (default)
        tooltip.style.left = `${x + 10}px`;
        tooltip.style.borderRadius = '0px 3px 3px 3px';
    }
    if (spaceBottom < tooltipHeight) {
        // display above the cursor, and use a different pointy corner
        // if also displaying to the left
        tooltip.style.top = `${y - tooltipHeight - 10}px`;
        if (isLeft) {
            tooltip.style.borderRadius = '3px 3px 0px 3px';
        } else {
            tooltip.style.borderRadius = '3px 3px 3px 0px';
        }
    } else {
        // display below the cursor (default)
        tooltip.style.top = `${y + 10}px`;
    }
    tooltip.innerHTML = text;
    tooltip.style.display = 'block';
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

    // zoom out a little so that objects don't fill the screen
    camera.position.z = cameraZ;

    const minZ = boundingBox.min.z;
    const cameraToFarEdge = (minZ < 0) ? -minZ + cameraZ : cameraZ - minZ;

    camera.far = cameraToFarEdge * 3;
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
    groupMap.update();
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
