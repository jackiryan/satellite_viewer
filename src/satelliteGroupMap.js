
import * as THREE from 'three';
import Worker from './satelliteWorker.js?worker';

export class SatelliteGroupMap {
    constructor(scene) {
        this.scene = scene;

        this.map = new Map();

        // This is a base size, the geometry will be scaled relative to the distance from Earth
        // farther objects are larger (at least up to a maxScale defined in satelliteWorker.js)
        this.instanceGeometry = new THREE.IcosahedronGeometry(0.02);
        // All objects in the Other category have this blue color
        this.instanceMaterial = new THREE.MeshBasicMaterial({ color: '#1b1bf9' });

        this.worker = new Worker();
        this.worker.onmessage = (event) => {
            // The worker only ever posts a message when it starts the callback loop,
            // so we can assume that event.data is always the group that was added
            // and the names that were parsed from the JSON response
            const { url, names } = event.data;
            this.onWorkerInitGroup(url, names);
        }
    }

    hasGroup(name) {
        return this.map.has(name);
    }

    groupDisplayed(name) {
        if (this.hasGroup(name)) {
            return this.map.get(name).displayed;
        } else {
            return false;
        }
    }

    async onInitGroup(groupUrl) {
        // this fetch should be cached by the time this function is called the first time
        // see buttonGroup.js:populateButtonGroup
        const indexUrl = './groups/index.json';
        const response = await fetch(indexUrl);
        const indexDb = await response.json();
        let groupObj;
        for (const group of Object.values(indexDb)) {
            if (group.entities === groupUrl) {
                groupObj = group;
            }
        }
        if (groupObj === undefined) {
            console.error('Unable to find group:', groupUrl);
            return;
        }
        // count MUST exist, and if it doesn't, we have a problem
        const count = groupObj.count;
        // baseColor may or may not exist for this object
        const baseColor = groupObj.baseColor;

        let material = this.instanceMaterial;
        if (baseColor !== undefined) {
            material = new THREE.MeshBasicMaterial({ color: baseColor });
        }

        const groupMesh = new THREE.InstancedMesh(
            this.instanceGeometry,
            material,
            count
        );
        const sharedTransformBuffer = new SharedArrayBuffer(count * 16 * 4);
        groupMesh.instanceMatrix = new THREE.InstancedBufferAttribute(
            new Float32Array(sharedTransformBuffer), 16
        );
        groupMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        const dummy = new THREE.Object3D();
        for (let i = 0; i < count; i++) {
            dummy.position.set(
                0,
                5.5,
                0
            );
            dummy.updateMatrix();
            groupMesh.setMatrixAt(i, dummy.matrix);
        }
        groupMesh.name = groupUrl;
        groupMesh.frustumCulled = false;


        // displayed is false because the mesh will be shown later after
        // the transform matrices are initialized by the webworker
        this.map.set(groupUrl, {
            displayed: false,
            names: new Array(count).fill(''),
            mesh: groupMesh
        });

        this.worker.postMessage({
            action: 'init',
            data: { url: groupUrl, buffer: sharedTransformBuffer }
        });
    }

    onWorkerInitGroup(groupUrl, satelliteNames) {
        const groupObj = this.map.get(groupUrl);
        for (let i = 0; i < satelliteNames.length; i++) {
            groupObj.names[i] = satelliteNames[i];
        }
        this.displayGroup(groupUrl);
    }

    displayGroup(groupUrl) {
        if (!this.groupDisplayed(groupUrl)) { 
            this.worker.postMessage({
                action: 'display',
                data: { url: groupUrl }
            });
            const groupObj = this.map.get(groupUrl);
            groupObj.displayed = true;
            groupObj.mesh.instanceMatrix.needsUpdate = true;
            this.scene.add(groupObj.mesh);
        }
    }

    hideGroup(groupUrl) {
        if (this.groupDisplayed(groupUrl)) {
            this.worker.postMessage({
                action: 'hide',
                data: { url: groupUrl }
            });
            const groupObj = this.map.get(groupUrl);
            groupObj.displayed = false;
            this.scene.remove(groupObj.mesh);
        }
    }

    update() {
        for (const group of this.map.values()) {
            if (group.displayed) {
                group.mesh.instanceMatrix.needsUpdate = true;
            }
        }
    }

    setSpeed(speedFactor) {
        this.worker.postMessage({
            action: 'setSpeed',
            data: { speed: speedFactor }
        });
    }
}
