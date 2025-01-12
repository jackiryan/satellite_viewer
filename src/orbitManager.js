import { MessageBroker } from './messageBroker';
import { OrbitTrack } from './orbitTrack';

export class OrbitManager {
    constructor(group, scene) {
        this.group = group;
        this.scene = scene;

        this.orbits = new Map(); // Store active orbits by satellite name
        this.currentHover = null; // Track currently hovered satellite
    }

    addOrbitTrack(satId, options = {}) {
        // Only add if not already being processed or displayed
        if (!this.orbits.has(satId)) {
            const orbit = new OrbitTrack(options);
            this.orbits.set(satId, orbit);
        } else {
            const orbit = this.orbits.get(satId);
            this.scene.add(orbit.getObject3D());
            orbit.displayed = true;
            this.updateHover(satId);
        }
    }

    removeOrbitTrack(satId) {
        // If already processed, remove orbit and clean up
        if (this.orbits.has(satId)) {
            const orbit = this.orbits.get(satId);
            //orbit.geometry.dispose();
            //orbit.material.dispose();
            this.scene.remove(orbit.getObject3D());
            orbit.displayed = false;
            //this.orbits.delete(satId);
        }
    }

    updateOrbit(satId, position, velocity) {
        if (this.orbits.has(satId)) {
            const orbit = this.orbits.get(satId);
            orbit.updateOrbit(position, velocity);
            if (!orbit.displayed) {
                this.scene.add(orbit.getObject3D());
                orbit.displayed = true;
                this.updateHover(satId);
            }
        }
    }

    updateOrbitIndex(satId, position) {
        const orbit = this.orbits.get(satId);
        const needsUpdate = orbit.updateIndex(position);

        if (needsUpdate) {
            // console.log(`Recomputing orbit ${satId}`);
            MessageBroker.getInstance().getPosVel(this.group, satId);
        }
    }

    toggleOrbit(satId) {
        if (this.orbits.has(satId)) {
            const persistState = this.orbits.get(satId).persist;
            this.orbits.get(satId).persist = !persistState;
            this.updateHover(satId);
        }
    }

    hideOrbits() {
        // dispose of currently hovered orbit, hide all others
        this.updateHover(null);
        for (const orbit of this.orbits.values()) {
            orbit.displayed = false;
            this.scene.remove(orbit.getObject3D());
        }
    }

    showOrbits() {
        for (const orbit of this.orbits.values()) {
            orbit.displayed = true;
            this.scene.add(orbit.getObject3D());
        }
    }

    updateHover(satId) {
        // Remove previous hover orbit if exists and different
        if (this.currentHover !== null && this.currentHover !== satId && this.orbits.get(this.currentHover).persist === false) {
            this.removeOrbitTrack(this.currentHover);
        }

        // Update current hover
        this.currentHover = satId;
    }
}
