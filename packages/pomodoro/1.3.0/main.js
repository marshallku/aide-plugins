// The app's aide.t (i18n/README.md › Plugins); an older app has none, and the English shows.
const t = (key, ...args) => {
    if (typeof aide.t === "function") return aide.t(key, ...args);
    let next = 0;
    const fill = (spec, position) => (spec === "%%" ? "%" : String(args[position ? position - 1 : next++]));
    return key.split("|")[0].replace(/%(?:(\d+)\$)?(?:@|lld)|%%/g, fill);
};

// Minutes come from the plugin's settings (Settings › On this device › Pomodoro).
let FOCUS = 25 * 60;
let BREAK = 5 * 60;
const minutes = (value, fallback) => (Number.isFinite(value) && value > 0 && value <= 240 ? Math.round(value * 60) : fallback);

const state = { mode: "focus", left: FOCUS, running: false, endsAt: 0, done: {} };
let ticker = null;

// This computer's calendar day (not UTC): sessions are counted, and logged at 21:00, by it.
const dayOf = (date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const today = () => dayOf(new Date());
const clock = (seconds) =>
    `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;

const draw = () => {
    const total = state.mode === "focus" ? FOCUS : BREAK;
    aide.render({
        type: "VStack",
        children: [
            { type: "Text", text: state.mode === "focus" ? t("Focus") : t("Break"), style: "headline" },
            { type: "Text", key: "clock", text: clock(state.left), style: "largeTitle" },
            { type: "Progress", value: total - state.left, total },
            {
                type: "HStack",
                children: [
                    state.running
                        ? { type: "Button", title: t("Pause"), action: "pause" }
                        : { type: "Button", title: t("Start"), action: "start", style: "prominent" },
                    { type: "Button", title: t("Reset"), action: "reset" },
                    { type: "Button", title: t("Skip"), action: "skip" },
                ],
            },
            { type: "Divider" },
            { type: "Text", key: "count", text: t("Sessions today: %lld", state.done[today()] || 0), style: "caption" },
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

// At 21:00 (or once the app opens, up to 12 hours late) the day's count goes into pomodoro/log,
// one line per day. On the desktop app only, while it's open; this page then runs out of sight.
const LOG = "pomodoro/log";
aide.onSchedule("evening-log", async (run) => {
    const day = dayOf(new Date(run.scheduledFor));
    const stored = await aide.call("storage.get").catch(() => null);
    const count = (stored && stored.done && stored.done[day]) || 0;
    const line = `- ${day}: ${count} focus session${count === 1 ? "" : "s"}`;
    const log = (await aide.call("notes.list", { prefix: "pomodoro" })).find((note) => note.path === LOG);
    if (!log) {
        await aide.call("notes.create", { path: LOG, body: `Focus log\n${line}\n` });
        return;
    }
    const { body } = await aide.call("notes.get", { id: log.id });
    if (!body.includes(`- ${day}:`)) await aide.call("notes.append", { id: log.id, text: line });
});

Promise.all([aide.call("settings.get").catch(() => ({})), aide.call("storage.get").catch(() => null)])
    .then(([settings, stored]) => {
        FOCUS = minutes(settings.focusMinutes, FOCUS);
        BREAK = minutes(settings.breakMinutes, BREAK);
        state.left = FOCUS;
        if (stored && stored.done) state.done = stored.done;
    })
    .finally(draw);
