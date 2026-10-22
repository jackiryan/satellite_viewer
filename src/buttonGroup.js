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

// Narrow screens: the "Groups" button that replaces the strip, and the drawer it opens
// (see the "Group drawer" section of main.css)
const groupToggle = document.getElementById('group-toggle');
const groupCountBadge = document.getElementById('group-count');
const groupDrawer = document.getElementById('group-drawer');
const groupSummary = document.getElementById('group-summary');
const drawerBackdrop = document.getElementById('group-drawer-backdrop');
const drawerClose = document.getElementById('group-drawer-close');

// Same as the default material in satelliteGroupMap.js, used for groups without a baseColor
const defaultGroupColor = '#c4a484';

// Sizes of the images in static/flags. Giving each <img> its size up front reserves its space,
// so the buttons don't shift sideways when the flags arrive (a layout shift that Lighthouse
// counts against the page). Flags not listed here get the most common size.
const flagSizes = {
    ca: [20, 10],
    cn: [20, 13],
    eu: [20, 13],
    gb: [20, 10],
    jp: [20, 13],
    lu: [20, 12],
    planet: [22, 22],
    ru: [20, 13],
    us: [20, 11]
};
const defaultFlagSize = [20, 13];


export async function populateButtonGroup(defaultGroups) {
    const baseUrl = window.location.origin;
    const dbUrl = `${baseUrl}/groups/index.json`;
    const response = await fetch(dbUrl);
    const satDb = await response.json();

    const buttonGroups = Object.keys(satDb).map(key => {
        return {
            name: key,
            country: satDb[key].country ? satDb[key].country.toLowerCase() : null,
            entitiesUrl: satDb[key].entities,
            color: satDb[key].baseColor ?? defaultGroupColor,
            count: satDb[key].count
        };
    });

    populateButtons(buttonGroups, defaultGroups);
    initGroupDrawer();
    checkOverflow();
}

function populateButtons(groups, defaultGroups) {
    const container = document.querySelector('.button-flex');

    groups.forEach(group => {
        const button = document.createElement('div');
        button.className = 'toggle-button off'; // Default to 'off' state
        button.setAttribute('role', 'button');
        button.setAttribute('aria-pressed', 'false');
        button.tabIndex = 0;

        // The color swatch and satellite count are only displayed in the drawer
        const swatch = document.createElement('span');
        swatch.className = 'group-swatch';
        swatch.style.backgroundColor = group.color;
        button.appendChild(swatch);

        if (group.country) {
            const flag = document.createElement('img');
            [flag.width, flag.height] = flagSizes[group.country] ?? defaultFlagSize;
            flag.src = `./flags/${group.country}.png`;
            flag.alt = `${group.country} flag`;
            button.appendChild(flag);
        }

        const name = document.createElement('span');
        name.className = 'group-name';
        name.textContent = group.name;
        button.appendChild(name);

        if (Number.isFinite(group.count)) {
            const count = document.createElement('span');
            count.className = 'group-count';
            count.textContent = group.count.toLocaleString('en-US');
            count.title = `${count.textContent} satellites`;
            button.appendChild(count);
        }

        button.addEventListener('click', () => toggleButtonState(button, group.entitiesUrl));
        button.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                toggleButtonState(button, group.entitiesUrl);
            }
        });

        container.appendChild(button);

        if (defaultGroups.has(group.name)) {
            toggleButtonState(button, group.entitiesUrl);
        }
    });
    updateGroupCount();

    addButtonGroupGrab();
    addOverflowBehavior();
}

async function toggleButtonState(button, entitiesUrl) {
    setButtonState(button, !button.classList.contains('on'));

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
    button.setAttribute('aria-pressed', String(state));
    updateGroupCount();
}

// Show how many groups are on, on the "Groups" button and at the top of the drawer
function updateGroupCount() {
    const total = buttonContainer.querySelectorAll('.toggle-button').length;
    const shown = buttonContainer.querySelectorAll('.toggle-button.on').length;
    groupCountBadge.textContent = String(shown);
    groupCountBadge.classList.toggle('none', shown === 0);
    groupSummary.textContent = `${shown} of ${total} shown`;
    groupToggle.setAttribute('aria-label', `Satellite groups, ${shown} of ${total} shown`);
}

/* Group drawer (narrow screens) */
function isDrawerMode() {
    // main.css only displays the "Groups" button below its breakpoint
    return window.getComputedStyle(groupToggle).display !== 'none';
}

function isGroupDrawerOpen() {
    return groupDrawer.classList.contains('open');
}

function setGroupDrawerOpen(open) {
    if (open === isGroupDrawerOpen()) {
        return;
    }
    groupDrawer.classList.toggle('open', open);
    drawerBackdrop.classList.toggle('open', open);
    groupToggle.setAttribute('aria-expanded', String(open));

    if (open) {
        // lets viewer.js close the settings menu, which the drawer would cover
        window.dispatchEvent(new CustomEvent('groupDrawerOpened'));
    } else if (groupDrawer.contains(document.activeElement)) {
        // the drawer is about to become invisible, so don't leave keyboard focus in it
        groupToggle.focus();
    }
}

function initGroupDrawer() {
    groupToggle.disabled = false;
    groupToggle.addEventListener('click', () => setGroupDrawerOpen(!isGroupDrawerOpen()));
    drawerBackdrop.addEventListener('click', () => setGroupDrawerOpen(false));
    drawerClose.addEventListener('click', () => setGroupDrawerOpen(false));
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            setGroupDrawerOpen(false);
        }
    });
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
    if (isDrawerMode()) {
        navarrowLeft.style.display = 'none';
        navarrowRight.style.display = 'none';
        return;
    }
    // The drawer isn't shown on wide screens, so don't leave it open for the next
    // time the window gets narrow
    setGroupDrawerOpen(false);

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

