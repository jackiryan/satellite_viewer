
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
            const url = event.data;
            this.displayGroup(url);
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
        // set initial positions to be random so that bounding sphere is large,
        // avoids a race condition
        for (let i = 0; i < count; i++) {
            dummy.position.set(
                Math.random() * 100 - 50,
                Math.random() * 100 - 50,
                Math.random() * 100 - 50
            );
            dummy.updateMatrix();
            groupMesh.setMatrixAt(i, dummy.matrix);
        }
        groupMesh.name = groupUrl;
        groupMesh.frustumCulled = false;

        const groupDb = await this.fetchEntities(groupUrl);

        // displayed is false because the mesh will be shown later after
        // the transform matrices are initialized by the webworker
        this.map.set(groupUrl, {
            displayed: false,
            names: Object.keys(groupDb.entities),
            mesh: groupMesh
        });

        this.worker.postMessage({
            action: 'init',
            data: { url: groupUrl, groupData: this.JSONtoArrayBuffer(groupDb), buffer: sharedTransformBuffer }
        });
    }

    async fetchEntities(entitiesUrl) {
        try {
            const response = await fetch(entitiesUrl);
            if (!response.ok) {
                throw new Error(`Network response was not ok: ${response.statusText}`);
            }
            const groupDb = await response.json();
            if (groupDb && groupDb.entities) {
                return groupDb;
            } else {
                throw new Error('Failed to add group: groupDb is undefined or does not contain entities');
            }
        } catch (error) {
            console.error('Failed to fetch entity names:', error);
            return undefined;
        }
    }

    JSONtoArrayBuffer(jsonObject) {
        const dataString = JSON.stringify(jsonObject);
        const len = dataString.length;
        const arr = new Uint8Array(len);
        let i = -1;
        while (++i < len) {
            arr[i] = dataString.charCodeAt(i);
        }
        return arr.buffer;
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

    setRealTime() {
        this.worker.postMessage({
            action: 'reset'
        });
    }
}
