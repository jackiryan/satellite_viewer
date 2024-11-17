
import * as THREE from 'three';

export class OrbitTrack {
    constructor(position, velocity, options = {}) {
        // Constants
        // units going into the computeOrbit function are scaled such that
        // the gravitational constant can be 1
        this.mu = options.mu || 1; // Gravitational parameter
        this.numPoints = options.numPoints || 360; // Number of points along the orbit
        this.color = options.color || 0xffffff; // Line color

        // TO DO: Animated alpha blending material
        this.material = new THREE.LineBasicMaterial({ color: this.color });

        // Initialize geometry and line
        this.geometry = new THREE.BufferGeometry();
        this.positions = new Float32Array((this.numPoints + 1) * 3); // +1 to close the loop
        this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));

        // Create the LineLoop
        this.orbitLine = new THREE.LineLoop(this.geometry, this.material);

        // Compute initial orbit
        this.computeOrbit(position, velocity);
    }

    computeOrbit(position, velocity) {
        // Helper functions
        const cross = (a, b) => {
            return new THREE.Vector3().crossVectors(a, b);
        };

        const dot = (a, b) => {
            return a.dot(b);
        };

        const magnitude = (v) => {
            return v.length();
        };

        // Convert input arrays to THREE.Vector3 if necessary
        let r = position instanceof THREE.Vector3 ? position.clone() : new THREE.Vector3(...position);
        let v = velocity instanceof THREE.Vector3 ? velocity.clone() : new THREE.Vector3(...velocity);

        // Step 1: Compute the specific angular momentum vector (h)
        let h = cross(r, v);
        let h_mag = magnitude(h);

        // Step 2: Compute the eccentricity vector (e_vec) and eccentricity (e)
        let e_vec = cross(v, h).divideScalar(this.mu).sub(r.clone().divideScalar(magnitude(r)));
        let e = magnitude(e_vec);

        // Step 3: Compute the specific mechanical energy (epsilon)
        let epsilon = 0.5 * v.lengthSq() - this.mu / r.length();

        // Step 4: Compute the semi-major axis (a)
        let a = -this.mu / (2 * epsilon);

        // Step 5: Compute the inclination (i)
        let i = Math.acos(h.z / h_mag);

        // Step 6: Compute the node vector (n)
        let k = new THREE.Vector3(0, 0, 1);
        let n = cross(k, h);
        let n_mag = magnitude(n);

        // Step 7: Compute the longitude of the ascending node (Omega)
        let Omega = Math.atan2(n.y, n.x);

        // Step 8: Compute the argument of periapsis (omega)
        let omega = Math.acos(dot(n, e_vec) / (n_mag * e));
        if (e_vec.z < 0) {
            omega = 2 * Math.PI - omega;
        }

        // Step 9: Generate points along the orbit
        let positions = this.positions;
        let index = 0;
        for (let j = 0; j <= this.numPoints; j++) {
            let theta = (j / this.numPoints) * 2 * Math.PI;

            // Compute the radius at this true anomaly
            let r_orbit = (a * (1 - e * e)) / (1 + e * Math.cos(theta));

            // Position in the orbital plane
            let x_orb = r_orbit * Math.cos(theta);
            let y_orb = r_orbit * Math.sin(theta);
            let z_orb = 0; // Orbital plane z = 0

            // Position vector in orbital plane coordinates
            let positionOrbitPlane = new THREE.Vector3(x_orb, y_orb, z_orb);

            // Rotation matrices
            let rotationMatrix = new THREE.Matrix4();

            // Rotate by argument of periapsis (omega) around Z-axis
            rotationMatrix.makeRotationZ(omega);
            positionOrbitPlane.applyMatrix4(rotationMatrix);

            // Rotate by inclination (i) around X-axis
            rotationMatrix.makeRotationX(i);
            positionOrbitPlane.applyMatrix4(rotationMatrix);

            // Rotate by longitude of ascending node (Omega) around Z-axis
            rotationMatrix.makeRotationZ(Omega);
            positionOrbitPlane.applyMatrix4(rotationMatrix);

            // Assign positions
            positions[index++] = positionOrbitPlane.x;
            positions[index++] = positionOrbitPlane.y;
            positions[index++] = positionOrbitPlane.z;
        }

        // Update the geometry
        this.geometry.attributes.position.needsUpdate = true;
        this.geometry.computeBoundingSphere();
    }

    update(position, velocity) {
        // Recompute the orbit with new position and velocity
        this.computeOrbit(position, velocity);
    }

    getObject3D() {
        // Return the THREE.LineLoop object for adding to the scene
        return this.orbitLine;
    }
}
