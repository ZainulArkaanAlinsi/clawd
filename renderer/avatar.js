const rawGifs = window.electronAPI.getGifs();

// "clawd-idle-reading.gif" -> state "idle-reading"
const STATES = {};
const DURATIONS = {};
rawGifs.forEach(({ name, duration }) => {
    const key = name.replace('.gif', '').replace(/^clawd-/, '');
    STATES[key] = `../assets/gif/${name}`;
    DURATIONS[key] = duration;
});

const petImg = document.getElementById('pet-img');

let currentState = '';
let playCount = 0;

window.pet = {
    has: (state) => state in STATES,
    duration: (state) => DURATIONS[state] || 1000,
    current: () => currentState,

    // Loop a state. Asking for the state already shown is a no-op, so the GIF
    // keeps running instead of restarting.
    loop(state) {
        if (!STATES[state] || state === currentState) return;
        currentState = state;
        petImg.src = STATES[state];
    },

    // Play a state from its first frame (the query string forces a restart).
    once(state) {
        if (!STATES[state]) return;
        currentState = state;
        petImg.src = `${STATES[state]}?play=${++playCount}`;
    },
};
