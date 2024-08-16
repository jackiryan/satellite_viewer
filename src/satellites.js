import * as THREE from 'three';
import * as satellite from 'satellite.js';

const scaleFactor = 5 / 6378;

export class Entity extends THREE.Object3D {
    constructor(scene, name, attribs, color) {
        super();
        this.scene = scene;
        this.name = name;
        this.noradId = attribs.noradId;
        this.color = color;
        try {
            this.satrec = satellite.twoline2satrec(
                attribs.tleLine1,
                attribs.tleLine2
            );
        } catch (error) {
            console.error('There was a problem creating the satellite record:', error);
        }
        this.initMesh();
        this.destroyEvent = new CustomEvent('destroyEntity', { detail: this });
        this.displayed = false;
    }

    initMesh() {
        this.geometry = new THREE.IcosahedronGeometry(0.02);
        this.material = new THREE.MeshBasicMaterial({ color: this.color });
        this.mesh = new THREE.Mesh(this.geometry, this.material);
        this.mesh.name = this.name;
    }

    destroyMesh() {
        if (this.mesh) {
            this.scene.remove(this.mesh);
            this.mesh = null;
        }
    }

    updatePosition(t) {
        const deltaPosVel = satellite.propagate(this.satrec, t);
        try {
            const deltaPosEci = deltaPosVel.position;
            const deltaPos = new THREE.Vector3(
                deltaPosEci.x * scaleFactor,
                deltaPosEci.z * scaleFactor,
                -deltaPosEci.y * scaleFactor
            );
            this.mesh.position.copy(deltaPos);
            const newScale = Math.min(4.0, deltaPos.length() / 5.3);
            this.mesh.scale.copy(new THREE.Vector3(newScale, newScale, newScale));
        } catch (error) {
            console.log('Satellite', this.name, ' position unknown!');
            window.dispatchEvent(this.destroyEvent);
            this.hide();
            this.destroyMesh();
        }
    }

    display(t) {
        if (!this.displayed) {
            this.displayed = true;
            this.scene.add(this.mesh);
            this.updatePosition(t);
        }
    }

    hide() {
        if (this.displayed) {
            this.displayed = false;
            this.scene.remove(this.mesh);
        }
    }
}

export async function populateButtonGroup(defaultGroups) {
    const dbUrl = './groups/index.json';
    const response = await fetch(dbUrl);
    const satDb = await response.json();

    const buttonGroups = Object.keys(satDb).map(key => {
        return {
            name: key,
            country: satDb[key].country ? satDb[key].country.toLowerCase() : null,
            entitiesUrl: satDb[key].entities
        };
    });

    populateButtons(buttonGroups, defaultGroups);
}

function populateButtons(groups, defaultGroups) {
    const container = document.getElementsByClassName('button-container')[0];

    groups.forEach(group => {
        const button = document.createElement('div');
        button.className = 'toggle-button off'; // Default to 'off' state

        if (group.country) {
            const flag = document.createElement('img');
            flag.src = `https://flagcdn.com/w20/${group.country}.png`;
            flag.alt = `${group.country} flag`;
            button.appendChild(flag);
        }

        const textNode = document.createTextNode(group.name);
        button.appendChild(textNode);

        if (defaultGroups.has(group.name)) {
            toggleButtonState(button, group.entitiesUrl);
        }

        button.addEventListener('click', () => toggleButtonState(button, group.entitiesUrl));

        container.appendChild(button);
    });

    addButtonGroupGrab();
    addButtonGroupToggle();
    //document.body.appendChild(container);
}

async function toggleButtonState(button, entitiesUrl) {
    button.classList.toggle('on');
    button.classList.toggle('off');

    if (button.classList.contains('on')) {
        const displayEvent = new CustomEvent('displayGroup', { detail: entitiesUrl });
        window.dispatchEvent(displayEvent);
    } else {
        const hideEvent = new CustomEvent('hideGroup', { detail: entitiesUrl });
        window.dispatchEvent(hideEvent);
    }
}

export async function fetchEntities(entitiesUrl) {
    try {
        const response = await fetch(entitiesUrl);
        if (!response.ok) {
            throw new Error(`Network response was not ok: ${response.statusText}`);
        }
        const groupDb = await response.json();
        return groupDb;
    } catch (error) {
        console.error('Failed to fetch entity names:', error);
        return undefined;
    }
}


function addButtonGroupGrab() {
    const buttonContainer = document.querySelector('.button-container');

    let isDown = false;
    let startX;
    let scrollLeft;

    buttonContainer.addEventListener('mousedown', (e) => {
        isDown = true;
        buttonContainer.classList.add('active');
        startX = e.pageX - buttonContainer.offsetLeft;
        scrollLeft = buttonContainer.scrollLeft;
    });

    buttonContainer.addEventListener('mouseleave', () => {
        isDown = false;
        buttonContainer.classList.remove('active');
    });

    buttonContainer.addEventListener('mouseup', () => {
        isDown = false;
        buttonContainer.classList.remove('active');
    });

    buttonContainer.addEventListener('mousemove', (e) => {
        if (!isDown) return;
        e.preventDefault();
        const x = e.pageX - buttonContainer.offsetLeft;
        const walk = (x - startX) * 3; // scroll-fast
        buttonContainer.scrollLeft = scrollLeft - walk;
    });
}

function addButtonGroupToggle() {
    const buttonContainer = document.querySelector('.button-container');
    const toggleButton = document.querySelector('.toggle-button-container');
    const chevron = document.querySelector('.chevron');

    toggleButton.addEventListener('click', () => {
        buttonContainer.classList.toggle('hidden');
        if (buttonContainer.classList.contains('hidden')) {
            chevron.innerHTML = '&#9660;'; // Downward facing chevron
        } else {
            chevron.innerHTML = '&#9650;'; // Upward facing chevron
        }
    });
}