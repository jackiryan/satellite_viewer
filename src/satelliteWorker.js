
import * as satellite from 'satellite.js';

// global state for this thread that holds one entry for each initialized group
// see workerInitGroup for the layout of the object at each entry
let satelliteMap = new Map();
let started = false;
let speedFactor = 1.0;

// scaleRadius and scaleFactor must be updated if the radius of the earth object ever changes,
// will have to do for now since passing that state is annoying.
// radius at which scale is 1.0
const scaleRadius = 5.3;
const defaultScale = 0.02;
const scaleFactor = 5 / 6378;
// max amount scale is allowed to be
const maxScale = 4.0 * defaultScale;

// millis since start of Unix epoch at the time the worker is started, used to
// compute the elapsedTime
const startTime = new Date().getTime();
let oldTime = startTime;
let elapsedTime = 0.0;
const refreshRate = 60;

self.onmessage = function(e) {
    const { action, data } = e.data;

    switch(action) {
        case 'init':
            workerInitGroup(data);
            break;
        case 'display':
            workerDisplayGroup(data);
            break;
        case 'hide':
            workerHideGroup(data);
            break;
        case 'setSpeed':
            workerSetSpeed(data);
            break;
        case 'reset':
            resetTime();
    }
};

function workerInitGroup(data) {
    const { url, groupData, buffer } = data;
    // This is not the full instance Matrix, but merely a view to the 
    // instanceMatrix.array's buffer
    const dataString = new TextDecoder().decode(groupData);
    const groupDb = JSON.parse(dataString);
    const instanceMatrix = new Float32Array(buffer);
    //const groupDb = await fetchEntities(url);
    const groupAttribs = Object.values(groupDb.entities);
    
    //const names = Object.keys(groupDb.entities);
    const satRecs = groupAttribs.map((attribs) => initSatrec(attribs));
    satelliteMap.set(url, {
        displayed: true,
        count: satRecs.length,
        satrecs: satRecs,
        matrix: instanceMatrix
    });
    if (!started) {
        setInterval(() => {
            updatePositions();
        }, 1000 / refreshRate);
        started = true;
    }
    postMessage(url);
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

function updatePositions() {
    const newTime = Date.now();
    elapsedTime += (newTime - oldTime) * speedFactor;
    oldTime = newTime;
    const t = new Date(startTime + elapsedTime);
    for (const groupObj of satelliteMap.values()) {
        if (groupObj.displayed) {
            for (let i = 0; i < groupObj.count; i++) {
                if (groupObj.satrecs[i] === undefined) {
                    continue;
                }
                const instanceNdx = i * 16;
                
                try {
                    const deltaPosVel = satellite.propagate(groupObj.satrecs[i], t);
                    const deltaPosEci = deltaPosVel.position;
                    const deltaVelEci = deltaPosVel.velocity;
                    const newX = deltaPosEci.x * scaleFactor;
                    const newY = deltaPosEci.z * scaleFactor;
                    const newZ = -deltaPosEci.y * scaleFactor;
                    const newScale = Math.min(maxScale, defaultScale * mag([newX, newY, newZ]) / scaleRadius);
                    groupObj.matrix[instanceNdx +  0] = newScale;
                    groupObj.matrix[instanceNdx +  5] = newScale;
                    groupObj.matrix[instanceNdx + 10] = newScale;
                    groupObj.matrix[instanceNdx + 12] = newX;
                    groupObj.matrix[instanceNdx + 13] = newY;
                    groupObj.matrix[instanceNdx + 14] = newZ;
                } catch (error) {
                    if (groupObj.satrecs[i] !== undefined) {
                        console.log(`Satellite with NORAD ID ${groupObj.satrecs[i].satnum} has unknown position!`);
                        groupObj.satrecs[i] = undefined;
                    }
                    groupObj.matrix[instanceNdx + 12] = 0.0;
                    groupObj.matrix[instanceNdx + 13] = 0.0;
                    groupObj.matrix[instanceNdx + 14] = 0.0;
                }
            }
        }
    }
}

function mag(v) {
    return Math.sqrt(
        v[0] * v[0] + 
        v[1] * v[1] + 
        v[2] * v[2]
    );
}

function workerDisplayGroup(data) {
    satelliteMap.get(data.url).displayed = true;
}

function workerHideGroup(data) {
    satelliteMap.get(data.url).displayed = false;
}

function workerSetSpeed(data) {
    speedFactor = data.speed;
}

function resetTime(data) {
    speedFactor = 1;
    elapsedTime = Date.now() - startTime;
}