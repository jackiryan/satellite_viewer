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
    const container = document.querySelector('.button-flex');

    groups.forEach(group => {
        const button = document.createElement('div');
        button.className = 'toggle-button off'; // Default to 'off' state

        if (group.country) {
            const flag = document.createElement('img');
            flag.src = `./flags/${group.country}.png`;
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

function addButtonGroupGrab() {
    const buttonContainer = document.querySelector('.button-flex');
    const navarrowLeft = document.getElementById('arrow_left');
    const navarrowRight = document.getElementById('arrow_right');

    let isDown = false;
    let startX;
    let scrollLeft;

    buttonContainer.addEventListener('mousedown', (e) => {
        isDown = true;
        buttonContainer.classList.add('active');
        startX = e.clientX;
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
        if (!isDown) {
            return;
        }
        e.preventDefault();
        const x = e.clientX;
        // 2x scroll speed
        const walk = (x - startX) * 2; 
        buttonContainer.scrollLeft = scrollLeft - walk;
    });

    buttonContainer.addEventListener('scroll', () => {
        const maxScrollLeft = buttonContainer.scrollWidth - buttonContainer.clientWidth;
        navarrowLeft.classList.remove('off');
        navarrowRight.classList.remove('off');
        if (buttonContainer.scrollLeft === 0) {
            navarrowLeft.classList.add('off');
        } else if (buttonContainer.scrollLeft === maxScrollLeft) {
            navarrowRight.classList.add('off');
        }
    });
}
