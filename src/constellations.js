/* constellations.js
 * Highlights constellations on the star map. While the pointer is over a constellation (or
 * after a tap on a touch screen), lines are drawn between the stars of its figure and a
 * tooltip with its name follows the pointer.
 *
 * The data, static/skybox/constellations.json, is built by scripts/make_constellation_data.py:
 * the IAU / Sky & Telescope figures and the IAU boundaries from Stellarium's modern_iau sky
 * culture, with star positions from the HYG catalog that the star datapack was built from,
 * so each line ends exactly on the stars the shader draws.
 */
import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { SKY_RADIUS, raDecToWorld, worldToIcrs, screenToWorld, worldToScreen } from './skyCoords.js';

const DEG = Math.PI / 180;

const LINE_COLOR = 0xaeb5fb; // --blue-250 in main.css
const LINE_OPACITY = 0.85;
const LINE_WIDTH = 1.5;      // CSS pixels
const FADE_SECONDS = 0.25;

// Lines stop short of each star so the star itself stays visible, with a wider gap around
// brighter stars because they look bigger.
function gapDegrees(magnitude) {
    return THREE.MathUtils.clamp(0.42 - 0.05 * magnitude, 0.2, 0.45);
}

const TOOLTIP_OFFSET = 10; // CSS pixels between the pointer and the tooltip, as on the satellites page
const TAP_SLOP = 10;       // CSS pixels a touch may move and still count as a tap
const TAP_MAX_MS = 500;

const _direction = new THREE.Vector3();
const _icrs = new THREE.Vector3();
const _screen = new THREE.Vector2();
const _viewport = new THREE.Vector4();

export class ConstellationOverlay {
    constructor(data, { camera, renderer }) {
        this.camera = camera;
        this.renderer = renderer;
        this.domElement = renderer.domElement;

        // Lines are drawn on a sphere around the camera; update() keeps it centered there.
        this.group = new THREE.Group();
        this.group.name = 'constellations';

        const stars = new Map(Object.entries(data.stars).map(([hip, [ra, dec, mag]]) =>
            [Number(hip), { direction: raDecToWorld(ra, dec), mag }]));
        this.figures = data.constellations.map((c) => this.buildFigure(c, stars));
        this.byAbbr = new Map(this.figures.map((f) => [f.abbr, f]));

        // B1875 boundaries: see scripts/make_constellation_data.py for how they are searched
        this.toB1875 = new THREE.Matrix3().set(...data.boundaries.fromJ2000);
        this.edges = data.boundaries.edges;

        this.enabled = true;
        this.active = null;       // the figure being shown
        this.fading = new Set();  // figures whose lines are visible or fading
        this.pointer = null;      // canvas position of a hovering mouse or pen
        this.tapped = null;       // touch screens: the figure picked by the last tap...
        this.tapAnchor = null;    // ...and the sky direction that was tapped, for its tooltip
        this.touch = null;        // the touch that may become a tap

        this.tooltip = document.createElement('div');
        this.tooltip.className = 'tooltip constellation-tooltip';
        this.tooltip.setAttribute('aria-hidden', 'true');
        this.tooltipName = document.createElement('span');
        this.tooltipMeaning = document.createElement('span');
        this.tooltipMeaning.className = 'tooltip-detail';
        this.tooltip.append(this.tooltipName, this.tooltipMeaning);
        this.tooltip.style.display = 'none';
        document.querySelector('main').appendChild(this.tooltip);
        this.tooltipFigure = null;   // the figure the tooltip's text is for
        this.tooltipMeasured = null; // ...and the one its cached size is for
        this.tooltipWidth = 0;
        this.tooltipHeight = 0;

        this.addPointerListeners();
    }

    buildFigure({ abbr, name, meaning, segments }, stars) {
        const positions = new Float32Array(segments.length * 6);
        const start = new THREE.Vector3();
        const end = new THREE.Vector3();
        segments.forEach(([hipA, hipB], i) => {
            const a = stars.get(hipA);
            const b = stars.get(hipB);
            const angle = a.direction.angleTo(b.direction);
            let gapA = gapDegrees(a.mag) * DEG;
            let gapB = gapDegrees(b.mag) * DEG;
            // keep at least a third of a short segment
            const scale = Math.min(1, (angle * 2 / 3) / (gapA + gapB));
            gapA *= scale;
            gapB *= scale;
            slerpUnit(a.direction, b.direction, angle, gapA / angle, start).multiplyScalar(SKY_RADIUS);
            slerpUnit(a.direction, b.direction, angle, 1 - gapB / angle, end).multiplyScalar(SKY_RADIUS);
            positions.set([start.x, start.y, start.z, end.x, end.y, end.z], i * 6);
        });

        const geometry = new LineSegmentsGeometry();
        geometry.setPositions(positions);
        const material = new LineMaterial({
            color: LINE_COLOR,
            linewidth: LINE_WIDTH,
            transparent: true,
            opacity: 0,
            depthTest: false,
            depthWrite: false
        });
        const line = new LineSegments2(geometry, material);
        line.name = abbr;
        line.visible = false;
        line.renderOrder = 1; // after the sky
        this.group.add(line);

        return { abbr, name, meaning, line, fade: 0 };
    }

    // The constellation whose IAU boundary contains this world direction
    constellationAt(direction) {
        const p = worldToIcrs(direction, _icrs).applyMatrix3(this.toB1875);
        const ra = (Math.atan2(p.y, p.x) / DEG + 360) % 360;
        const dec = Math.asin(THREE.MathUtils.clamp(p.z, -1, 1)) / DEG;
        // edges are sorted by declination: the first one above the point, at its RA, has
        // the point's constellation on its south side
        for (const [start, end, edgeDec, abbr] of this.edges) {
            if (edgeDec > dec && (start < end ? ra >= start && ra < end : ra >= start || ra < end)) {
                return this.byAbbr.get(abbr);
            }
        }
        // no boundary above: the point is in Ursa Minor, which contains the north pole
        return this.byAbbr.get('UMi');
    }

    addPointerListeners() {
        const el = this.domElement;
        const local = (event) => {
            const rect = el.getBoundingClientRect();
            return { x: event.clientX - rect.left, y: event.clientY - rect.top };
        };

        // A mouse or pen shows the constellation under it. Touches can't hover, so they
        // show one when the sky is tapped (and not dragged).
        el.addEventListener('pointermove', (event) => {
            if (event.pointerType === 'touch') return;
            this.pointer = local(event);
            this.tapped = null;
        });
        el.addEventListener('pointerleave', (event) => {
            if (event.pointerType !== 'touch') this.pointer = null;
        });
        el.addEventListener('pointerdown', (event) => {
            if (event.pointerType !== 'touch') return;
            if (this.touch) {
                this.touch.multi = true; // a pinch or two-finger drag, not a tap
                return;
            }
            this.touch = { id: event.pointerId, x: event.clientX, y: event.clientY, time: event.timeStamp };
        });
        el.addEventListener('pointerup', (event) => {
            const touch = this.touch;
            if (event.pointerType !== 'touch' || !touch || touch.id !== event.pointerId) return;
            this.touch = null;
            const moved = Math.hypot(event.clientX - touch.x, event.clientY - touch.y);
            if (touch.multi || moved > TAP_SLOP || event.timeStamp - touch.time > TAP_MAX_MS) return;
            this.onTap(local(event));
        });
        el.addEventListener('pointercancel', (event) => {
            if (this.touch?.id === event.pointerId) this.touch = null;
        });
    }

    onTap({ x, y }) {
        if (!this.enabled) return;
        const direction = screenToWorld(x, y, this.camera, this.domElement.clientWidth,
            this.domElement.clientHeight, new THREE.Vector3());
        const figure = this.constellationAt(direction);
        // tapping the constellation that is showing hides it again
        if (figure === this.tapped) {
            this.tapped = null;
            this.tapAnchor = null;
        } else {
            this.tapped = figure;
            this.tapAnchor = direction;
        }
    }

    setEnabled(enabled) {
        this.enabled = enabled;
        if (!enabled) {
            this.tapped = null;
            this.tapAnchor = null;
        }
    }

    // Call once per frame, after the camera has moved and before rendering.
    update(deltaSeconds) {
        this.group.position.copy(this.camera.position);

        const width = this.domElement.clientWidth;
        const height = this.domElement.clientHeight;
        let figure = null;
        let tooltipAt = null;
        if (this.enabled && this.pointer) {
            screenToWorld(this.pointer.x, this.pointer.y, this.camera, width, height, _direction);
            figure = this.constellationAt(_direction);
            tooltipAt = this.pointer;
        } else if (this.enabled && this.tapped) {
            figure = this.tapped;
            tooltipAt = worldToScreen(this.tapAnchor, this.camera, width, height, _screen);
        }

        if (figure !== this.active) {
            this.active = figure;
            if (figure) this.fading.add(figure);
        }
        this.updateLines(deltaSeconds);
        this.updateTooltip(figure, tooltipAt, width, height);
    }

    updateLines(deltaSeconds) {
        // LineMaterial widths are in drawing-buffer pixels; convert from CSS pixels
        this.renderer.getViewport(_viewport);
        const linewidth = LINE_WIDTH * _viewport.z / Math.max(1, this.domElement.clientWidth);
        const step = deltaSeconds / FADE_SECONDS;
        for (const figure of this.fading) {
            const target = figure === this.active ? 1 : 0;
            figure.fade = target > figure.fade ? Math.min(1, figure.fade + step) : Math.max(0, figure.fade - step);
            const material = figure.line.material;
            material.opacity = LINE_OPACITY * figure.fade * figure.fade * (3 - 2 * figure.fade); // smoothstep
            material.linewidth = linewidth;
            figure.line.visible = figure.fade > 0;
            if (figure.fade === 0 && target === 0) this.fading.delete(figure);
        }
    }

    updateTooltip(figure, at, width, height) {
        const tooltip = this.tooltip;
        // hide it when the tapped spot has turned off screen
        if (!figure || !at || at.x < 0 || at.y < 0 || at.x > width || at.y > height) {
            tooltip.style.display = 'none';
            return;
        }
        const hidden = tooltip.style.display === 'none';
        if (figure !== this.tooltipFigure) {
            this.tooltipFigure = figure;
            this.tooltipName.textContent = figure.name;
            this.tooltipMeaning.textContent = figure.meaning ?? '';
            this.tooltipMeaning.style.display = figure.meaning ? '' : 'none';
        }
        tooltip.style.display = 'block';
        // measure only when the text changes or the tooltip reappears, not every frame
        if (hidden || figure !== this.tooltipMeasured) {
            this.tooltipMeasured = figure;
            this.tooltipWidth = tooltip.offsetWidth;
            this.tooltipHeight = tooltip.offsetHeight;
        }

        // Same placement as the satellite tooltips: below and to the right of the pointer,
        // flipped when that would leave the screen, with the square corner at the pointer.
        const rect = this.domElement.getBoundingClientRect();
        const x = rect.left + at.x;
        const y = rect.top + at.y;
        const left = window.innerWidth - x - TOOLTIP_OFFSET < this.tooltipWidth;
        const above = window.innerHeight - y - TOOLTIP_OFFSET < this.tooltipHeight;
        const tx = left ? x - TOOLTIP_OFFSET - this.tooltipWidth : x + TOOLTIP_OFFSET;
        const ty = above ? y - TOOLTIP_OFFSET - this.tooltipHeight : y + TOOLTIP_OFFSET;
        tooltip.style.left = `${tx}px`;
        tooltip.style.top = `${ty}px`;
        const r = (square) => (square ? '0px' : '3px');
        tooltip.style.borderRadius =
            `${r(!left && !above)} ${r(left && !above)} ${r(left && above)} ${r(!left && above)}`;
    }
}

// Point a fraction t of the way along the great circle from a to b (unit vectors `angle` apart)
function slerpUnit(a, b, angle, t, target) {
    const s = Math.sin(angle);
    return target.copy(a).multiplyScalar(Math.sin((1 - t) * angle) / s)
        .addScaledVector(b, Math.sin(t * angle) / s);
}

export async function initConstellations({ scene, camera, renderer }) {
    const response = await fetch(`${window.location.origin}/skybox/constellations.json`);
    if (!response.ok) {
        throw new Error(`Failed to load constellation data: ${response.status} ${response.statusText}`);
    }
    const overlay = new ConstellationOverlay(await response.json(), { camera, renderer });
    scene.add(overlay.group);
    return overlay;
}
