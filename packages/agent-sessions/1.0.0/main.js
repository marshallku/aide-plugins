// Agent sessions: this computer's Claude Code, Codex and Grok sessions, newest first, made into a
// note the way the owner asks (docs/plans/2026-11-06-agent-session-import-plan.md, unit C). The
// right panel lists them; `/session text` in Quick Capture or Scratch opens it with the text as the
// instruction. Picking one shows what it is and asks what to make of it; Make note reads the session
// (its first prompt and the latest turns that fit) and asks this device's assistant for a note, shown
// as a preview to edit; nothing is written until Save. The draft lives in the plugin's storage, so
// hiding the panel loses nothing, and Save is idempotent: the note carries the save's nonce, and a
// retry that finds it there is done. The pure parts (Sessions.*) are tested in Node.

const Sessions = (() => {
    const AGENTS = { claude: "Claude Code", codex: "Codex", grok: "Grok" };

    /** "Claude Code" for "claude". */
    const agentName = (agent) => AGENTS[agent] ?? agent;

    /** How long ago `iso` was, from `now`: [amount, unit] (unit: now, m, h, d, date). */
    const ago = (iso, now) => {
        const minutes = Math.floor((now - Date.parse(iso)) / 60000);
        if (!Number.isFinite(minutes) || minutes < 1) return [0, "now"];
        if (minutes < 60) return [minutes, "m"];
        if (minutes < 60 * 24) return [Math.floor(minutes / 60), "h"];
        if (minutes < 60 * 24 * 7) return [Math.floor(minutes / 60 / 24), "d"];
        return [String(iso).slice(0, 10), "date"];
    };

    /** The session as the model reads it: its turns, with where turns were left out. */
    const material = (read) => {
        const lines = [`Session: ${agentName(read.agent)}${read.cwd ? ` in ${read.cwd}` : ""}`, ""];
        read.turns.forEach((turn, index) => {
            if (index === 1 && read.omitted > 0) lines.push(`[${read.omitted} turns left out here]`, "");
            lines.push(`## ${turn.role === "user" ? "Owner" : "Assistant"}`, turn.text, "");
        });
        if (read.turns.length === 1 && read.omitted > 0) lines.push(`[${read.omitted} turns left out]`);
        return lines.join("\n").trim();
    };

    /** The material within `limit` UTF-8 bytes (ai.run takes 220 KiB): turns after the first prompt
     *  leave from the oldest, counted as left out, until it fits; the newest is always kept. */
    const fit = (read, limit) => {
        const bytes = (text) => new TextEncoder().encode(text).length;
        let turns = [...read.turns];
        let omitted = read.omitted;
        let text = material({ ...read, turns, omitted });
        while (bytes(text) > limit && turns.length > 2) {
            turns.splice(1, 1);
            omitted += 1;
            text = material({ ...read, turns, omitted });
        }
        return { text, omitted };
    };

    /** A note name from a title: lowercase words joined by -, letters of any script kept. */
    const slug = (title) =>
        String(title)
            .toLowerCase()
            .normalize("NFC")
            .replace(/[^\p{L}\p{N}]+/gu, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 80) || "session-note";

    /** Where a note goes: `folder/slug` (a folder with no name: the vault's top). */
    const path = (folder, title) => {
        const clean = String(folder ?? "").trim().replace(/^\/+|\/+$/g, "");
        return clean ? `${clean}/${slug(title)}` : slug(title);
    };

    const quote = (text) => JSON.stringify(String(text));

    /** The note: frontmatter naming where it came from (and the save it belongs to), the title, the body. */
    const note = ({ title, markdown, key, nonce, today }) =>
        [
            "---",
            `created: ${today}`,
            `source: ${quote(key)}`,
            `import: ${nonce}`,
            "---",
            "",
            `# ${String(title).trim()}`,
            "",
            String(markdown).trim(),
            "",
        ].join("\n");

    /** Whether a note's body is the one save `nonce` wrote. */
    const isFrom = (body, nonce) => new RegExp(`^import: ${nonce}$`, "m").test(String(body ?? ""));

    /** The draft and saved-note record kept in storage, made whole (older or missing parts filled). */
    const stored = (value) => {
        const state = value && typeof value === "object" ? value : {};
        return { draft: state.draft ?? null, saved: state.saved && typeof state.saved === "object" ? state.saved : {} };
    };

    /** The record of saved notes with `key → id` added, the newest 200 kept. */
    const remember = (saved, key, id) => {
        const next = { ...saved };
        delete next[key];
        next[key] = id;
        const keys = Object.keys(next);
        for (const old of keys.slice(0, Math.max(0, keys.length - 200))) delete next[old];
        return next;
    };

    /** A save's own mark (letters and digits; the page may not be a secure context for crypto.randomUUID). */
    const nonce = () =>
        Array.from({ length: 4 }, () => Math.floor(Math.random() * 2 ** 32).toString(36))
            .join("")
            .slice(0, 24);

    return { agentName, ago, material, fit, slug, path, note, isFrom, stored, remember, nonce };
})();

// MARK: The page (only in the app: Node loads the functions above alone)

if (typeof window !== "undefined" && window.aide) {
    const kit = window.aideKit;
    // The app's aide.t (i18n/README.md › Plugins); an older app has none, and the English shows.
    const t = (key, ...args) => {
        if (typeof aide.t === "function") return aide.t(key, ...args);
        let next = 0;
        const fill = (spec, position) => (spec === "%%" ? "%" : String(args[position ? position - 1 : next++]));
        return key.split("|")[0].replace(/%(?:(\d+)\$)?(?:@|lld)|%%/g, fill);
    };
    const DEFAULT_INSTRUCTION =
        "Write a note of what I learned in this session: the ideas, the decisions and why, the pitfalls, with code where it matters.";

    // `/session text` from a capture: the panel, with the text as the instruction.
    aide.onCommand("import", async () => {
        const instruction = String(aide.surface.text ?? "").trim();
        try {
            await aide.call("panel.open", { id: "sessions", data: { instruction } });
        } catch (error) {
            throw new Error(t("Agent sessions are read on a Mac or Linux computer."));
        }
    });

    if (aide.surface.kind === "panel") {
        const root = kit.mount();
        const settings = { folder: "topics", instruction: "" };
        /** What's kept: the session being worked on (draft) and the notes made (key → id). */
        let state = Sessions.stored(null);
        let sessions = [];
        let filter = "";
        let incoming = String(aide.surface.data?.instruction ?? "");
        let asking = 0;

        // Every change is written at once; the app applies them in order (community/README.md › API).
        const keep = () =>
            aide.call("storage.set", { value: state }).then(
                () => true,
                (error) => {
                    show(error);
                    return false;
                },
            );
        const draft = () => state.draft;
        const setDraft = (next) => {
            state = { ...state, draft: next };
            keep();
        };

        const show = (error) => {
            const banner = root.querySelector("[data-key=problem]");
            if (banner) banner.textContent = String(error?.message ?? error);
            else root.prepend(kit.banner({ text: String(error?.message ?? error), tone: "danger" }));
            root.querySelector(".aide-banner")?.setAttribute("data-key", "problem");
        };

        const when = (iso) => {
            const [amount, unit] = Sessions.ago(iso, Date.now());
            if (unit === "now") return t("just now");
            if (unit === "m") return t("%lld min ago", amount);
            if (unit === "h") return t("%lld h ago", amount);
            if (unit === "d") return t("%lld d ago", amount);
            return amount;
        };

        /** Buttons side by side, with the kit's gap. */
        const row = (...buttons) => {
            const group = document.createElement("div");
            group.className = "aide-row-group";
            group.append(...buttons);
            return group;
        };

        const meta = (session) =>
            [Sessions.agentName(session.agent), session.project, when(session.updatedAt)].filter(Boolean).join(" · ");

        // MARK: The list

        const list = () => listing().catch((error) => show(error));

        const listing = async () => {
            root.replaceChildren(kit.header({ meta: t("Sessions on this computer, newest first") }));
            const choose = kit.select({
                value: filter,
                options: [
                    { value: "", title: t("All agents") },
                    { value: "claude", title: "Claude Code" },
                    { value: "codex", title: "Codex" },
                    { value: "grok", title: "Grok" },
                ],
                onChange: (value) => {
                    filter = value;
                    list();
                },
            });
            choose.setAttribute("data-key", "agent");
            const tools = document.createElement("div");
            tools.className = "aide-row-group";
            tools.append(choose, kit.button({ title: t("Refresh"), key: "refresh", onClick: () => list() }));
            root.append(tools);
            if (incoming) root.append(kit.banner({ text: t("Pick a session for: %@", incoming) }));
            const body = document.createElement("div");
            body.className = "sessions";
            root.append(body);
            try {
                sessions = await aide.call("sessions.list", filter ? { agent: filter, limit: 100 } : { limit: 100 });
            } catch (error) {
                body.replaceChildren(kit.empty({ title: t("No sessions here"), message: String(error?.message ?? error) }));
                return;
            }
            if (sessions.length === 0) {
                body.replaceChildren(
                    kit.empty({ title: t("No sessions here"), message: t("Claude Code, Codex and Grok sessions on this computer show up here.") }),
                );
                return;
            }
            const rows = kit.list(
                sessions.map((session) => ({
                    title: session.title || t("Untitled session"),
                    meta: meta(session),
                    trailing: state.saved[session.key] ? document.createTextNode(t("Made")) : null,
                    onSelect: () => pick(session),
                })),
            );
            [...rows.children].forEach((row, index) => row.setAttribute("data-key", `session-${index}`));
            body.replaceChildren(rows);
        };

        /** Another session while a preview isn't saved: Keep stays, Discard drops it and goes on. */
        const pick = (session) => {
            const current = draft();
            if (current?.preview && !current.pending && current.key !== session.key) {
                root.replaceChildren(
                    kit.header({ title: t("Keep the unsaved note?"), meta: current.preview.title }),
                    row(kit.button({ title: t("Keep"), style: "prominent", key: "keep", onClick: () => detail() }),
                    kit.button({
                        title: t("Discard"),
                        style: "destructive",
                        key: "discard",
                        onClick: () => {
                            setDraft(null);
                            pick(session);
                        },
                    })),
                );
                return;
            }
            if (current?.key !== session.key) {
                setDraft({
                    key: session.key,
                    session,
                    instruction: incoming || settings.instruction || DEFAULT_INSTRUCTION,
                    folder: settings.folder,
                    preview: null,
                    pending: null,
                });
                incoming = "";
            } else {
                setDraft({ ...current, session });
            }
            detail();
        };

        // MARK: The session and what to make of it

        const detail = () => {
            const current = draft();
            if (!current) return list();
            const session = current.session;
            root.replaceChildren(
                kit.header({ title: session.title || t("Untitled session"), meta: meta(session) }),
                kit.button({ title: t("All sessions"), style: "plain", key: "back", onClick: () => list() }),
            );
            if (current.preview) return preview();
            const instruction = document.createElement("textarea");
            instruction.className = "aide-input instruction";
            instruction.rows = 5;
            instruction.value = current.instruction;
            instruction.setAttribute("data-key", "instruction");
            instruction.setAttribute("aria-label", t("What to make of it"));
            instruction.addEventListener("input", () => setDraft({ ...draft(), instruction: instruction.value }));
            const folder = kit.input({ value: current.folder, attributes: { "data-key": "folder", "aria-label": t("Folder") } });
            folder.addEventListener("input", () => setDraft({ ...draft(), folder: folder.value }));
            const make = kit.button({ title: t("Make note"), style: "prominent", key: "make", onClick: () => ask() });
            root.append(
                kit.field({ label: t("What to make of it"), control: instruction }),
                kit.field({ label: t("Folder"), help: t("The note goes here; it's written only when you save it."), control: folder }),
                make,
            );
            if (state.saved[current.key]) {
                root.append(
                    kit.button({
                        title: t("Open the note made from it"),
                        style: "plain",
                        key: "open-made",
                        onClick: () => aide.call("notes.open", { id: state.saved[current.key] }).catch(show),
                    }),
                );
            }
        };

        const ask = async () => {
            const current = draft();
            const ask = ++asking;
            root.replaceChildren(kit.header({ title: current.session.title || t("Untitled session"), meta: t("Reading the session and asking the assistant…") }));
            try {
                // Listed again so the ref is this run's (a draft can outlive the app's run).
                const fresh = (await aide.call("sessions.list", { agent: current.session.agent, limit: 200 })).find(
                    (session) => session.key === current.key,
                );
                if (!fresh) throw new Error(t("That session isn't on this computer any more."));
                const read = await aide.call("sessions.read", { ref: fresh.ref });
                const material = Sessions.fit(read, 215 * 1024);
                const answer = await aide.call("ai.run", { instructions: current.instruction, input: material.text });
                // Another session was picked meanwhile: this answer isn't for it.
                if (ask !== asking || draft()?.key !== current.key) return;
                setDraft({ ...draft(), session: fresh, preview: { title: answer.title, markdown: answer.markdown, omitted: material.omitted } });
                preview();
            } catch (error) {
                if (ask !== asking) return;
                detail();
                show(error);
            }
        };

        // MARK: The preview and Save

        const preview = () => {
            const current = draft();
            const session = current.session;
            root.replaceChildren(
                kit.header({ title: session.title || t("Untitled session"), meta: meta(session) }),
                kit.button({ title: t("All sessions"), style: "plain", key: "back", onClick: () => list() }),
            );
            if (current.preview.omitted > 0) {
                root.append(kit.banner({ text: t("%lld turns in the middle were left out (the session is long).", current.preview.omitted) }));
            }
            const title = kit.input({ value: current.preview.title, attributes: { "data-key": "note-title", "aria-label": t("Title") } });
            title.addEventListener("input", () => setDraft({ ...draft(), preview: { ...draft().preview, title: title.value } }));
            const body = document.createElement("textarea");
            body.className = "aide-input markdown";
            body.rows = 16;
            body.value = current.preview.markdown;
            body.setAttribute("data-key", "note-body");
            body.setAttribute("aria-label", t("Note"));
            body.addEventListener("input", () => setDraft({ ...draft(), preview: { ...draft().preview, markdown: body.value } }));
            root.append(
                kit.field({ label: t("Title"), control: title }),
                kit.field({ label: t("Note"), help: Sessions.path(current.folder, current.preview.title), control: body }),
                row(kit.button({ title: t("Save"), style: "prominent", key: "save", onClick: () => save() }),
                kit.button({ title: t("Ask again"), key: "again", onClick: () => ask() }),
                kit.button({
                    title: t("Discard"),
                    style: "destructive",
                    key: "discard",
                    onClick: () => {
                        setDraft({ ...draft(), preview: null, pending: null });
                        detail();
                    },
                })),
            );
        };

        /** The note at `path`, if any (its folder listed). */
        const noteAt = async (path) => {
            const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
            const notes = await aide.call("notes.list", folder ? { prefix: folder } : {});
            const found = notes.find((note) => note.path === path);
            return found ? aide.call("notes.get", { id: found.id }) : null;
        };

        const save = async () => {
            const current = draft();
            const path = Sessions.path(current.folder, current.preview.title);
            // The save named before it's made: a retry finds its own note by the nonce.
            const pending = current.pending?.path === path ? current.pending : { path, nonce: Sessions.nonce() };
            // Kept before the note is made: a Save cut short anywhere finds its own note on the retry.
            state = { ...state, draft: { ...current, pending } };
            if (!(await keep())) return;
            const body = Sessions.note({
                title: current.preview.title,
                markdown: current.preview.markdown,
                key: current.key,
                nonce: pending.nonce,
                today: new Date().toISOString().slice(0, 10),
            });
            let made;
            try {
                made = await aide.call("notes.create", { path, body });
            } catch (error) {
                // Whether it was made is unknown until the note there is read: the pending save stays
                // either way (a retry at this path reuses it; another title makes a new one).
                let there;
                try {
                    there = await noteAt(path);
                } catch {
                    show(error);
                    return;
                }
                if (there && Sessions.isFrom(there.body, pending.nonce)) {
                    made = there;
                } else {
                    show(there ? new Error(t("A note is already at %@. Change the title.", path)) : error);
                    return;
                }
            }
            state = { draft: null, saved: Sessions.remember(state.saved, current.key, made.id) };
            keep();
            root.replaceChildren(
                kit.header({ title: t("Saved"), meta: made.path }),
                row(kit.button({ title: t("Open"), style: "prominent", key: "open", onClick: () => aide.call("notes.open", { id: made.id }).catch(show) }),
                kit.button({ title: t("All sessions"), key: "back", onClick: () => list() })),
            );
        };

        // A /session while the panel shows: the newest instruction, and the list to pick from.
        aide.on("panel.open", (data) => {
            incoming = String(data?.instruction ?? "");
            if (draft() && !draft().preview) setDraft({ ...draft(), instruction: incoming || draft().instruction });
            list();
        }).catch(() => {});

        (async () => {
            const [stored, saved] = await Promise.all([
                aide.call("storage.get").catch(() => null),
                aide.call("settings.get").catch(() => ({})),
            ]);
            state = Sessions.stored(stored);
            if (typeof saved.folder === "string") settings.folder = saved.folder;
            if (typeof saved.instruction === "string") settings.instruction = saved.instruction;
            // A draft with a preview comes back as it was; otherwise the list (with /session's text).
            if (draft()?.preview) preview();
            else list();
        })();
    }
}
