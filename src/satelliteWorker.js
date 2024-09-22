
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
//const defaultScale = 0.1;
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
    // If any satellites are unable to be instantiated, they will cause the
    // instance matrix to be too large. Because of the strange random positioning code
    // on the main thread, we will want to fill the excess area of the matrix with 0s.
    for (let i = satRecs.length * 16; i < instanceMatrix.length; i++) {
        instanceMatrix[i] = 0.0;
    }
    satelliteMap.set(url, {
        displayed: true,
        count: satRecs.length,
        satrecs: satRecs,
        matrix: instanceMatrix
    });
    // call update positions in a blocking way the first time around. This ensures
    // that the bounding sphere can be computed correctly on the main thread as soon
    // as the message is posted
    updatePositions();
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
                const instanceNdx = i * 16;
                if (groupObj.satrecs[i] === undefined) {
                    continue;
                }
                
                try {
                    const deltaPosVel = satellite.propagate(groupObj.satrecs[i], t);
                    const deltaPosEci = deltaPosVel.position;
                    const deltaVelEci = deltaPosVel.velocity;
                    const velocity =  [-deltaVelEci.x, -deltaVelEci.z, deltaVelEci.y];
                    const velMag = mag(velocity);
                    const velDir = [velocity[0] / velMag, velocity[1] / velMag, velocity[2] / velMag];
                    const xVelMag = Math.sqrt(velDir[2] * velDir[2] + velDir[0] * velDir[0]);
                    const xVelDir = [-velDir[2] / xVelMag, 0.0, velDir[0] / xVelMag];
                    const yVelDir = [-xVelDir[2] * velDir[1], xVelDir[2] * velDir[0] - xVelDir[0] * velDir[2], xVelDir[0] * velDir[1]];
                    const newX = deltaPosEci.x * scaleFactor;
                    const newY = deltaPosEci.z * scaleFactor;
                    const newZ = -deltaPosEci.y * scaleFactor;
                    const newScale = Math.min(maxScale, defaultScale * mag([newX, newY, newZ]) / scaleRadius);
                    groupObj.matrix[instanceNdx +  0] = xVelDir[0] * newScale;
                    groupObj.matrix[instanceNdx +  1] = xVelDir[1];
                    groupObj.matrix[instanceNdx +  2] = xVelDir[2] * newScale;
                    groupObj.matrix[instanceNdx +  4] = yVelDir[0] * newScale;
                    groupObj.matrix[instanceNdx +  5] = yVelDir[1] * newScale;
                    groupObj.matrix[instanceNdx +  6] = yVelDir[2] * newScale;
                    groupObj.matrix[instanceNdx +  8] = velDir[0] * newScale;
                    groupObj.matrix[instanceNdx +  9] = velDir[1] * newScale;
                    groupObj.matrix[instanceNdx + 10] = velDir[2] * newScale;
                    groupObj.matrix[instanceNdx + 12] = newX;
                    groupObj.matrix[instanceNdx + 13] = newY;
                    groupObj.matrix[instanceNdx + 14] = newZ;
                } catch (error) {
                    if (groupObj.satrecs[i] !== undefined) {
                        console.log(`Satellite with NORAD ID ${groupObj.satrecs[i].satnum} has unknown position!`);
                        groupObj.satrecs[i] = undefined;
                    }
                    groupObj.matrix[instanceNdx +  0] = 0.0;
                    groupObj.matrix[instanceNdx +  1] = 0.0;
                    groupObj.matrix[instanceNdx +  2] = 0.0;
                    groupObj.matrix[instanceNdx +  4] = 0.0;
                    groupObj.matrix[instanceNdx +  5] = 0.0;
                    groupObj.matrix[instanceNdx +  6] = 0.0;
                    groupObj.matrix[instanceNdx +  8] = 0.0;
                    groupObj.matrix[instanceNdx +  9] = 0.0;
                    groupObj.matrix[instanceNdx + 10] = 0.0;
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