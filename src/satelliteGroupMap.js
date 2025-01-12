
import * as THREE from 'three';
import { OrbitTrack } from './orbitTrack';
import Worker from './satelliteWorker.js?worker';
import { OrbitManager } from './orbitManager';
import { MessageBroker } from './messageBroker';

export class SatelliteGroupMap {
    constructor(scene, geo, layer) {
        this.scene = scene;
        this.layer = layer;

        this.map = new Map();

        // This is a base size, the geometry will be scaled relative to the distance from Earth
        // farther objects are larger (at least up to a maxScale defined in satelliteWorker.js)
        //this.instanceGeometry = new THREE.IcosahedronGeometry(0.02);
        this.instanceGeometry = geo;

        // All objects in the Other category have this blue color
        this.instanceMaterial = new THREE.MeshBasicMaterial({ color: '#c4a484' });

        this.worker = new Worker();
        MessageBroker.getInstance().setWorker(this.worker);
        this.worker.onmessage = (event) => {
            // The worker posts a message when it starts the callback loop or when a
            // specific satellite's current position and velocity are requested
            if (event.data.type === 'eventLoopStarted') {
                const url = event.data.payload;
                this.displayGroup(url);
            } else {
                const posVel = event.data.payload;
                const selectedGroup = this.map.get(posVel.group);
                selectedGroup.orbitManager.updateOrbit(posVel.iid, posVel.position, posVel.velocity);
            }
        }
    }

    hasGroup(name) {
        return this.map.has(name);
    }

    async toggleAllGroups(isShow) {
        // isShow => should all groups be shown? If false, hide all
        const indexUrl = './groups/index.json';
        const response = await fetch(indexUrl, {
            method: 'GET',
            credentials: 'include',
            mode: 'no-cors',
        });
        const indexDb = await response.json();
        for (const group of Object.values(indexDb)) {
            const groupUrl = group.entities;
            // this means the group has already been init'd
            if (isShow) {
                if (this.hasGroup(groupUrl)) {
                    this.displayGroup(groupUrl);
                } else {
                    this.initGroup(groupUrl, group.count, group.baseColor);
                }
            } else {
                this.hideGroup(groupUrl);
            }
        }
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
        // see buttonGroup.js:populateButtonGroup, maybe buttonGroup should send the count
        // and color info in the event?
        const indexUrl = './groups/index.json';
        const response = await fetch(indexUrl, {
            method: 'GET',
            credentials: 'include',
            mode: 'no-cors',
        });
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
        this.initGroup(groupUrl, count, baseColor);
    }

    /* The inner part of onInitGroup that just handles instantiating the mesh
       and passing a message to the worker. This allows us to avoid additional
       cache hits to index.json when doing toggleAllGroups */
    async initGroup(groupUrl, count, baseColor) {
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
        // avoids a race condition. It sounds weird, but I am doing this because
        // I don't understand why the bounding sphere used for raycasting (tooltip)
        // uses only the initial bounding sphere when determining intersections
        for (let i = 0; i < count; i++) {
            dummy.position.set(
                0.0,
                0.0,
                0.0
            );
            dummy.scale.set(0.1, 0.1, 0.1);
            dummy.updateMatrix();
            groupMesh.setMatrixAt(i, dummy.matrix);
        }
        groupMesh.name = groupUrl;
        groupMesh.computeBoundingSphere();
        groupMesh.layers.enable(this.layer);
        // frustum culling should be enabled by default for instanced meshes
        groupMesh.frustumCulled = false;

        const groupDb = await this.fetchEntities(groupUrl);

        // displayed is false because the mesh will be shown later after
        // the transform matrices are initialized by the webworker
        this.map.set(groupUrl, {
            displayed: false,
            names: Object.keys(groupDb.entities),
            mesh: groupMesh,
            orbitManager: new OrbitManager(groupUrl, this.scene)
        });

        this.worker.postMessage({
            action: 'init',
            data: { url: groupUrl, groupData: this.JSONtoArrayBuffer(groupDb), buffer: sharedTransformBuffer }
        });
    }

    async fetchEntities(entitiesUrl) {
        try {
            const response = await fetch(entitiesUrl, {
                method: 'GET',
                credentials: 'include',
                mode: 'no-cors',
            });
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
            groupObj.mesh.computeBoundingSphere();
            this.scene.add(groupObj.mesh);
            groupObj.orbitManager.showOrbits();
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
            groupObj.orbitManager.hideOrbits();
        }
    }

    update() {
        for (const group of this.map.values()) {
            if (group.displayed) {
                group.mesh.instanceMatrix.needsUpdate = true;

                // Update the nearest displayed segment in all currently displayed orbits
                // this code should be in the OrbitManager, but I'm not sure how to do that cleanly
                const satIds = group.orbitManager.orbits.keys();
                const instanceMat = new THREE.Matrix4();
                for (const satId of satIds) {
                    const instanceNdx = satId;
                    group.mesh.getMatrixAt(instanceNdx, instanceMat);
                    const position = new THREE.Vector3();
                    instanceMat.decompose(position, new THREE.Quaternion(), new THREE.Vector3());
                    group.orbitManager.updateOrbitIndex(satId, [position.x, position.y, position.z]);
                }
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

    addOrbit(etGroup, etIid) {
        // etGroup/etIid = event group / event instance id, used to diambiguate the arguments
        const group = this.map.get(etGroup);
        const options = { color: group.mesh.material.color };
        group.orbitManager.addOrbitTrack(etIid, options);
    }

    toggleOrbit(etGroup, etIid) {
        const group = this.map.get(etGroup);
        group.orbitManager.toggleOrbit(etIid);
    }

    getSatellitePosVel(etGroup, etIid) {
        // etGroup/etIid = event group / event instance id, used to diambiguate the arguments
        // coming from the event with the keys in the message data object
        // We use this convoluted method of getting the position/velocity of a satellite because
        // we don't want to desync timing, satellite transformations are all calculated in
        // one class (and in the worker)
        this.worker.postMessage({
            action: 'getPosVel',
            data: {
                group: etGroup,
                iid: etIid
            }
        });
    }

    async removeOrbits() {
        for (const group of this.map.values()) {
            await group.orbitManager.updateHover(null);
        }
    }
}
