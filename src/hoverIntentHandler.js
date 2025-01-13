import _ from 'lodash';
import * as THREE from 'three';

const interactiveLayer = 1;

export class HoverIntentHandler {
    constructor(renderer, scene, camera, groupMap, options = {}) {
        this.scene = scene;
        this.camera = camera;
        this.renderer = renderer;
        this.groupMap = groupMap;

        // Default settings
        this.settings = {
            interval: 50,           // Time in ms to check mouse position
            ...options
        };

        // State tracking
        this.mouse = new THREE.Vector2();
        this.raycaster = new THREE.Raycaster();
        this.raycaster.layers.set(interactiveLayer);
        this.intentTimer = null;
        this.mousePos = { x: 0, y: 0 };

        this.tooltip = document.createElement('div');
        this.tooltip.className = 'tooltip';
        this.tooltip.style.zIndex = 1;
        document.querySelector('main').appendChild(this.tooltip);

        // Bind methods
        this.onMouseMove = this.onMouseMove.bind(this);
        this.onMouseClick = this.onMouseClick.bind(this);
        this.checkIntent = this.checkIntent.bind(this);

        // Create debounced version of hover check
        this.debouncedHoverCheck = _.debounce(this.checkIntent, this.settings.interval);

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

        // Perform raycast
        this.raycaster.setFromCamera(this.mouse, this.camera);
        const intersects = this.raycaster.intersectObjects(this.scene.children, true);
        if (intersects.length > 0 && intersects[0].object.name !== 'earth') {
            const intersectedObject = intersects[0].object;
            const groupName = intersectedObject.name;
            const satId = intersects[0].instanceId;
            this.groupMap.toggleOrbit(groupName, satId);
        }
    }

    async checkIntent() {
        // Perform raycast
        this.raycaster.setFromCamera(this.mouse, this.camera);
        const intersects = this.raycaster.intersectObjects(this.scene.children, true);

        if (intersects.length > 0 && intersects[0].object.name !== 'earth') {
            const intersectedObject = intersects[0].object;
            // Show tooltip with the name
            const groupName = intersectedObject.name;
            const satId = intersects[0].instanceId;
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