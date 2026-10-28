/* ecliptic.js
 * Draws the ecliptic on the star map: the plane of Earth's orbit, which is also the Sun's
 * yearly path through the stars and, roughly, the path of the Moon and planets. It is a
 * dashed line with labels along it, to help orient the viewer.
 */
import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { SKY_RADIUS, eclipticToWorld, worldToScreen } from './skyCoords.js';

const DEG = Math.PI / 180;

const LINE_COLOR = 0xd9b46c; // keep in sync with --ecliptic-color in main.css
const LINE_OPACITY = 0.55;
const LINE_WIDTH = 1.25;     // CSS pixels
const DASH_DEGREES = 0.7;
const GAP_DEGREES = 0.5;
const LABEL_MARGIN = 40;     // CSS pixels: labels are hidden this close to the edge of the screen

// Degrees of ecliptic longitude between labels: as far apart as possible while still fitting
// one across the narrower side of the view (30 on a landscape screen, 15 on a portrait phone)
function labelSpacing(camera) {
    const vertical = camera.fov;
    const horizontal = 2 * Math.atan(Math.tan(vertical * DEG / 2) * camera.aspect) / DEG;
    const span = 0.75 * Math.min(vertical, horizontal);
    return [30, 20, 15, 10].find((spacing) => spacing <= span) ?? 10;
}

const _viewport = new THREE.Vector4();
const _at = new THREE.Vector2();
const _ahead = new THREE.Vector2();

export class EclipticOverlay {
    constructor({ camera, renderer }) {
        this.camera = camera;
        this.renderer = renderer;
        this.domElement = renderer.domElement;
        this.visible = true;

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

        this.container = document.createElement('div');
        this.container.className = 'sky-labels';
        this.container.setAttribute('aria-hidden', 'true');
        document.querySelector('main').appendChild(this.container);
        this.labels = [];
        this.spacing = 0;
    }

    // Place a label every `spacing` degrees of ecliptic longitude
    placeLabels(spacing) {
        this.spacing = spacing;
        this.container.replaceChildren();
        this.labels = [];
        for (let lon = spacing / 2; lon < 360; lon += spacing) {
            const element = document.createElement('div');
            element.className = 'ecliptic-label';
            element.textContent = 'Ecliptic';
            this.container.appendChild(element);
            // two points along the line give the label's angle on screen
            this.labels.push({
                element,
                at: eclipticToWorld(lon),
                ahead: eclipticToWorld(lon + 1),
                shown: false
            });
        }
    }

    setVisible(visible) {
        this.visible = visible;
        this.group.visible = visible;
        this.container.style.display = visible ? '' : 'none';
    }

    // Call once per frame, after the camera has moved and before rendering.
    update() {
        if (!this.visible) return;
        this.group.position.copy(this.camera.position);
        // LineMaterial widths are in drawing-buffer pixels; convert from CSS pixels
        this.renderer.getViewport(_viewport);
        this.material.linewidth = LINE_WIDTH * _viewport.z / Math.max(1, this.domElement.clientWidth);

        const spacing = labelSpacing(this.camera);
        if (spacing !== this.spacing) this.placeLabels(spacing);

        const width = this.domElement.clientWidth;
        const height = this.domElement.clientHeight;
        // the labels' container covers the viewport; the canvas may not start at its corner
        const rect = this.domElement.getBoundingClientRect();
        for (const label of this.labels) {
            const at = worldToScreen(label.at, this.camera, width, height, _at);
            const ahead = at && worldToScreen(label.ahead, this.camera, width, height, _ahead);
            const shown = Boolean(ahead) && at.x > LABEL_MARGIN && at.x < width - LABEL_MARGIN &&
                at.y > LABEL_MARGIN && at.y < height - LABEL_MARGIN;
            if (shown !== label.shown) {
                label.shown = shown;
                label.element.classList.toggle('visible', shown);
            }
            if (!shown) continue;
            // run the text along the line, turned so it is never upside down
            let angle = Math.atan2(ahead.y - at.y, ahead.x - at.x);
            if (angle > Math.PI / 2) angle -= Math.PI;
            if (angle < -Math.PI / 2) angle += Math.PI;
            label.element.style.transform =
                `translate(${(rect.left + at.x).toFixed(1)}px, ${(rect.top + at.y).toFixed(1)}px) rotate(${angle.toFixed(4)}rad) translate(-50%, -100%)`;
        }
    }
}
