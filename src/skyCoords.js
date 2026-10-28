/* skyCoords.js
 * Conversions between celestial coordinates and the world space of the star map, shared by
 * the overlays drawn on top of it (constellations.js, ecliptic.js).
 *
 * The star shaders (shaders/skybox/sky*Fragment.glsl) place the ICRS (J2000) frame, whose
 * z axis points at the north celestial pole and x axis at RA 0h, in world space as
 *
 *     world = (x_icrs, z_icrs, -y_icrs)
 *
 * so celestial north is +Y. The sky sits at infinity: only directions matter, so overlays
 * are drawn on a sphere of radius SKY_RADIUS centered on the camera, which keeps them
 * exactly over the stars wherever the camera is.
 */
import * as THREE from 'three';

const DEG = Math.PI / 180;

// Radius of the sphere the overlays are drawn on; must be inside the camera's far plane.
export const SKY_RADIUS = 100;

// Mean obliquity of the ecliptic at J2000 (IAU 2006: 84381.406 arcseconds).
export const OBLIQUITY_J2000 = 84381.406 / 3600;

// Unit vector in world space for a J2000 right ascension and declination (degrees).
export function raDecToWorld(raDeg, decDeg, target = new THREE.Vector3()) {
    const ra = raDeg * DEG;
    const dec = decDeg * DEG;
    const x = Math.cos(dec) * Math.cos(ra);
    const y = Math.cos(dec) * Math.sin(ra);
    const z = Math.sin(dec);
    return target.set(x, z, -y);
}

// ICRS unit vector (x toward RA 0h, z toward the north pole) for a world direction.
export function worldToIcrs(direction, target = new THREE.Vector3()) {
    return target.set(direction.x, -direction.z, direction.y).normalize();
}

// Unit vector in world space for a point on the J2000 ecliptic at this longitude (degrees).
export function eclipticToWorld(lonDeg, target = new THREE.Vector3()) {
    const lon = lonDeg * DEG;
    const eps = OBLIQUITY_J2000 * DEG;
    const x = Math.cos(lon);
    const y = Math.sin(lon) * Math.cos(eps);
    const z = Math.sin(lon) * Math.sin(eps);
    return target.set(x, z, -y);
}

// World direction under a point on the canvas, given in CSS pixels from its top-left corner.
export function screenToWorld(x, y, camera, width, height, target = new THREE.Vector3()) {
    target.set((x / width) * 2 - 1, 1 - (y / height) * 2, 0.5).unproject(camera);
    return target.sub(camera.position).normalize();
}

const _view = new THREE.Vector3();
const _forward = new THREE.Vector3();

// Canvas position (CSS pixels) of a world direction. Returns null when the direction is
// behind the camera.
export function worldToScreen(direction, camera, width, height, target = new THREE.Vector2()) {
    camera.getWorldDirection(_forward);
    if (direction.dot(_forward) <= 1e-6) {
        return null;
    }
    _view.copy(direction).multiplyScalar(SKY_RADIUS).add(camera.position).project(camera);
    return target.set((_view.x + 1) / 2 * width, (1 - _view.y) / 2 * height);
}
