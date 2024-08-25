import * as THREE from 'three';

export class Entity extends THREE.Object3D {
    constructor(name, color) {
        super();
        this.name = name;
        this.color = color;
        this.geometry = new THREE.IcosahedronGeometry(0.02);
        this.material = new THREE.MeshBasicMaterial({ color: this.color });
        this.mesh = new THREE.Mesh(this.geometry, this.material);
        this.mesh.name = this.name;
    }

    destroyMesh() {
        if (this.mesh) {
            this.mesh = null;
        }
    }

    updatePosScale(newPos, newScale, dataValid) {
        if (dataValid !== 1) {
            this.destroyMesh();
            return;
        }
        this.mesh.position.set(newPos[0], newPos[1], newPos[2]);
        this.mesh.scale.set(newScale, newScale, newScale);
    }
}
