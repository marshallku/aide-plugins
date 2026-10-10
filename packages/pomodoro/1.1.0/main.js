// Minutes come from the plugin's settings (Settings › On this device › Pomodoro).
let FOCUS = 25 * 60;
let BREAK = 5 * 60;
const minutes = (value, fallback) => (Number.isFinite(value) && value > 0 && value <= 240 ? Math.round(value * 60) : fallback);

const state = { mode: "focus", left: FOCUS, running: false, endsAt: 0, done: {} };
let ticker = null;

const today = () => new Date().toISOString().slice(0, 10);
const clock = (seconds) =>
    `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;

const draw = () => {
    const total = state.mode === "focus" ? FOCUS : BREAK;
    aide.render({
        type: "VStack",
        children: [
            { type: "Text", text: state.mode === "focus" ? "Focus" : "Break", style: "headline" },
            { type: "Text", key: "clock", text: clock(state.left), style: "largeTitle" },
            { type: "Progress", value: total - state.left, total },
            {
                type: "HStack",
                children: [
                    state.running
                        ? { type: "Button", title: "Pause", action: "pause" }
                        : { type: "Button", title: "Start", action: "start", style: "prominent" },
                    { type: "Button", title: "Reset", action: "reset" },
                    { type: "Button", title: "Skip", action: "skip" },
                ],
            },
            { type: "Divider" },
            { type: "Text", key: "count", text: `Sessions today: ${state.done[today()] || 0}`, style: "caption" },
        ],
    });
};

const save = () => aide.call("storage.set", { value: { done: state.done } }).catch(() => {});

const finish = () => {
    if (state.mode === "focus") {
        state.done[today()] = (state.done[today()] || 0) + 1;
        save();
    }
    state.mode = state.mode === "focus" ? "break" : "focus";
    state.left = state.mode === "focus" ? FOCUS : BREAK;
    state.running = false;
    clearInterval(ticker);
};

const tick = () => {
    state.left = Math.max(0, Math.round((state.endsAt - Date.now()) / 1000));
    if (state.left === 0) finish();
    draw();
};

aide.onAction = (action) => {
    if (action === "start") {
        state.running = true;
        state.endsAt = Date.now() + state.left * 1000;
        clearInterval(ticker);
        ticker = setInterval(tick, 1000);
    } else if (action === "pause") {
        state.running = false;
        clearInterval(ticker);
    } else if (action === "reset") {
        state.running = false;
        clearInterval(ticker);
        state.left = state.mode === "focus" ? FOCUS : BREAK;
    } else if (action === "skip") {
        finish();
    }
    draw();
};

Promise.all([aide.call("settings.get").catch(() => ({})), aide.call("storage.get").catch(() => null)])
    .then(([settings, stored]) => {
        FOCUS = minutes(settings.focusMinutes, FOCUS);
        BREAK = minutes(settings.breakMinutes, BREAK);
        state.left = FOCUS;
        if (stored && stored.done) state.done = stored.done;
    })
    .finally(draw);
