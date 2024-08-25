import { Entity } from './entity.js';

export class EntityGroupMap {
    constructor(scene) {
        this.scene = scene;

        this.map = new Map();

        this.worker = new Worker('./satelliteWorker.js', { type: 'module' });
        console.log('secure context:', window.isSecureContext);
        this.worker.onmessage = (e) => {
            const { messageType, result } = e.data;
            if (messageType === 'groupInitialized') {
                const { groupUrl, satObjs } = result;
                this.onWorkerInitGroup(groupUrl, satObjs);
            } else if (messageType === 'satGroupUpdated') {
                const { groupUrl, posBuffer, scaleBuffer, dataValidBuffer } = result;
                this.onGroupUpdated(groupUrl, posBuffer, scaleBuffer, dataValidBuffer);
            }
        };
    }

    dispatchInitGroup(groupUrl) {
        this.worker.postMessage({ action: 'initGroup', data: groupUrl });
    }

    onWorkerInitGroup(groupUrl, satObjs) {
        const entities = new Set();
        satObjs.forEach(sat => {
            const et = new Entity(sat.name, sat.color);
            entities.add(et);
            this.scene.add(et);
        });
        this.map.set(groupUrl, {
            displayed: false,
            items: entities
        });
        this.displayGroup(groupUrl);
    }

    dispatchUpdate(t) {
        for (const group of this.map.keys()) {
            if (this.groupDisplayed(group)) {
                this.worker.postMessage({ action: 'updateSatelliteGroup', data: { group, t } });
            }
        }
    }

    onGroupUpdated(groupUrl, posBuffer, scaleBuffer, dataValidBuffer) {
        let i = 0;
        for (const et of this.getGroupItems(groupUrl)) {
            et.updatePosScale(posBuffer[i], scaleBuffer[i], dataValidBuffer[i]);
            i++;
        }
    }

    getGroupItems(name) {
        if (this.hasGroup(name)) {
            return this.map.get(name).items;
        } else {
            return new Set();
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

    displayGroup(name) {
        if (!this.groupDisplayed(name)) { 
            const entitiesToShow = this.getGroupItems(name);
            entitiesToShow.forEach(et => {
                this.scene.add(et.mesh);
            });
            this.map.get(name).displayed = true;
        }
    }

    hideGroup(name) {
        if (this.groupDisplayed(name)) {
            const entitiesToHide = this.getGroupItems(name);
            entitiesToHide.forEach(et => {
                this.scene.remove(et.mesh);
            });
            this.map.get(name).displayed = false;
        }   
    }
}
