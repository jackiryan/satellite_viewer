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
