
import * as satellite from 'satellite.js';

let satelliteMap = new Map();

// radius at which scale is 1.0
const scaleRadius = 5.3;
const scaleFactor = 5 / 6378;
// max amount scale is allowed to be
const maxScale = 4.0;

self.onmessage = async function(e) {
    const { action, data } = e.data;

    switch(action) {
        case 'initGroup':
            await initGroup(data);
            break;
        case 'updateSatelliteGroup':
            const { group, t } = data;
            updateSatelliteGroup(group, t);
            break;
    }
};

async function initGroup(groupUrl) {
    const groupDb = await fetchEntities(groupUrl);
    const groupData = Object.entries(groupDb.entities);
        
    const satObjs = new Set();
        
    groupData.forEach(([key, attribs]) => {
        const satrec = initSatrec(attribs);
        if (satrec !== undefined) {
            satObjs.add({
                name: key,
                satrec: satrec,
                color: attribs.entityColor || groupDb.baseColor || colorMap()
            });
        }
    });

    satelliteMap.set(groupUrl, satObjs);
    postMessage({ messageType: 'groupInitialized', result: { groupUrl, satObjs } });
}

function updateSatelliteGroup(groupUrl, t) {
    const nSats = satelliteMap.get(groupUrl).size;
    const satIterator = satelliteMap.get(groupUrl).values();
    let posBuffer = new Array(nSats);
    let scaleBuffer = new Float32Array(nSats);
    let dataValidBuffer = new Float32Array(nSats);
    let satResult = satIterator.next();
    for (let i = 0; i < nSats; i++) {
        const sat = satResult.value; 
        
        const { pos, scale, dataValid } = updateSatPos(sat.satrec, t);
        posBuffer[i] = pos;
        scaleBuffer[i] = scale;
        dataValidBuffer[i] = dataValid;

        satResult = satIterator.next();
    }
    postMessage({ messageType: 'satGroupUpdated', result: { groupUrl, posBuffer, scaleBuffer, dataValidBuffer } });
}

function initSatrec(satAttribs) {
    try {
        const satrec = satellite.twoline2satrec(
            satAttribs.tleLine1,
            satAttribs.tleLine2
        );
        return satrec;
    } catch (error) {
        console.error('There was a problem creating the satellite record:', error);
        return undefined;
    }
}

function updateSatPos(satrec, t) {
    const posObj = {
        pos: new Float32Array(3),
        scale: 1.0,
        dataValid: true
    }

    const deltaPosVel = satellite.propagate(satrec, t);
    try {
        const deltaPosEci = deltaPosVel.position;
        posObj.pos[0] =  deltaPosEci.x * scaleFactor;
        posObj.pos[1] =  deltaPosEci.z * scaleFactor;
        posObj.pos[2] = -deltaPosEci.y * scaleFactor;
        const deltaScale = Math.min(maxScale, mag(posObj.pos) / scaleRadius);

        posObj.scale = deltaScale;
        posObj.dataValid = true;
    } catch (error) {
        posObj.dataValid = false;
    }

    return posObj;
}

function mag(v) {
    return Math.sqrt(
        v[0] * v[0] + 
        v[1] * v[1] + 
        v[2] * v[2]
    );
}

async function fetchEntities(entitiesUrl) {
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

function colorMap() {
    return '#1b1bf9';
}
