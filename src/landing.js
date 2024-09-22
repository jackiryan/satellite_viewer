/* landing.js - main JavaScript source for the index.html of my personal website */
import * as THREE from 'three';
import gstime from './gstime.js';
import { initSky } from './skybox.js';
import getSunPointingAngle from './sunangle.js';
import earthVertexShader from './shaders/earth/earthVertex.glsl';
import earthFragmentShader from './shaders/earth/earthFragment.glsl';
import atmosphereVertexShader from './shaders/atmosphere/atmosphereVertex.glsl';
import atmosphereFragmentShader from './shaders/atmosphere/atmosphereFragment.glsl';

let camera, scene, renderer;
let earth, earthMaterial, atmosphere, atmosphereMaterial, skybox;

// Determine the initial rotation of the Earth based on the current sidereal time
const now = new Date();

// Get the sidereal time, which describes the sidereal rotation (relative to fixed
// stars aka camera) of the Earth.
const gmst = gstime(now);

const earthParameters = {
    radius: 5,
    dayColor: '#d7eaf9',
    twilightColor: '#fd5e53'
};

/* Animation
 * Uses a renderFrameRate and speedFactor to control the "choppiness" and speed of
 * the animation, respectively. */
// Factor to run the rotation faster than real time, 3600 ~= 1 rotation/minute
const renderParameters = {
    speedFactor: 60, // multiple of realtime
    animFrameRate: 60.0 // frames per second
};

// mutable that is used for adjusting simulation speed
let elapsedTime = 0;
const renderClock = new THREE.Clock();
const sceneBoundingBox = new THREE.Box3(
    new THREE.Vector3(-0.5 * earthParameters.radius, -10, -5),
    new THREE.Vector3(100 + 0.5 * earthParameters.radius, 10, 5)
);

await init().then( async () => {
    await initSky({ sceneObj: scene }).then((sky) => {
        skybox = sky;
    });
    requestAnimationFrame(animate);
});

async function init() {
    /* Boilerplate */
    camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.x = -25;
    fitCameraToBbox(camera, sceneBoundingBox, 1.8 / camera.aspect);
    camera.rotation.y = -Math.PI;
    
    const canvas = document.querySelector('#webgl-canvas');
    renderer = new THREE.WebGLRenderer({ antialias: true, canvas });
    renderer.setClearColor(0x000000);
    renderer.toneMapping = THREE.LinearToneMapping;
    renderer.toneMappingExposure = 1.3;

    scene = new THREE.Scene();

    // Add ambient light
    const ambientLight = new THREE.AmbientLight(0xcccccc, 1);
    scene.add(ambientLight);

    const imageLoader = new THREE.ImageBitmapLoader();
    imageLoader.setOptions({ imageOrientation: 'flipY' });
    /* Earth */
    // Create the Earth geometry and material using NASA Blue/Black Marble mosaics. These are from 2004 (Day) and 2012 (Night),
    // but were chosen so that snowy regions would approximately line up between day and night.
    const earthGeometry = new THREE.SphereGeometry(earthParameters.radius, 64, 64);
    const tempearth = new THREE.Mesh(earthGeometry, new THREE.MeshBasicMaterial({ color: 0x0e1118 }));
    scene.add(tempearth);

    // Textures - these are probably oversized for the context, but can be optimized later if needed
    const earthImageUrls = [
        './BlueMarble_2048x1024.avif',
        './BlackMarble_2048x1024.avif',
        './EarthSpec_2048x1024.avif'
    ];
    // the textured globe will fail to load if the imageLoader fails to resolve
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

            // Refer back to definition of gmst if you are confused
            earth.rotation.y = gmst;
            atmosphere.rotation.y = gmst;
    });
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
        // setting the offset argument to 1.8 / camera.aspect causes relative positioning
        // to stay constant
        fitCameraToBbox(camera, sceneBoundingBox, 1.8 / camera.aspect);
    }
}

function fitCameraToBbox(camera, bbox, offset) {
    /* 
    * This is a modified version of the code from this forum thread:
    * https://discourse.threejs.org/t/camera-zoom-to-fit-object/936
    * Here we are using 1 / camera.aspect as the offset factor to cause
    * the relative positioning of objects in the scene to appear the
    * same regardless of window size.
    */
    offset = offset || 1.25;

    const dummy = new THREE.Vector3();
    const size = bbox.getSize(dummy);

    // get the max side of the bounding box (fits to width OR height as needed )
    const maxDim = Math.max(size.x, size.y, size.z);
    let cameraZ = Math.abs(maxDim / 4 * Math.tan(camera.fov * 2));
    cameraZ *= offset;

    // importantly, we only adjust the camera Z position here, we don't want to do camera.lookAt(earth)
    // because the camera is *supposed* to keep the Earth on the left side of the page.
    camera.position.z = -cameraZ;

    const minZ = bbox.min.z;
    const cameraToFarEdge = (minZ < 0) ? -minZ + cameraZ : cameraZ - minZ;

    // Setting camera.far is probably unimportant in this context, but it doesn't hurt
    camera.far = cameraToFarEdge;
    camera.updateProjectionMatrix();
}

function animate() {
    // the speedFactor should be enough that the earth will move while the user is on the page,
    // but not so much that it will be obvious at a glance. It's a tricky little detail for
    // people who are paying attention :)
    const delta = renderParameters.speedFactor * renderClock.getDelta();
    elapsedTime += delta;
    const deltaNow = new Date(now.getTime() + elapsedTime * 1000);
    const sunDirection = getSunPointingAngle(deltaNow);

    onWindowResize();

    if (earth !== undefined) {
        earth.rotation.y = gstime(deltaNow);
        earthMaterial.uniforms.sunDirection.value.copy(sunDirection);
        atmosphereMaterial.uniforms.sunDirection.value.copy(sunDirection);
    }
    if (skybox !== undefined) {
        if (skybox.isStarry()) {
            skybox.material.uniforms.uSunDirection.value.copy(sunDirection);
        }
    }

    renderer.render(scene, camera);
    requestAnimationFrame(animate);
}