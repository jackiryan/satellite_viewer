/* ecliptic.js
 * Draws the ecliptic on the star map as a dashed line: the plane of Earth's orbit, which is
 * also the Sun's yearly path through the stars and, roughly, the path of the Moon and
 * planets. It helps orient the viewer.
 */
import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { SKY_RADIUS, eclipticToWorld } from './skyCoords.js';

const DEG = Math.PI / 180;

const LINE_COLOR = 0xd9b46c;
const LINE_OPACITY = 0.55;
const LINE_WIDTH = 1.25;     // CSS pixels
const DASH_DEGREES = 0.7;
const GAP_DEGREES = 0.5;

const _viewport = new THREE.Vector4();

export class EclipticOverlay {
    constructor({ camera, renderer }) {
        this.camera = camera;
        this.renderer = renderer;
        this.domElement = renderer.domElement;

        // One point per degree. A great circle seen from its center projects to a straight
        // line, so the points only need to be close enough to keep the dashes even.
        const points = [];
        const p = new THREE.Vector3();
        for (let lon = 0; lon <= 360; lon++) {
            eclipticToWorld(lon, p).multiplyScalar(SKY_RADIUS);
            points.push(p.x, p.y, p.z);
        }
        const geometry = new LineGeometry();
        geometry.setPositions(points);
        this.material = new LineMaterial({
            color: LINE_COLOR,
            linewidth: LINE_WIDTH,
            transparent: true,
            opacity: LINE_OPACITY,
            dashed: true,
            dashSize: DASH_DEGREES * DEG * SKY_RADIUS,
            gapSize: GAP_DEGREES * DEG * SKY_RADIUS,
            depthTest: false,
            depthWrite: false
        });
        this.line = new Line2(geometry, this.material);
        this.line.computeLineDistances();
        this.line.name = 'ecliptic';
        this.line.renderOrder = 1; // after the sky

        // The line follows the camera in update(), like the sky it is drawn on
        this.group = new THREE.Group();
        this.group.add(this.line);
    }

    setVisible(visible) {
        this.group.visible = visible;
    }

    // Call once per frame, after the camera has moved and before rendering.
    update() {
        if (!this.group.visible) return;
        this.group.position.copy(this.camera.position);
        // LineMaterial widths are in drawing-buffer pixels; convert from CSS pixels
        this.renderer.getViewport(_viewport);
        this.material.linewidth = LINE_WIDTH * _viewport.z / Math.max(1, this.domElement.clientWidth);
    }
}
