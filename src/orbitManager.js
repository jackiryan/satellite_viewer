import { OrbitTrack } from './orbitTrack';


export class OrbitManager {
    constructor(scene) {
        this.scene = scene;

        this.orbits = new Map(); // Store active orbits by satellite name
        this.currentHover = null; // Track currently hovered satellite
    }

    addOrbitTrack(satId, options = {}) {
        // Only add if not already being processed or displayed
        if (!this.orbits.has(satId)) {
            const orbit = new OrbitTrack(options);
            this.orbits.set(satId, orbit);
        }
    }

    removeOrbitTrack(satId) {
        // If already processed, remove orbit and clean up
        if (this.orbits.has(satId)) {
            const orbit = this.orbits.get(satId);
            orbit.geometry.dispose();
            orbit.material.dispose();
            this.scene.remove(orbit.getObject3D());
            this.orbits.delete(satId);
        }
    }

    updateOrbit(satId, position, velocity) {
        if (this.orbits.has(satId)) {
            const orbit = this.orbits.get(satId);
            orbit.update(position, velocity);
            if (!orbit.displayed) {
                this.scene.add(orbit.getObject3D());
                orbit.displayed = true;
                this.updateHover(satId);
            }
        }
    }

    updateHover(satId) {
        // Remove previous hover orbit if exists and different
        if (this.currentHover && this.currentHover !== satId) {
            this.removeOrbitTrack(this.currentHover);
        }

        // Update current hover
        this.currentHover = satId;
    }
}
