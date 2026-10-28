/* skyControls.js
 * Drag-to-look controls for a camera at the center of the sky. Dragging with a mouse, pen or
 * one finger turns the camera so the point of the sky that was grabbed stays under the
 * pointer. There is no fixed "up", so the view turns freely through the celestial poles
 * instead of spinning around them the way OrbitControls does; resetView() brings the camera
 * back to where it started.
 */
import * as THREE from 'three';
import { screenToWorld } from './skyCoords.js';

const RESET_SECONDS = 0.6;

const _under = new THREE.Vector3();
const _turn = new THREE.Quaternion();

export class SkyControls {
    constructor(camera, domElement) {
        this.camera = camera;
        this.domElement = domElement;
        this.home = camera.quaternion.clone(); // the view resetView() returns to

        this.pointerId = null;               // the pointer dragging the sky
        this.grabbed = new THREE.Vector3();  // the sky direction it holds
        this.resetFrom = null;               // set while the reset animation runs
        this.resetProgress = 0;

        domElement.style.touchAction = 'none'; // no browser scrolling or zooming on the canvas
        domElement.addEventListener('pointerdown', (event) => this.onPointerDown(event));
        domElement.addEventListener('pointermove', (event) => this.onPointerMove(event));
        domElement.addEventListener('pointerup', (event) => this.onPointerUp(event));
        domElement.addEventListener('pointercancel', (event) => this.onPointerUp(event));
    }

    // Sky direction under a pointer event, with the camera as it is now
    directionUnder(event, target) {
        const rect = this.domElement.getBoundingClientRect();
        return screenToWorld(event.clientX - rect.left, event.clientY - rect.top,
            this.camera, rect.width, rect.height, target);
    }

    onPointerDown(event) {
        // one pointer at a time, and only the primary mouse button
        if (this.pointerId !== null || (event.pointerType === 'mouse' && event.button !== 0)) return;
        this.pointerId = event.pointerId;
        this.domElement.setPointerCapture(event.pointerId);
        this.resetFrom = null; // grabbing the sky stops a reset in progress
        this.camera.updateMatrixWorld();
        this.directionUnder(event, this.grabbed);
    }

    onPointerMove(event) {
        if (event.pointerId !== this.pointerId) return;
        // turn the camera by the smallest rotation that brings the grabbed direction back
        // under the pointer
        this.camera.updateMatrixWorld();
        this.directionUnder(event, _under);
        _turn.setFromUnitVectors(_under, this.grabbed);
        this.camera.quaternion.premultiply(_turn).normalize();
        this.camera.updateMatrixWorld();
    }

    onPointerUp(event) {
        if (event.pointerId !== this.pointerId) return;
        this.pointerId = null;
        if (this.domElement.hasPointerCapture(event.pointerId)) {
            this.domElement.releasePointerCapture(event.pointerId);
        }
    }

    // Turn back to the starting view over a moment, so the viewer can follow the motion
    resetView() {
        this.resetFrom = this.camera.quaternion.clone();
        this.resetProgress = 0;
    }

    // Call once per frame, before anything that reads the camera.
    update(deltaSeconds) {
        if (this.resetFrom) {
            this.resetProgress = Math.min(1, this.resetProgress + deltaSeconds / RESET_SECONDS);
            const t = this.resetProgress;
            const eased = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2; // ease in and out
            this.camera.quaternion.slerpQuaternions(this.resetFrom, this.home, eased);
            if (t === 1) this.resetFrom = null;
        }
        this.camera.updateMatrixWorld();
    }
}
