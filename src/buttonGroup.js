const buttonContainer = document.querySelector('.button-flex');
const computedStyle = window.getComputedStyle(buttonContainer);
const paddingLeft = parseInt(computedStyle.getPropertyValue('padding-left'), 10);
const paddingRight = parseInt(computedStyle.getPropertyValue('padding-right'), 10);
// these are the div containers that encapsulate the inline svg buttons
const navarrowLeft = document.getElementById('navarrow-left');
const navarrowRight = document.getElementById('navarrow-right');
// these are the actual inline svg elements that are user clickable
const arrowIconLeft = document.getElementById('arrowicon-left');
const arrowIconRight = document.getElementById('arrowicon-right');


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
    checkOverflow();
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
    addOverflowBehavior();
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

export function setButtonState(button, state) {
    if (state) {
        button.classList.add('on');
        button.classList.remove('off');
    } else {
        button.classList.remove('on');
        button.classList.add('off');
    }
}

function addButtonGroupGrab() {
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

    buttonContainer.addEventListener('scroll', checkScrolled);
}

function addOverflowBehavior() {

    window.addEventListener('load', checkOverflow);
    window.addEventListener('resize', checkOverflow);
    navarrowLeft.addEventListener('click', () => scrollToNextChild('left'));
    navarrowRight.addEventListener('click', () => scrollToNextChild('right'));
}

function checkOverflow() {
    // hard-coding this to the same value used in the CSS
    if (window.innerWidth < 600) {
        navarrowLeft.style.display = 'none';
        navarrowRight.style.display = 'none';
        return;
    }

    if (buttonContainer.scrollWidth > buttonContainer.clientWidth) {
        navarrowLeft.style.display = 'block';
        navarrowRight.style.display = 'block';
        checkScrolled();
    } else {
        navarrowLeft.style.display = 'none';
        navarrowRight.style.display = 'none';
    }
}

function checkScrolled() {
    const maxScrollLeft = buttonContainer.scrollWidth - buttonContainer.clientWidth;
    arrowIconLeft.classList.remove('off');
    arrowIconRight.classList.remove('off');
    if (buttonContainer.scrollLeft === 0) {
        arrowIconLeft.classList.add('off');
    } else if (buttonContainer.scrollLeft === maxScrollLeft) {
        arrowIconRight.classList.add('off');
    }
}

function scrollToNextChild(direction) {
    const children = Array.from(buttonContainer.children);

    if (direction === 'right') {
        for (let i = 0; i < children.length; i++) {
            const childLeftEdge = children[i].offsetLeft - buttonContainer.offsetLeft;
            const childRightEdge = childLeftEdge + children[i].offsetWidth + paddingRight;
            const containerRightEdge = buttonContainer.scrollLeft + buttonContainer.offsetWidth;

            if (childRightEdge > containerRightEdge) {
                // I think + 2 is needed to account for borders or some such
                const newScrollLeft = buttonContainer.scrollLeft + childRightEdge + (paddingLeft + 2) - containerRightEdge;
                // This was very annoying to figure out... need to de-jank eventually
                buttonContainer.scrollTo({
                    left: newScrollLeft,
                    behavior: 'smooth'
                });
                break;
            }
        }
    } else if (direction === 'left') {
        for (let i = children.length - 1; i >= 0; i--) {
            const childLeftEdge = children[i].offsetLeft - buttonContainer.offsetLeft - paddingLeft;

            if (childLeftEdge < buttonContainer.scrollLeft) {
                buttonContainer.scrollTo({
                    left: childLeftEdge,
                    behavior: 'smooth'
                });
                break;
            }
        }
    }
}

