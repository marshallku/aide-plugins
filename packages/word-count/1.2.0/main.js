// A sheet on a note (aide.surface.kind === "sheet") counts its words; the right panel's view
// ("panel") counts the note on screen as it changes (note.active); a command opens that panel; the
// settings page keeps one option in the plugin's storage.
// The app's aide.t (i18n/README.md › Plugins); an older app has none, and the English shows.
const t = (key, ...args) => {
    if (typeof aide.t === "function") return aide.t(key, ...args);
    let next = 0;
    const fill = (spec, position) => (spec === "%%" ? "%" : String(args[position ? position - 1 : next++]));
    return key.split("|")[0].replace(/%(?:(\d+)\$)?(?:@|lld)|%%/g, fill);
};
const $ = (id) => document.getElementById(id);
const say = (text) => { $("status").textContent = text; };

const loadOptions = () => aide.call("storage.get").then((value) => value || { skipHeadings: false }).catch(() => ({ skipHeadings: false }));

const count = (body, skipHeadings) =>
    body
        .split("\n")
        .filter((line) => !(skipHeadings && /^#{1,6}\s/.test(line)))
        .join(" ")
        .split(/\s+/)
        .filter((word) => /[\p{L}\p{N}]/u.test(word)).length;

const showCount = async () => {
    $("count").hidden = false;
    try {
        const [note, options] = await Promise.all([aide.call("notes.get", { id: aide.surface.noteId }), loadOptions()]);
        const words = count(note.body, options.skipHeadings);
        $("title").textContent = note.title || note.path;
        $("words").textContent = t("%lld words", words);
        $("detail").textContent = options.skipHeadings ? t("Headings skipped") : t("Headings counted");
    } catch (error) {
        say(String(error));
    }
};

// The right panel: whatever note is on screen, counted again when another one comes up.
const showLive = () => {
    $("count").hidden = false;
    $("close").hidden = true;
    // Only the latest note's count draws: an earlier fetch still on its way is dropped.
    let latest = 0;
    aide.on("note.active", async (summary) => {
        const request = ++latest;
        if (!summary) {
            $("title").textContent = "";
            $("words").textContent = t("No note on screen");
            $("detail").textContent = "";
            return;
        }
        try {
            const [note, options] = await Promise.all([aide.call("notes.get", { id: summary.id }), loadOptions()]);
            if (request !== latest) return;
            const words = count(note.body, options.skipHeadings);
            $("title").textContent = note.title || note.path;
            $("words").textContent = t("%lld words", words);
            $("detail").textContent = options.skipHeadings ? t("Headings skipped") : t("Headings counted");
        } catch (error) {
            if (request === latest) say(String(error));
        }
    });
};

aide.onCommand("show-panel", () => aide.call("panel.open", { id: "live" }));

const showOptions = async () => {
    $("options").hidden = false;
    const box = $("skipHeadings");
    box.checked = (await loadOptions()).skipHeadings;
    box.addEventListener("change", () =>
        aide.call("storage.set", { value: { skipHeadings: box.checked } }).then(() => say(t("Saved"))).catch((error) => say(String(error))),
    );
};

// index.html's text, marked data-t, in the app's language.
document.querySelectorAll("[data-t]").forEach((node) => {
    node.textContent = t(node.textContent);
});
$("close").addEventListener("click", () => aide.close());
if (aide.surface.kind === "sheet") showCount();
else if (aide.surface.kind === "panel") showLive();
else if (aide.surface.kind === "settings") showOptions();
