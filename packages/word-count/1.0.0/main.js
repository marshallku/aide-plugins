// A sheet on a note (aide.surface.kind === "sheet") counts its words; the settings page keeps one
// option in the plugin's storage.
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
        $("words").textContent = `${words} ${words === 1 ? "word" : "words"}`;
        $("detail").textContent = options.skipHeadings ? "Headings skipped" : "Headings counted";
    } catch (error) {
        say(String(error));
    }
};

const showOptions = async () => {
    $("options").hidden = false;
    const box = $("skipHeadings");
    box.checked = (await loadOptions()).skipHeadings;
    box.addEventListener("change", () =>
        aide.call("storage.set", { value: { skipHeadings: box.checked } }).then(() => say("Saved")).catch((error) => say(String(error))),
    );
};

$("close").addEventListener("click", () => aide.close());
if (aide.surface.kind === "sheet") showCount();
else showOptions();
