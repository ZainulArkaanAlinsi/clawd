// Mouse gestures on the pet window, passed on to behavior.js (window.clawd):
// click (left/right half), double click, many clicks, petting (stroking the
// cursor back and forth), hovering, dragging and the right-click menu.
// The drag itself is done by main.js, which moves the window with the cursor;
// a CSS app-region drag would swallow every click.

(() => {
    const api = window.electronAPI;
    const root = document.documentElement;

    const DRAG_THRESHOLD = 4;      // px the cursor moves before a press becomes a drag
    const CLICK_GAP = 280;         // ms to wait for a second click
    const DIZZY_CLICKS = 5;        // this many clicks ...
    const DIZZY_WINDOW = 2000;     // ... within this many ms make Clawd dizzy
    const PET_SWINGS = 4;          // back-and-forth turns of the cursor ...
    const PET_WINDOW = 1500;       // ... within this many ms count as petting
    const PET_COOLDOWN = 4000;
    const HOVER_COOLDOWN = 30000;

    let press = null;       // screen position where the left button went down
    let held = false;       // the window is being dragged
    let clicks = 0;
    let clickSide = 'right';
    let clickTimer = null;
    let recentClicks = [];
    let lastX = null;
    let lastDir = 0;
    let swings = [];
    let lastPetAt = 0;
    let lastHoverAt = 0;

    // Ends a press; resolves true when it was a drag (so not a click).
    async function release() {
        const wasHeld = held;
        press = null;
        held = false;
        document.body.classList.remove('held');
        if (wasHeld) window.clawd.drop((await api.dragEnd()) || {});
        return wasHeld;
    }

    function registerClick(e) {
        const now = Date.now();
        recentClicks = recentClicks.filter((t) => now - t < DIZZY_WINDOW).concat(now);
        clearTimeout(clickTimer);
        if (recentClicks.length >= DIZZY_CLICKS) {
            recentClicks = [];
            clicks = 0;
            window.clawd.dizzy();
            return;
        }
        clicks += 1;
        clickSide = e.clientX < window.innerWidth / 2 ? 'left' : 'right';
        clickTimer = setTimeout(() => {
            const count = clicks;
            clicks = 0;
            if (count >= 2) window.clawd.doubleClick();
            else window.clawd.click(clickSide);
        }, CLICK_GAP);
    }

    function trackPetting(e) {
        if (lastX === null) {
            lastX = e.screenX;
            return;
        }
        const dx = e.screenX - lastX;
        lastX = e.screenX;
        if (Math.abs(dx) < 2) return;
        const dir = Math.sign(dx);
        const now = Date.now();
        if (lastDir && dir !== lastDir) swings = swings.filter((t) => now - t < PET_WINDOW).concat(now);
        lastDir = dir;
        if (swings.length >= PET_SWINGS && now - lastPetAt > PET_COOLDOWN) {
            swings = [];
            lastPetAt = now;
            window.clawd.pet();
        }
    }

    root.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        press = { x: e.screenX, y: e.screenY };
        root.setPointerCapture(e.pointerId);
    });

    root.addEventListener('pointermove', (e) => {
        if (press && !held) {
            if (Math.hypot(e.screenX - press.x, e.screenY - press.y) < DRAG_THRESHOLD) return;
            held = true;
            document.body.classList.add('held');
            api.dragStart();
            window.clawd.dragStart();
            return;
        }
        if (!press && e.buttons === 0) trackPetting(e);
    });

    root.addEventListener('pointerup', async (e) => {
        if (e.button !== 0 || !press) return;
        if (!(await release())) registerClick(e);
    });

    // The press ended somewhere we can't see (e.g. another window took the mouse).
    root.addEventListener('pointercancel', () => { if (press) release(); });
    window.addEventListener('blur', () => { if (held) release(); });

    root.addEventListener('pointerenter', () => {
        lastX = null;
        lastDir = 0;
        swings = [];
        const now = Date.now();
        if (!press && now - lastHoverAt > HOVER_COOLDOWN) {
            lastHoverAt = now;
            window.clawd.hover();
        }
    });

    window.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        api.showMenu(window.clawd.menuContext());
    });
})();
