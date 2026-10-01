// Clawd's brain. Each pet follows one of two things:
//  - a Claude Code session (meta.claude): reacts to hook events from main.js;
//  - otherwise the laptop itself: user away/back, CPU, RAM, network, battery.
// Whenever nothing is going on, it idles according to the time of day.

const MINUTE = 60 * 1000;
const WORK_TIMEOUT = 5 * MINUTE;    // no hook event this long: treat Claude as idle
const NAP_AFTER = 20 * MINUTE;      // nothing happening this long: take a nap
const LATE_NAP_AFTER = 5 * MINUTE;  // after 22:00 Clawd gets sleepy sooner
const RECENTLY_BUSY = 30 * MINUTE;
const TRICK_MIN = 4 * MINUTE;
const TRICK_MAX = 8 * MINUTE;
const TICK = 15 * 1000;

const AWAY_AFTER_SECONDS = 5 * 60;  // no keyboard/mouse input this long: user is away
const CPU_BUSY = 85;                // percent, two samples in a row
const MEMORY_FULL = 90;             // percent
const BATTERY_LOW = 0.2;
const BATTERY_CRITICAL = 0.1;
const BATTERY_NAG_EVERY = { low: 15 * MINUTE, critical: 5 * MINUTE };

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

const badge = document.getElementById('badge');

let claudeMode = false;  // this pet follows a Claude Code session
let petNumber = 1;
let work = null;         // looping state while Claude is busy
let hold = null;         // state that waits for the user (permission prompt)
let lastActiveAt = Date.now();
let flashUntil = 0;
let flashTimer = null;
let lastReported = '';
let lastHour = new Date().getHours();
let lastLateNagHour = -1;
let nextTrickAt = Date.now() + randomBetween(TRICK_MIN, TRICK_MAX);

let system = { cpu: 0, memory: 0, idleSeconds: 0 };
let busySamples = 0;
let userAway = false;
let online = navigator.onLine;
let battery = null;
let lastBatteryNagAt = 0;

function randomBetween(min, max) {
    return min + Math.random() * (max - min);
}

// Laptop-wide alerts come from pet #1 only, so several pets don't chorus.
const isHomePet = () => petNumber === 1;

function report(state, label) {
    const text = label || CLAUDE_LABELS[state] || state;
    if (text === lastReported) return;
    lastReported = text;
    window.electronAPI.reportStatus({ state, label: text });
}

function idleState() {
    const hour = new Date().getHours();
    if (userAway) return { state: 'sleeping', label: 'Nungguin kamu balik' };
    if (!claudeMode) {
        if (!online) return { state: 'react-annoyed', label: 'Internet putus' };
        if (busySamples >= 2) return { state: 'building', label: `Laptop kerja keras (CPU ${system.cpu}%)` };
        if (system.memory >= MEMORY_FULL) return { state: 'carrying', label: `RAM hampir penuh (${system.memory}%)` };
    }
    const quietFor = claudeMode ? Date.now() - lastActiveAt : system.idleSeconds * 1000;
    if (hour < 5) return { state: 'sleeping', label: 'tidur' };
    if (quietFor > NAP_AFTER) return { state: 'sleeping', label: 'ketiduran' };
    if (hour >= 22) {
        return quietFor > LATE_NAP_AFTER
            ? { state: 'sleeping', label: 'ngantuk, tidur duluan' }
            : { state: 'idle', label: 'santai malam' };
    }
    if (hour === 12) return { state: 'juggling', label: 'istirahat siang' };
    if (hour >= 18) return { state: 'idle-reading', label: 'baca-baca santai' };
    return { state: 'idle', label: claudeMode ? 'nunggu perintah' : 'jagain laptop' };
}

function render() {
    if (Date.now() < flashUntil) return;
    if (claudeMode && hold) {
        pet.loop(hold);
        report(hold);
        return;
    }
    if (claudeMode && work && Date.now() - lastActiveAt < WORK_TIMEOUT) {
        pet.loop(work);
        report(work);
        return;
    }
    work = null;
    const { state, label } = idleState();
    pet.loop(state);
    report(state, label);
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

// --- Claude Code ---------------------------------------------------------------

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

function applyMeta(meta) {
    if (!meta) return;
    petNumber = meta.number;
    badge.textContent = meta.number;
    badge.classList.toggle('show', meta.total > 1);
    if (meta.claude === claudeMode) return;
    claudeMode = meta.claude;
    work = null;
    hold = null;
    if (claudeMode) render();
    else flash('sweeping', { label: 'Claude ditutup, balik jagain laptop' });
}

// --- the laptop ----------------------------------------------------------------

function onSample(sample) {
    system = sample;
    busySamples = sample.cpu >= CPU_BUSY ? busySamples + 1 : 0;
    const away = sample.idleSeconds >= AWAY_AFTER_SECONDS;
    if (userAway && !away) {
        userAway = false;
        flash('react-double-jump', { label: 'Selamat datang balik!' });
        return;
    }
    userAway = away;
    render();
}

function onSystemEvent(message) {
    switch (message.type) {
        case 'sample':
            onSample(message);
            break;
        case 'resume':
        case 'unlock-screen':
            userAway = false;
            flash('react-double-jump', { label: 'Halo lagi!' });
            break;
        case 'on-ac':
            lastBatteryNagAt = 0;
            if (isHomePet()) flash('happy', { label: 'Ngecas, makasih!' });
            break;
        case 'on-battery':
            if (isHomePet()) flash('notification', { label: 'Sekarang pakai baterai' });
            break;
        default:
            break;  // suspend / lock-screen: nobody is looking
    }
}

function checkBattery() {
    if (!battery || battery.charging || !isHomePet()) return;
    const level = battery.level;
    const kind = level <= BATTERY_CRITICAL ? 'critical' : level <= BATTERY_LOW ? 'low' : null;
    if (!kind || Date.now() - lastBatteryNagAt < BATTERY_NAG_EVERY[kind]) return;
    lastBatteryNagAt = Date.now();
    const percent = Math.round(level * 100);
    if (kind === 'critical') flash('error', { times: 3, label: `Baterai ${percent}%! Colokin charger sekarang` });
    else flash('react-annoyed', { times: 2, label: `Baterai tinggal ${percent}%` });
}

window.addEventListener('offline', () => {
    online = false;
    if (isHomePet()) flash('error', { label: 'Internet putus' });
});
window.addEventListener('online', () => {
    online = true;
    if (isHomePet()) flash('happy', { label: 'Internet nyambung lagi' });
});

if (navigator.getBattery) {
    navigator.getBattery().then((b) => {
        battery = b;
        b.addEventListener('levelchange', checkBattery);
        b.addEventListener('chargingchange', () => { lastBatteryNagAt = 0; });
        checkBattery();
    }).catch(() => {});
}

// --- clock ---------------------------------------------------------------------

function onHourChange(hour) {
    const recentlyBusy = claudeMode && Date.now() - lastActiveAt < RECENTLY_BUSY;
    if (hour < 5) {
        if (recentlyBusy) flash('react-annoyed', { times: 2, label: `Udah jam ${hour}, tidur gih` });
        return;
    }
    if (work || hold || userAway) return;  // don't interrupt work or a nap for a chime
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
    checkBattery();

    const free = !work && !hold && Date.now() >= flashUntil;
    if (free && Date.now() >= nextTrickAt) {
        nextTrickAt = Date.now() + randomBetween(TRICK_MIN, TRICK_MAX);
        if (idleState().state === 'idle') {
            const tricks = IDLE_TRICKS.filter((t) => t !== pet.current());
            flash(tricks[Math.floor(Math.random() * tricks.length)], { label: 'lagi main-main' });
        }
    }
    render();
}

window.electronAPI.onClaudeEvent(onClaudeEvent);
window.electronAPI.onSystemEvent(onSystemEvent);
window.electronAPI.onMeta(applyMeta);
window.electronAPI.getMeta().then(applyMeta);
if (idleState().state === 'sleeping') render();
else flash('react-double-jump', { label: 'Halo! Clawd siap nemenin' });
setInterval(onTick, TICK);
