import { MessageBroker } from './messageBroker';
import { OrbitTrack } from './orbitTrack';

export class OrbitManager {
    constructor(group, scene) {
        this.group = group;
        this.scene = scene;

        this.orbits = new Map(); // Store active orbits by satellite name
        this.currentHover = null; // Track currently hovered satellite
        this.displayed = false;
    }

    showOrbit(satId, options = {}) {
        if (!this.orbits.has(satId)) {
            // If the orbit has never been shown before, initialize it
            const orbit = new OrbitTrack(options);
            this.orbits.set(satId, orbit);
        } else if (!this.orbits.get(satId).displayed) {
            // Otherwise, add the orbit to the scene and play its animation
            const orbit = this.orbits.get(satId);
            this.scene.add(orbit.showOrbit());
            // update the currently hovered satellite
            this.updateHover(satId);
        } else {
            this.updateHover(satId);
        }
    }

    async hideOrbit(satId, animate = false) {
        if (this.orbits.has(satId)) {
            const orbit = this.orbits.get(satId);
            if (orbit.isAnimating !== 1) {
                const obj3D = await orbit.hideOrbit(animate);
                this.scene.remove(obj3D);
            }
        }
    }

    updateOrbit(satId, position, velocity) {
        /*
        Since orbits are approximate elliptical solutions to the complex
        true orbits of the satellites (from the TLE), they must be periodically
        refreshed to avoid diverging from the satellite model's position. This
        function is called by the satelliteGroupMap when handling the getPosVel
        message from the web worker, and causes the orbitTrack to recompute its
        position. If the orbit is being displayed for the first time, it
        must be added to the scene. This convoluted behavior is a result of my
        decision to broker all TLE calculations through the web worker, necessitating
        an asynchronous message passing interface between initialization of the orbit
        track and its display.
        */
        if (this.orbits.has(satId)) {
            const orbit = this.orbits.get(satId);
            orbit.updateOrbit(position, velocity);
            // rough proxy for checking that the orbit is being
            // displayed for the first time.
            if (!orbit.displayed && this.displayed) {
                this.scene.add(orbit.showOrbit());
                //this.updateHover(satId);
            }
        }
    }

    updateOrbitIndex(satId, position) {
        /*
        Lightweight function that gets called on frame updates to change
        the line segment index along the elliptical orbit that is currently
        in line with the satellite. If the accumulated error between the true
        satellite position and the orbit track is too much, we need to recompute
        the elliptical track by requesting a new position and velocity from
        the web worker, which will call updateOrbit thereafter.
        */
        const orbit = this.orbits.get(satId);
        const needsUpdate = orbit.updateIndex(position);

        // needsUpdate flips to true when distance squared error goes
        // above a distance-scaled epsilon value
        if (needsUpdate) {
            // console.log(`Recomputing orbit ${satId}`);
            MessageBroker.getInstance().getPosVel(this.group, satId);
        }
    }

    toggleOrbit(satId) {
        if (this.orbits.has(satId)) {
            const persistState = this.orbits.get(satId).persist;
            this.orbits.get(satId).persist = !persistState;
            //this.updateHover(satId);
        }
    }

    hideOrbits() {
        // dispose of currently hovered orbit, hide all others
        this.displayed = false;
        this.updateHover(null);
        for (const orbitId of this.orbits.keys()) {
            this.hideOrbit(orbitId);
        }
    }

    showOrbits() {
        this.displayed = true;
        for (const orbit of this.orbits.values()) {
            if (orbit.persist) {
                this.scene.add(orbit.showOrbit());
            }
        }
    }

    async updateHover(satId) {
        // Remove previous hover orbit if exists and different and not clicked on (persist)
        if (this.currentHover !== null && this.currentHover !== satId && this.orbits.get(this.currentHover).persist === false) {
            await this.hideOrbit(this.currentHover, true);
        }

        // Update current hover
        this.currentHover = satId;
    }
}
