// Kanban: boards written in notes under boards/, the way Obsidian's Kanban plugin writes them, so the
// same note is a board in both apps. A lane is a `## Title` heading, a card a list item under it
// (`- [ ] text`, done `- [x] text`, its indented lines going with it); anything else in a lane, the
// frontmatter (`kanban-plugin: board`) and Obsidian's `%% kanban:settings` block stay as they are.
// Cards are moved by dragging (a mouse or a finger), added at a lane's foot, ticked off, or removed;
// every change is saved to the note with the version read, and a board changed elsewhere is read
// again. The parsing is plain functions (Kanban.parse / serialize / move), tested in Node.

const Kanban = (() => {
    const LANE = /^##\s+(.*?)\s*$/;
    const CARD = /^[-*+]\s+\[([ xX])\]\s?(.*)$/;
    const SETTINGS = /^%%\s*kanban:settings/;

    /** The board in `body`: its head (frontmatter and text before the first lane), lanes, tail. */
    const parse = (body) => {
        const lines = String(body ?? "").replace(/\r\n/g, "\n").split("\n");
        const settings = lines.findIndex((line) => SETTINGS.test(line));
        const end = settings < 0 ? lines.length : settings;
        const first = lines.findIndex((line, index) => index < end && LANE.test(line) && !inFrontmatter(lines, index));
        const head = (first < 0 ? lines.slice(0, end) : lines.slice(0, first)).join("\n");
        const lanes = [];
        let lane = null;
        let card = null;
        // Blank lines inside a card, kept only if more of the card follows them.
        let blanks = [];
        for (let index = first < 0 ? end : first; index < end; index++) {
            const line = lines[index];
            const heading = line.match(LANE);
            if (heading) {
                lane = { title: heading[1], cards: [], notes: [] };
                lanes.push(lane);
                card = null;
                blanks = [];
                continue;
            }
            const item = line.match(CARD);
            if (item) {
                card = { done: item[1] !== " ", text: item[2], more: [] };
                lane.cards.push(card);
            } else if (card && /^\s+\S/.test(line)) {
                card.more.push(...blanks, line);
            } else if (line.trim()) {
                card = null;
                lane.notes.push(line);
            } else if (card) {
                blanks.push(line);
                continue;
            }
            blanks = [];
        }
        const tail = settings < 0 ? "" : lines.slice(settings).join("\n");
        return { head: head.replace(/\n+$/, ""), lanes, tail: tail.replace(/\n+$/, "") };
    };

    const inFrontmatter = (lines, index) => {
        if (lines[0] !== "---") return false;
        const close = lines.findIndex((line, at) => at > 0 && line === "---");
        return close < 0 || index <= close;
    };

    /** The note text of `board` (head, each lane with its notes and cards, tail). */
    const serialize = (board) => {
        const parts = [];
        if (board.head) parts.push(board.head);
        for (const lane of board.lanes) {
            const lines = [`## ${lane.title}`, ""];
            for (const note of lane.notes) lines.push(note);
            for (const card of lane.cards) {
                lines.push(`- [${card.done ? "x" : " "}] ${card.text}`, ...card.more);
            }
            parts.push(lines.join("\n").replace(/\n+$/, ""));
        }
        if (board.tail) parts.push(board.tail);
        return `${parts.join("\n\n")}\n`;
    };

    /**
     * A copy of `board` with the card at `from` ({lane, card}) moved so it ends up at `to` ({lane,
     * card}): `to.card` is its place among the lane's cards once it has left its own.
     */
    const move = (board, from, to) => {
        const next = structuredClone(board);
        const [card] = next.lanes[from.lane].cards.splice(from.card, 1);
        if (!card) return board;
        const target = next.lanes[to.lane].cards;
        target.splice(Math.max(0, Math.min(to.card, target.length)), 0, card);
        return next;
    };

    /** A new board's text: Obsidian's frontmatter and three empty lanes. */
    const blank = () =>
        serialize({
            head: "---\n\nkanban-plugin: board\n\n---",
            lanes: ["To do", "Doing", "Done"].map((title) => ({ title, cards: [], notes: [] })),
            tail: "",
        });

    /** A board's name: its note's file name (a board has no title heading; its first is a lane). */
    const name = (path) => {
        const file = String(path).split("/").pop() ?? "";
        return file.replace(/[-_]+/g, " ").replace(/^\p{Ll}/u, (letter) => letter.toUpperCase());
    };

    return { parse, serialize, move, blank, name };
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
    const PREFIX = "boards";
    const root = kit.mount();
    /** The board open: its note (id, version, path), the parsed board. */
    let open = null;
    let saving = Promise.resolve();

    const status = (text) => {
        const node = document.getElementById("kanban-status");
        if (node) node.textContent = text;
    };

    const list = async () => {
        open = null;
        root.replaceChildren();
        let notes = [];
        try {
            notes = (await aide.call("notes.list", { prefix: PREFIX })).filter((note) => note.path.startsWith(`${PREFIX}/`));
        } catch (error) {
            root.append(kit.banner({ text: String(error), tone: "danger" }));
            return;
        }
        const name = kit.input({ placeholder: t("New board") });
        name.setAttribute("data-key", "kanban-new-name");
        const create = kit.button({
            title: t("Create"),
            style: "prominent",
            key: "kanban-create",
            onClick: async () => {
                const title = name.value.trim();
                if (!title) return;
                const slug = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "board";
                try {
                    const note = await aide.call("notes.create", { path: `${PREFIX}/${slug}`, body: Kanban.blank() });
                    await show(note.id);
                } catch (error) {
                    status(String(error));
                }
            },
        });
        root.append(
            kit.header({ meta: t("Boards in %@, the way Obsidian's Kanban writes them", `${PREFIX}/`) }),
            notes.length
                ? kit.list(notes.map((note) => ({ title: Kanban.name(note.path), meta: note.path, key: `board-${note.path}`, onSelect: () => show(note.id) })))
                : kit.empty({ title: t("No boards yet"), message: t("Name one to start: it gets To do, Doing and Done.") }),
            kit.el("div", "aide-row-group", [name, create]),
            kit.el("p", "aide-meta", [], { id: "kanban-status", role: "status" }),
        );
    };

    const show = async (id) => {
        try {
            const note = await aide.call("notes.get", { id });
            open = { id: note.id, version: note.version, path: note.path, title: Kanban.name(note.path), board: Kanban.parse(note.body) };
            draw();
        } catch (error) {
            status(String(error));
        }
    };

    /**
     * Saves `board` (the version read), then shows it; a note changed meanwhile is read again. A
     * save belongs to the board it was made on: going back to the list or to another board meanwhile
     * doesn't stop it, and its outcome then touches nothing on screen.
     */
    const save = (board) => {
        const session = open;
        session.board = board;
        draw();
        saving = saving
            .then(async () => {
                try {
                    const saved = await aide.call("notes.update", { id: session.id, version: session.version, body: Kanban.serialize(session.board) });
                    session.version = saved.version;
                    if (open === session) status("");
                } catch (error) {
                    if (open !== session) return;
                    status(t("Changed elsewhere; read again. (%@)", String(error)));
                    await show(session.id);
                }
            })
            .catch(() => {});
    };

    const draw = () => {
        const { board } = open;
        root.replaceChildren();
        root.append(
            kit.header({
                title: open.title,
                actions: [kit.button({ title: t("Boards"), key: "kanban-back", onClick: list })],
            }),
        );
        const lanes = kit.el("div", "kanban-lanes", [], { "data-key": "kanban-board" });
        board.lanes.forEach((lane, laneIndex) => {
            const cards = kit.el("div", "kanban-cards", [], { "data-lane": laneIndex });
            lane.cards.forEach((card, cardIndex) => cards.append(cardView(card, laneIndex, cardIndex)));
            const field = kit.input({ placeholder: t("Add a card") });
            field.setAttribute("data-key", `kanban-add-${laneIndex}`);
            field.addEventListener("keydown", (event) => {
                if (event.key !== "Enter" || event.isComposing || !field.value.trim()) return;
                const next = structuredClone(board);
                next.lanes[laneIndex].cards.push({ done: false, text: field.value.trim(), more: [] });
                save(next);
            });
            lanes.append(
                kit.el("section", "kanban-lane", [
                    kit.el("h2", "aide-section-label kanban-lane-title", [kit.el("span", "", lane.title), kit.el("span", "kanban-count", String(lane.cards.length))]),
                    cards,
                    field,
                ]),
            );
        });
        const laneName = kit.input({ placeholder: t("Add a lane") });
        laneName.setAttribute("data-key", "kanban-add-lane");
        laneName.addEventListener("keydown", (event) => {
            if (event.key !== "Enter" || event.isComposing || !laneName.value.trim()) return;
            const next = structuredClone(board);
            next.lanes.push({ title: laneName.value.trim(), cards: [], notes: [] });
            save(next);
        });
        lanes.append(kit.el("section", "kanban-lane kanban-new-lane", [laneName]));
        root.append(lanes, kit.el("p", "aide-meta", [], { id: "kanban-status", role: "status" }));
    };

    const cardView = (card, laneIndex, cardIndex) => {
        const box = kit.el("input", "", [], { type: "checkbox", "aria-label": t("Done") });
        box.checked = card.done;
        box.addEventListener("change", () => {
            const next = structuredClone(open.board);
            next.lanes[laneIndex].cards[cardIndex].done = box.checked;
            save(next);
        });
        const remove = kit.el("button", "kanban-remove", "×", { type: "button", "aria-label": t("Remove card") });
        remove.addEventListener("click", () => {
            const next = structuredClone(open.board);
            next.lanes[laneIndex].cards.splice(cardIndex, 1);
            save(next);
        });
        const node = kit.el("article", `kanban-card${card.done ? " done" : ""}`, [box, kit.el("div", "kanban-text", [kit.inline(card.text)]), remove], {
            "data-key": `kanban-card-${laneIndex}-${cardIndex}`,
        });
        node.addEventListener("pointerdown", (event) => grab(event, node, laneIndex, cardIndex));
        return node;
    };

    // MARK: Dragging (pointer events: a mouse and a finger alike)

    const grab = (event, node, laneIndex, cardIndex) => {
        if (event.target.closest("input, button")) return;
        const startX = event.clientX;
        const startY = event.clientY;
        let dragging = false;
        let marker = null;
        const target = () => {
            if (!marker) return null;
            const cards = marker.parentElement;
            const lane = Number(cards.dataset.lane);
            const index = [...cards.children].filter((child) => child !== node).indexOf(marker);
            return { lane, card: index };
        };
        const moveTo = (x, y) => {
            node.style.visibility = "hidden";
            const under = document.elementFromPoint(x, y);
            node.style.visibility = "";
            const cards = under?.closest(".kanban-lane")?.querySelector(".kanban-cards");
            if (!cards) return;
            marker ??= kit.el("div", "kanban-marker");
            const after = [...cards.querySelectorAll(".kanban-card")].filter((card) => card !== node).find((card) => {
                const box = card.getBoundingClientRect();
                return y < box.top + box.height / 2;
            });
            cards.insertBefore(marker, after ?? null);
        };
        const onMove = (move) => {
            if (!dragging && Math.hypot(move.clientX - startX, move.clientY - startY) < 6) return;
            dragging = true;
            move.preventDefault();
            node.classList.add("dragging");
            moveTo(move.clientX, move.clientY);
        };
        const onUp = () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            window.removeEventListener("pointercancel", onUp);
            node.classList.remove("dragging");
            const to = target();
            marker?.remove();
            if (dragging && to) save(Kanban.move(open.board, { lane: laneIndex, card: cardIndex }, to));
        };
        window.addEventListener("pointermove", onMove, { passive: false });
        window.addEventListener("pointerup", onUp);
        window.addEventListener("pointercancel", onUp);
    };

    // A board changed elsewhere (another device, Obsidian through sync) is read again.
    aide.on("note.changed", (note) => {
        if (open && note.id === open.id && note.version > open.version) show(open.id);
    }).catch(() => {});
    list();
}
