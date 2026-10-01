// Clawd's brain: reacts to Claude Code hook events (forwarded by main.js) and,
// while Claude is quiet, idles according to the time of day.

const MINUTE = 60 * 1000;
const WORK_TIMEOUT = 5 * MINUTE;    // no hook event this long: treat Claude as idle
const NAP_AFTER = 20 * MINUTE;      // nothing happening this long: take a nap
const LATE_NAP_AFTER = 5 * MINUTE;  // after 22:00 Clawd gets sleepy sooner
const RECENTLY_BUSY = 30 * MINUTE;
const TRICK_MIN = 4 * MINUTE;
const TRICK_MAX = 8 * MINUTE;
const TICK = 15 * 1000;

const IDLE_TRICKS = ['juggling', 'sweeping', 'carrying', 'react-double-jump', 'idle-reading'];

// What Clawd does while a given Claude Code tool runs.
const TOOL_STATES = [
    [/^(Edit|MultiEdit|Write|NotebookEdit)$/, 'typing'],
    [/^(Read|Grep|Glob|LS)$/, 'idle-reading'],
    [/^(Task|Agent)$/, 'conducting'],
    [/^(WebFetch|WebSearch)$/, 'juggling'],
    [/^TodoWrite$/, 'sweeping'],
    [/^mcp__/, 'juggling'],
];
// Shell commands, classified by hooks/clawd-hook.js.
const SHELL_STATES = { git: 'carrying', test: 'debugger', build: 'building', install: 'building' };

const CLAUDE_LABELS = {
    thinking: 'Claude lagi mikir',
    typing: 'Claude lagi nulis kode',
    'idle-reading': 'Claude lagi baca file',
    conducting: 'Claude lagi ngatur subagent',
    juggling: 'Claude lagi multitasking',
    sweeping: 'Claude lagi beres-beres',
    carrying: 'Claude lagi ngurus git',
    debugger: 'Claude lagi ngetes',
    building: 'Claude lagi jalanin command',
    notification: 'Claude butuh jawaban kamu',
    error: 'Ada yang error!',
    happy: 'Claude selesai!',
    'react-double-jump': 'Halo!',
    'react-annoyed': 'Udah malam, istirahat gih',
};
const IDLE_LABELS = {
    idle: 'santai',
    'idle-reading': 'baca-baca santai',
    juggling: 'istirahat siang',
    sleeping: 'tidur',
};

let work = null;   // looping state while Claude is busy
let hold = null;   // state that waits for the user (permission prompt)
let lastActiveAt = Date.now();
let flashUntil = 0;
let flashTimer = null;
let lastReported = '';
let lastHour = new Date().getHours();
let lastLateNagHour = -1;
let nextTrickAt = Date.now() + randomBetween(TRICK_MIN, TRICK_MAX);

function randomBetween(min, max) {
    return min + Math.random() * (max - min);
}

function report(state, label) {
    const text = label || CLAUDE_LABELS[state] || IDLE_LABELS[state] || state;
    if (text === lastReported) return;
    lastReported = text;
    window.electronAPI.reportStatus({ state, label: text });
}

function idleState() {
    const hour = new Date().getHours();
    const quietFor = Date.now() - lastActiveAt;
    if (hour < 5 || quietFor > NAP_AFTER) return 'sleeping';
    if (hour >= 22) return quietFor > LATE_NAP_AFTER ? 'sleeping' : 'idle';
    if (hour === 12) return 'juggling';
    if (hour >= 18) return 'idle-reading';
    return 'idle';
}

function render() {
    if (Date.now() < flashUntil) return;
    if (hold) {
        pet.loop(hold);
        report(hold);
        return;
    }
    if (work && Date.now() - lastActiveAt < WORK_TIMEOUT) {
        pet.loop(work);
        report(work);
        return;
    }
    work = null;
    const state = idleState();
    pet.loop(state);
    report(state, IDLE_LABELS[state]);
}

// Play a one-off reaction, then fall back to whatever render() decides.
function flash(state, { times = 1, label } = {}) {
    if (!pet.has(state)) return;
    clearTimeout(flashTimer);
    pet.once(state);
    report(state, label);
    const ms = pet.duration(state) * times;
    flashUntil = Date.now() + ms;
    flashTimer = setTimeout(() => {
        flashUntil = 0;
        render();
    }, ms);
}

function toolState(tool, kind) {
    if (tool === 'Bash' || tool === 'PowerShell') return SHELL_STATES[kind] || 'building';
    const match = TOOL_STATES.find(([pattern]) => pattern.test(tool || ''));
    return match ? match[1] : 'typing';
}

// Map one Claude Code hook event to { work, hold, flash, times, label }.
function effectFor({ event, tool, kind, notification }) {
    switch (event) {
        case 'SessionStart': return { flash: 'react-double-jump', label: 'Halo! Sesi Claude baru' };
        case 'UserPromptSubmit': return { work: 'thinking' };
        case 'PreToolUse': return { work: toolState(tool, kind) };
        case 'SubagentStart': return { work: 'conducting' };
        case 'PreCompact': return { work: 'sweeping' };
        case 'PostToolUseFailure': return { flash: 'error', label: `${tool || 'Tool'} gagal` };
        case 'PermissionRequest': return { hold: 'notification' };
        case 'Notification':
            return ['permission_prompt', 'elicitation_dialog'].includes(notification)
                ? { hold: 'notification' }
                : { flash: 'notification', times: 2 };
        case 'Stop': return { work: null, flash: 'happy' };
        case 'StopFailure': return { work: null, flash: 'error', times: 3, label: 'Claude berhenti karena error' };
        case 'SessionEnd': return { work: null };
        default: return {};  // PostToolUse etc.: just "still busy"
    }
}

function onClaudeEvent(ev) {
    const effect = effectFor(ev);
    const wasAsleep = pet.current() === 'sleeping';
    lastActiveAt = Date.now();

    // Any progress after a permission prompt means the user answered it.
    if (ev.event !== 'Notification' && ev.event !== 'PermissionRequest') hold = null;
    if ('work' in effect) work = effect.work;
    if (effect.hold) hold = effect.hold;

    const hour = new Date().getHours();
    if (ev.event === 'UserPromptSubmit' && hour < 5 && lastLateNagHour !== hour) {
        lastLateNagHour = hour;
        flash('react-annoyed', { times: 2, label: `Udah jam ${hour} pagi, jangan begadang` });
    } else if (effect.flash) {
        flash(effect.flash, { times: effect.times, label: effect.label });
    } else if (wasAsleep) {
        flash('react-double-jump', { label: 'Kebangun! Ayo kerja' });
    } else {
        render();
    }
}

function onHourChange(hour) {
    const recentlyBusy = Date.now() - lastActiveAt < RECENTLY_BUSY;
    if (hour < 5) {
        if (recentlyBusy) flash('react-annoyed', { times: 2, label: `Udah jam ${hour}, tidur gih` });
        return;
    }
    if (work || hold) return;  // don't interrupt Claude's work for a chime
    if (hour === 6) flash('react-double-jump', { label: 'Selamat pagi!' });
    else if (hour === 12) flash('happy', { label: 'Waktunya makan siang' });
    else if (hour === 18) flash('sweeping', { label: 'Sore! Beres-beres dulu' });
    else if (hour === 22) flash('notification', { times: 2, label: 'Udah jam 10 malam' });
    else if (hour > 6 && hour < 22) flash('notification', { label: `Ting! Jam ${hour}` });
}

function onTick() {
    const hour = new Date().getHours();
    if (hour !== lastHour) {
        lastHour = hour;
        onHourChange(hour);
    }

    const free = !work && !hold && Date.now() >= flashUntil;
    if (free && Date.now() >= nextTrickAt) {
        nextTrickAt = Date.now() + randomBetween(TRICK_MIN, TRICK_MAX);
        if (idleState() !== 'sleeping') {
            const tricks = IDLE_TRICKS.filter((t) => t !== pet.current());
            flash(tricks[Math.floor(Math.random() * tricks.length)], { label: 'lagi main-main' });
        }
    }
    render();
}

window.electronAPI.onClaudeEvent(onClaudeEvent);
if (idleState() === 'sleeping') render();
else flash('react-double-jump', { label: 'Halo! Clawd siap nemenin' });
setInterval(onTick, TICK);
