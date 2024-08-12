import { Entity, fetchEntities } from './satellites.js';

export class EntityGroupMap {
    constructor() {
        this.map = new Map();
    }

    getGroup(name) {
        return this.map[name];
    }

    getGroupItems(name) {
        return this.map[name]['items'];
    }

    hasGroup(name) {
        return this.map.hasOwnProperty(name);
    }

    groupHasItem(group, item) {
        return this.getGroupItems(group).has(item);
    }

    hasItem(item) {
        for (const group in this.map) {
            if (this.groupHasItem(group, item)) {
                return true;
            }
        }
        return false;
    }

    groupDisplayed(name) {
        return this.getGroup(name)["displayed"];
    }

    deleteMember(item) {
        for (const group in this.map) {
            this.getGroupItems(group).delete(item);
        }
    }

    async initGroup(scene, uri, t) {
        const groupDb = await fetchEntities(uri);
    
        if (groupDb && groupDb.entities) {
            const groupData = Object.entries(groupDb.entities);
            const entities = new Set();
    
            groupData.forEach(([key, et]) => {
                let bColor = groupDb.baseColor || et.entityColor || colorMap();
                const entity = new Entity(scene, key, et, bColor);
                entities.add(entity);
            });
    
            this.map[uri] = {
                'displayed': true,
                'items': entities
            }
            this.displayGroup(uri, t);
        } else {
            console.error('Failed to add group: groupDb is undefined or does not contain entities');
        }
    }

    removeGroup(name) {
        this.map.delete(name);
    }

    hideGroup(name) {
        const entitiesToHide = this.map[name]['items'];
        entitiesToHide.forEach(et => {
            et.hide();
        });
        this.map[name]['displayed'] = false;
    }

    displayGroup(name, t) {
        const entitiesToShow = this.map[name]['items'];
        entitiesToShow.forEach(et => {
            et.display(t);
        });
        this.map[name]['displayed'] = true;
    }

    update(t) {
        for (const group in this.map) {
            if (this.groupDisplayed(group)) {
                this.getGroupItems(group).forEach(et => {
                    et.updatePosition(t);
                });
            }
        }
    }
}

function colorMap() {
    return '#1b1bf9';
}