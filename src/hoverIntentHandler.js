import * as THREE from 'three';

// Radius of a satellite's drawn "head" in model units: 0.85 for the ShootingStar model
// (shootingstar3.gltf), 1 for the icosahedron used for debris and as a fallback.
const SATELLITE_HEAD_RADIUS = 1;

// Used if the scene has no mesh named 'earth' (see earth.js)
const DEFAULT_EARTH_RADIUS = 5;

// Calls fn once calls have stopped for `wait` ms, with the latest arguments (the trailing-edge
// behaviour of lodash's debounce, which was the only part of lodash the viewer used)
function debounce(fn, wait) {
    let timer = null;
    const debounced = (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            fn(...args);
        }, wait);
    };
    debounced.cancel = () => {
        clearTimeout(timer);
        timer = null;
    };
    return debounced;
}

export class HoverIntentHandler {
    constructor(renderer, scene, camera, groupMap, options = {}) {
        this.scene = scene;
        this.camera = camera;
        this.renderer = renderer;
        this.groupMap = groupMap;

        // Default settings
        this.settings = {
            interval: 50,           // Time in ms to check mouse position
            pickRadius: 10,         // A satellite this many CSS pixels from the cursor is picked
            ...options
        };

        // State tracking
        this.mouse = new THREE.Vector2();
        this.intentTimer = null;
        this.mousePos = { x: 0, y: 0 };

        // Scratch objects reused by pick()
        this.viewProjection = new THREE.Matrix4();
        this.cameraPosition = new THREE.Vector3();

        this.tooltip = document.createElement('div');
        this.tooltip.className = 'tooltip';
        this.tooltip.style.zIndex = 1;
        document.querySelector('main').appendChild(this.tooltip);

        // Bind methods
        this.onMouseMove = this.onMouseMove.bind(this);
        this.onMouseClick = this.onMouseClick.bind(this);
        this.checkIntent = this.checkIntent.bind(this);

        // Create debounced version of hover check
        this.debouncedHoverCheck = debounce(this.checkIntent, this.settings.interval);

        // start listening for events
        this.renderer.domElement.addEventListener('mousemove', async (e) => {
            await this.onMouseMove(e);
        });
        this.renderer.domElement.addEventListener('click', this.onMouseClick);
    }

    async onMouseMove(event) {
        event.preventDefault();
        const rect = this.renderer.domElement.getBoundingClientRect();
        this.mouse.x = ((event.clientX - rect.left) / (rect.right - rect.left)) * 2 - 1;
        this.mouse.y = -((event.clientY - rect.top) / (rect.bottom - rect.top)) * 2 + 1;
        this.mousePos = {
            x: event.clientX,
            y: event.clientY
        };

        this.debouncedHoverCheck();
    }

    onMouseClick(event) {
        event.preventDefault();
        const rect = this.renderer.domElement.getBoundingClientRect();
        this.mouse.x = ((event.clientX - rect.left) / (rect.right - rect.left)) * 2 - 1;
        this.mouse.y = -((event.clientY - rect.top) / (rect.bottom - rect.top)) * 2 + 1;

        const picked = this.pick();
        if (picked !== null) {
            this.groupMap.toggleOrbit(picked.groupName, picked.satId);
        }
    }

    /* Find the satellite under the mouse: the one whose center is nearest the cursor on
     * screen, within settings.pickRadius pixels or within its drawn head, whichever is larger.
     * Satellites behind the Earth or the camera are skipped.
     *
     * This replaces raycasting against the satellite meshes. A satellite's head is only a few
     * pixels across at normal zoom, so an exact ray-triangle hit needed pixel-perfect aim, and
     * the ray test also depended on each InstancedMesh's bounding sphere, which three.js does
     * not update as the worker moves the satellites.
     *
     * Returns { groupName, satId } or null.
     */
    pick() {
        const camera = this.camera;
        const rect = this.renderer.domElement.getBoundingClientRect();
        const width = rect.width;
        const height = rect.height;
        // cursor in pixels from the canvas's top left corner
        const mouseX = (this.mouse.x + 1) / 2 * width;
        const mouseY = (1 - this.mouse.y) / 2 * height;

        camera.updateMatrixWorld();
        const m = this.viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).elements;
        const cam = camera.getWorldPosition(this.cameraPosition);
        // pixels per scene unit at one unit in front of the camera
        const focalPixels = height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / camera.zoom);

        const earth = this.scene.getObjectByName('earth');
        const earthRadius = earth?.geometry?.parameters?.radius ?? DEFAULT_EARTH_RADIUS;
        const camDistSq = cam.lengthSq();

        let best = null;
        let bestDistSq = Infinity;
        for (const [groupName, group] of this.groupMap.map) {
            if (!group.displayed) continue;
            const a = group.mesh.instanceMatrix.array;
            for (let i = 0; i < group.mesh.count; i++) {
                const o = i * 16;
                const x = a[o + 12], y = a[o + 13], z = a[o + 14];
                // the worker zeroes the matrix of a satellite with no valid position
                if (x === 0 && y === 0 && z === 0) continue;

                // project to the screen; w is the distance in front of the camera
                const w = m[3] * x + m[7] * y + m[11] * z + m[15];
                if (w <= 0) continue;
                const sx = ((m[0] * x + m[4] * y + m[8] * z + m[12]) / w + 1) / 2 * width;
                const sy = (1 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / w) / 2 * height;
                const dx = sx - mouseX, dy = sy - mouseY;
                const distSq = dx * dx + dy * dy;
                if (distSq >= bestDistSq) continue;

                // the third column of the matrix is the velocity direction times the scale
                const scale = Math.hypot(a[o + 8], a[o + 9], a[o + 10]);
                const headPixels = SATELLITE_HEAD_RADIUS * scale * focalPixels / w;
                const radius = Math.max(this.settings.pickRadius, headPixels);
                if (distSq > radius * radius) continue;

                // skip it if the line of sight from the camera passes through the Earth
                const vx = x - cam.x, vy = y - cam.y, vz = z - cam.z;
                const len = Math.hypot(vx, vy, vz);
                const along = -(cam.x * vx + cam.y * vy + cam.z * vz) / len; // closest approach to the center
                if (along > 0 && along < len && camDistSq - along * along < earthRadius * earthRadius) continue;

                best = { groupName, satId: i };
                bestDistSq = distSq;
            }
        }
        return best;
    }

    async checkIntent() {
        const picked = this.pick();

        if (picked !== null) {
            // Show tooltip with the name
            const { groupName, satId } = picked;
            const satelliteName = this.groupMap.map.get(groupName).names[satId];
            this.updateTooltip(satelliteName, this.mousePos.x, this.mousePos.y);
            this.groupMap.addOrbit(groupName, satId);
        } else {
            // Hide the tooltip & clear hover state
            this.tooltip.style.display = 'none';
            await this.groupMap.onMouseOff();
        }
    }

    // Cleanup method
    destroy() {
        window.removeEventListener('mousemove', this.onMouseMove);
        this.debouncedHoverCheck.cancel();
    }

    updateTooltip(text, x, y) {
        const tooltipWidth = this.tooltip.offsetWidth;
        const tooltipHeight = this.tooltip.offsetHeight;
        const spaceRight = window.innerWidth - x - 10;
        const spaceBottom = window.innerHeight - y - 10;
        let isLeft = false;
        if (spaceRight < tooltipWidth) {
            // display to the left of the cursor
            this.tooltip.style.left = `${x - tooltipWidth - 10}px`;
            this.tooltip.style.borderRadius = '3px 0px 3px 3px';
            isLeft = true;
        } else {
            // display to the right of the cursor (default)
            this.tooltip.style.left = `${x + 10}px`;
            this.tooltip.style.borderRadius = '0px 3px 3px 3px';
        }
        if (spaceBottom < tooltipHeight) {
            // display above the cursor, and use a different pointy corner
            // if also displaying to the left
            this.tooltip.style.top = `${y - tooltipHeight - 10}px`;
            if (isLeft) {
                this.tooltip.style.borderRadius = '3px 3px 0px 3px';
            } else {
                this.tooltip.style.borderRadius = '3px 3px 3px 0px';
            }
        } else {
            // display below the cursor (default)
            this.tooltip.style.top = `${y + 10}px`;
        }
        this.tooltip.innerHTML = text;
        this.tooltip.style.display = 'block';
    }
}