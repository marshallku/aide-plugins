// Recall: spaced repetition over cards written in notes. A card is a line `front :: back` (or
// `front ::: back` for both directions) or a block whose front and back a line `?` (`??` for both)
// separates, in notes under the folders in Settings (cards by default). Each review is one line in
// this device's own log note, recall/log/<instance>/<month>, so devices never edit the same note;
// a card's state is its latest review across every device's log. Scheduling is FSRS-5 at 90%
// retention. The grammar and card ids match the server plugin (plugins/internal/recall) through
// spec/fixtures/recall-cards.json; the screens are the plugin kit's (aide-kit.js).

const Recall = (() => {
    // MARK: sha256 (card ids; the same on the server)

    const K = new Uint32Array([
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
        0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
        0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
        0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
        0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
        0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ]);

    const sha256 = (text) => {
        const data = new TextEncoder().encode(text);
        const length = data.length;
        const blocks = Math.ceil((length + 9) / 64);
        const bytes = new Uint8Array(blocks * 64);
        bytes.set(data);
        bytes[length] = 0x80;
        const view = new DataView(bytes.buffer);
        view.setUint32(bytes.length - 8, Math.floor(length / 0x20000000));
        view.setUint32(bytes.length - 4, (length * 8) >>> 0);
        const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
        const w = new Uint32Array(64);
        const rotr = (x, n) => (x >>> n) | (x << (32 - n));
        for (let block = 0; block < blocks; block++) {
            for (let t = 0; t < 16; t++) w[t] = view.getUint32(block * 64 + t * 4);
            for (let t = 16; t < 64; t++) {
                const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
                const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
                w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
            }
            let [a, b, c, d, e, f, g, hh] = h;
            for (let t = 0; t < 64; t++) {
                const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[t] + w[t]) >>> 0;
                const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
                [hh, g, f, e, d, c, b, a] = [g, f, e, (d + t1) >>> 0, c, b, a, (t1 + t2) >>> 0];
            }
            const next = [a, b, c, d, e, f, g, hh];
            for (let i = 0; i < 8; i++) h[i] = (h[i] + next[i]) >>> 0;
        }
        return Array.from(h, (word) => word.toString(16).padStart(8, "0")).join("");
    };

    // MARK: Cards

    const FENCE = /^\s*(`{3,}|~{3,})/;
    const HEADING = /^#{1,6}(\s|$)/;
    const TAGS_ONLY = /^\s*(#[^\s#]+\s*)+$/;
    const TODO = /^\s*[-*+]\s+\[.\]\s/;
    const LIST_MARKER = /^\s*(?:[-*+]|\d+[.)])\s+/;

    /** The card id: the note, the direction, both sides and which of identical cards it is. */
    const cardId = (noteId, dir, front, back, occurrence) =>
        sha256([noteId, dir, front, back, String(occurrence)].join("\u001f")).slice(0, 16);

    /**
     * Where an inline card splits: the first `::` (or `:::`) outside `code` and not escaped as
     * `\::`. Returns {front, back, both} or null.
     */
    const splitInline = (text) => {
        let code = false;
        for (let i = 0; i < text.length; i++) {
            const char = text[i];
            if (char === "`") {
                code = !code;
                continue;
            }
            if (code) continue;
            if (char === "\\" && text.startsWith("::", i + 1)) {
                i += 2;
                continue;
            }
            if (char !== ":") continue;
            let run = 0;
            while (text[i + run] === ":") run += 1;
            if (run === 2 || run === 3) {
                const unescape = (side) => side.replace(/\\::/g, "::").trim();
                const front = unescape(text.slice(0, i));
                const back = unescape(text.slice(i + run));
                return front && back ? { front, back, both: run === 3 } : null;
            }
            i += run - 1;
        }
        return null;
    };

    /**
     * The cards in a note's body, in order: `[{id, dir, front, back, line}]` (line is 1-based, the
     * card's first line). Frontmatter, fenced code, HTML comments, todo lines and tag-only lines are
     * never cards; a blank line or a heading ends a block.
     */
    const parse = (body, noteId) => {
        const lines = String(body ?? "").replace(/\r\n?/g, "\n").split("\n");
        let start = 0;
        if (lines[0] === "---") {
            const end = lines.findIndex((line, index) => index > 0 && (line === "---" || line === "..."));
            if (end > 0) start = end + 1;
        }
        const paragraphs = [];
        let current = [];
        const close = () => {
            if (current.length) paragraphs.push(current);
            current = [];
        };
        let fence = null;
        let comment = false;
        for (let index = start; index < lines.length; index++) {
            const raw = lines[index];
            if (fence) {
                if (raw.trim().startsWith(fence)) fence = null;
                continue;
            }
            const opened = raw.match(FENCE);
            if (opened && !comment) {
                close();
                fence = opened[1];
                continue;
            }
            // Comments go (an <!--SR:…--> schedule, notes to self); a line that was only a
            // comment is skipped without ending the block.
            let text = "";
            let rest = raw;
            while (rest.length) {
                if (comment) {
                    const end = rest.indexOf("-->");
                    if (end < 0) {
                        rest = "";
                        break;
                    }
                    comment = false;
                    rest = rest.slice(end + 3);
                } else {
                    const begin = rest.indexOf("<!--");
                    if (begin < 0) {
                        text += rest;
                        break;
                    }
                    text += rest.slice(0, begin);
                    comment = true;
                    rest = rest.slice(begin + 4);
                }
            }
            if (!text.trim()) {
                if (!raw.trim()) close();
                continue;
            }
            if (HEADING.test(text)) {
                close();
                continue;
            }
            if (TAGS_ONLY.test(text) || TODO.test(text)) continue;
            current.push({ text: text.trim(), line: index + 1 });
        }
        close();

        const found = [];
        const add = (dir, front, back, line) => found.push({ dir, front, back, line });
        for (const paragraph of paragraphs) {
            const split = paragraph.findIndex((entry) => entry.text === "?" || entry.text === "??");
            if (split > 0 && split < paragraph.length - 1) {
                const front = paragraph.slice(0, split).map((entry) => entry.text).join("\n");
                const back = paragraph.slice(split + 1).map((entry) => entry.text).join("\n");
                add("fwd", front, back, paragraph[0].line);
                if (paragraph[split].text === "??") add("rev", back, front, paragraph[0].line);
                continue;
            }
            for (const entry of paragraph) {
                const card = splitInline(entry.text.replace(LIST_MARKER, ""));
                if (!card) continue;
                add("fwd", card.front, card.back, entry.line);
                if (card.both) add("rev", card.back, card.front, entry.line);
            }
        }
        const seen = new Map();
        return found.map((card) => {
            const key = [card.dir, card.front, card.back].join("\u001f");
            const occurrence = seen.get(key) ?? 0;
            seen.set(key, occurrence + 1);
            return { id: cardId(noteId, card.dir, card.front, card.back, occurrence), ...card };
        });
    };

    // MARK: Review log

    const GRADES = ["again", "hard", "good", "easy"];
    const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    const LINE =
        /^- (\S+) ([0-9a-f]{16}) (again|hard|good|easy) s=(\d+(?:\.\d+)?) d=(\d+(?:\.\d+)?) due=(\S+) e=([0-9a-z-]{8,64})$/;

    /** A UTC time as the log writes it, and a real one (no 2026-02-30). */
    const validStamp = (text) => {
        if (!STAMP.test(text)) return false;
        const time = Date.parse(text);
        return Number.isFinite(time) && new Date(time).toISOString() === text;
    };

    /** One review as its log line. */
    const formatEvent = (event) =>
        `- ${event.ts} ${event.card} ${event.grade} s=${event.s.toFixed(4)} d=${event.d.toFixed(4)} due=${event.due} e=${event.e}`;

    /** The reviews in a log note's body, and how many lines starting "- " weren't one. */
    const parseLog = (body) => {
        const events = [];
        let malformed = 0;
        for (const line of String(body ?? "").split("\n")) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("- ")) continue;
            const match = trimmed.match(LINE);
            if (!match || !validStamp(match[1]) || !validStamp(match[6])) {
                malformed += 1;
                continue;
            }
            events.push({ ts: match[1], card: match[2], grade: match[3], s: Number(match[4]), d: Number(match[5]), due: match[6], e: match[7] });
        }
        return { events, malformed };
    };

    /** Whether `a` is a later review than `b` (time, then event id: the same answer everywhere). */
    const later = (a, b) => a.ts > b.ts || (a.ts === b.ts && a.e > b.e);

    /** Each card's latest review. */
    const winners = (events) => {
        const latest = new Map();
        for (const event of events) {
            const current = latest.get(event.card);
            if (!current || later(event, current)) latest.set(event.card, event);
        }
        return latest;
    };

    // MARK: FSRS-5

    const W = [
        0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192, 1.01925, 1.9395, 0.11, 0.29605, 2.2698,
        0.2315, 2.9898, 0.51655, 0.6621,
    ];
    const DECAY = -0.5;
    const FACTOR = 19 / 81;
    const DAY = 86400000;
    const RELEARN = 10 * 60 * 1000;
    const clampD = (d) => Math.min(10, Math.max(1, d));
    const initS = (g) => W[g - 1];
    const initD = (g) => clampD(W[4] - Math.exp(W[5] * (g - 1)) + 1);
    const retrievability = (days, s) => Math.pow(1 + (FACTOR * days) / s, DECAY);
    const nextD = (d, g) => clampD(W[7] * initD(4) + (1 - W[7]) * (d + (-W[6] * (g - 3) * (10 - d)) / 9));
    const recallS = (d, s, r, g) =>
        s * (Math.exp(W[8]) * (11 - d) * Math.pow(s, -W[9]) * (Math.exp(W[10] * (1 - r)) - 1) * (g === 2 ? W[15] : 1) * (g === 4 ? W[16] : 1) + 1);
    const forgetS = (d, s, r) => Math.min(W[11] * Math.pow(d, -W[12]) * (Math.pow(s + 1, W[13]) - 1) * Math.exp(W[14] * (1 - r)), s);
    const shortS = (s, g) => s * Math.exp(W[17] * (g - 3 + W[18]));

    /**
     * The state after answering `grade` at `now` (ms), from the card's latest review or none: Again
     * brings it back in 10 minutes; any other grade in round(stability) days (at 90% retention the
     * interval is the stability), at least one.
     */
    const schedule = (previous, grade, now) => {
        const g = GRADES.indexOf(grade) + 1;
        let s;
        let d;
        if (!previous) {
            s = initS(g);
            d = initD(g);
        } else {
            const elapsed = (now - Date.parse(previous.ts)) / DAY;
            d = nextD(previous.d, g);
            if (elapsed < 1) s = shortS(previous.s, g);
            else {
                const r = retrievability(elapsed, previous.s);
                s = g === 1 ? forgetS(previous.d, previous.s, r) : recallS(previous.d, previous.s, r, g);
            }
        }
        s = Math.max(0.01, s);
        const due = g === 1 ? now + RELEARN : now + Math.min(36500, Math.max(1, Math.round(s))) * DAY;
        return { s, d, due: new Date(due).toISOString() };
    };

    /** How long until `due` from `now`, short: 10m, 5h, 3d, 2.5mo, 1.2y. */
    const span = (due, now) => {
        const minutes = Math.max(1, Math.round((Date.parse(due) - now) / 60000));
        if (minutes < 60) return `${minutes}m`;
        if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`;
        const days = Math.round(minutes / 1440);
        if (days < 30) return `${days}d`;
        if (days < 365) return `${Math.round(days / 3) / 10}mo`;
        return `${Math.round(days / 36.5) / 10}y`;
    };

    return { sha256, cardId, splitInline, parse, parseLog, formatEvent, winners, later, schedule, span, GRADES };
})();

globalThis.Recall = Recall;

// MARK: The plugin

const LOG_PREFIX = "recall/log";
const LOG_LIMIT = 256 * 1024;
const LIST_LIMIT = 500;

const uuid = () =>
    "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });

const pad = (n) => String(n).padStart(2, "0");
const localDay = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

const state = {
    prefixes: ["cards"],
    newPerDay: 20,
    cards: [], // every card in the deck folders
    notes: new Map(), // id → {path, title, version, cards}
    logs: new Map(), // id → {path, version, size, events}
    latest: new Map(), // card id → its latest review
    firstSeen: new Map(), // card id → its first review's time
    warnings: [],
    pending: null, // {card, event, noteId}: a review whose write may or may not have landed
    loaded: false,
};

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

const under = (path, prefix) => path === prefix || path.startsWith(`${prefix}/`);

async function readSettings() {
    const settings = (await aide.call("settings.get")) ?? {};
    const prefixes = (settings.prefixes ?? []).map((prefix) => String(prefix).trim().replace(/^\/+|\/+$/g, "")).filter(Boolean);
    state.prefixes = prefixes.length ? prefixes : ["cards"];
    const perDay = Number(settings.newPerDay);
    state.newPerDay = Number.isFinite(perDay) && perDay >= 0 ? Math.floor(perDay) : 20;
}

/** Reads the deck folders and every log; a note unchanged since the last read isn't read again. */
async function load() {
    const warnings = [];
    const notes = new Map();
    for (const prefix of state.prefixes) {
        const list = await aide.call("notes.list", { prefix });
        if (list.length >= LIST_LIMIT) warnings.push(`Only the first ${LIST_LIMIT} notes under ${prefix} are read.`);
        for (const summary of list) {
            if (under(summary.path, "recall") || notes.has(summary.id)) continue;
            const known = state.notes.get(summary.id);
            if (known && known.version === summary.version) {
                notes.set(summary.id, known);
                continue;
            }
            const note = await aide.call("notes.get", { id: summary.id });
            notes.set(note.id, { id: note.id, path: note.path, title: note.title, version: note.version, cards: Recall.parse(note.body, note.id) });
        }
    }
    const logs = new Map();
    let malformed = 0;
    const logList = await aide.call("notes.list", { prefix: LOG_PREFIX });
    if (logList.length >= LIST_LIMIT) warnings.push(`Only the first ${LIST_LIMIT} review logs are read; older reviews may be missing.`);
    for (const summary of logList) {
        const known = state.logs.get(summary.id);
        if (known && known.version === summary.version) {
            logs.set(summary.id, known);
            malformed += known.malformed;
            continue;
        }
        const note = await aide.call("notes.get", { id: summary.id });
        const parsed = Recall.parseLog(note.body);
        logs.set(note.id, { path: note.path, version: note.version, size: note.body.length, events: parsed.events, malformed: parsed.malformed });
        malformed += parsed.malformed;
    }
    if (malformed) warnings.push(`${malformed} review lines couldn't be read and were left out.`);
    state.notes = notes;
    state.logs = logs;
    state.cards = [...notes.values()].flatMap((note) => note.cards.map((card) => ({ ...card, noteId: note.id, title: note.title, path: note.path })));
    const events = [...logs.values()].flatMap((log) => log.events);
    state.latest = Recall.winners(events);
    state.firstSeen = new Map();
    for (const event of events) {
        const first = state.firstSeen.get(event.card);
        if (!first || event.ts < first) state.firstSeen.set(event.card, event.ts);
    }
    state.warnings = warnings;
    state.loaded = true;
}

/** Applies a review this device just saved, without reading everything again. */
function apply(event) {
    const current = state.latest.get(event.card);
    if (!current || Recall.later(event, current)) state.latest.set(event.card, event);
    const first = state.firstSeen.get(event.card);
    if (!first || event.ts < first) state.firstSeen.set(event.card, event.ts);
}

function counts(now = Date.now()) {
    const today = localDay(new Date(now));
    let due = 0;
    let fresh = 0;
    for (const card of state.cards) {
        const latest = state.latest.get(card.id);
        if (!latest) fresh += 1;
        else if (Date.parse(latest.due) <= now) due += 1;
    }
    let introduced = 0;
    for (const ts of state.firstSeen.values()) if (localDay(new Date(ts)) === today) introduced += 1;
    return { due, fresh, introduced, newLeft: Math.max(0, Math.min(fresh, state.newPerDay - introduced)) };
}

/**
 * The next card: the most overdue one, else a new one while today's new cards last. The day's new
 * cards are one budget across devices (first reviews today in every device's log); two devices
 * introducing cards at the same moment may go a little over it.
 */
function nextCard(now = Date.now()) {
    let best = null;
    for (const card of state.cards) {
        const latest = state.latest.get(card.id);
        if (latest && Date.parse(latest.due) <= now && (!best || latest.due < state.latest.get(best.id).due)) best = card;
    }
    if (best) return best;
    if (counts(now).newLeft <= 0) return null;
    return state.cards.find((card) => !state.latest.has(card.id)) ?? null;
}

/** This device's log note for this month, made when missing, the next part once one is full. */
async function logNote(now) {
    const date = new Date(now);
    const base = `${LOG_PREFIX}/${String(aide.instance).toLowerCase()}/${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
    for (let part = 1; part < 100; part++) {
        const path = part === 1 ? base : `${base}-${part}`;
        const found = [...state.logs.entries()].find(([, log]) => log.path === path);
        if (found && found[1].size < LOG_LIMIT) return found[0];
        if (found) continue;
        try {
            const note = await aide.call("notes.create", { path, body: "# Recall log\n\n" });
            state.logs.set(note.id, { path: note.path, version: note.version, size: note.body.length, events: [], malformed: 0 });
            return note.id;
        } catch (error) {
            // Another page of this device made it meanwhile: read the logs again and use it.
            const list = await aide.call("notes.list", { prefix: LOG_PREFIX });
            const made = list.find((summary) => summary.path === path);
            if (!made) throw error;
            const note = await aide.call("notes.get", { id: made.id });
            const parsed = Recall.parseLog(note.body);
            state.logs.set(note.id, { path: note.path, version: note.version, size: note.body.length, events: parsed.events, malformed: parsed.malformed });
            if (note.body.length < LOG_LIMIT) return note.id;
        }
    }
    throw new Error("the review log is full this month");
}

/** Keeps a log note as read now: its version and all its reviews (another page's too). */
function remember(note) {
    const parsed = Recall.parseLog(note.body);
    state.logs.set(note.id, { path: note.path, version: note.version, size: note.body.length, events: parsed.events, malformed: parsed.malformed });
    for (const event of parsed.events) apply(event);
}

/**
 * Whether the log note holds the review (a write whose answer was lost): true, false, or null
 * when the note couldn't be read to tell.
 */
async function landed(noteId, event) {
    try {
        const note = await aide.call("notes.get", { id: noteId });
        return note.body.includes(` e=${event.e}`);
    } catch {
        return null;
    }
}

const UNSURE = "couldn't tell whether the grade was saved; try again";

/**
 * Appends a review to this device's log; done only once it is in the note. A failed append is
 * retried only when the note shows it didn't land; when that can't be read, the review stays
 * pending (the same event, never a second one) and the error says so.
 */
async function write(event, noteId) {
    let failure;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const note = await aide.call("notes.append", { id: noteId, text: Recall.formatEvent(event) });
            remember(note);
            return;
        } catch (error) {
            failure = error;
            const found = await landed(noteId, event);
            if (found === true) return;
            if (found === null) throw new Error(UNSURE);
        }
    }
    throw failure;
}

async function grade(card, gradeId) {
    // A review whose write ended in doubt is settled first: if it landed, the card was answered;
    // while that can't be told, nothing else is written for the card.
    if (state.pending && state.pending.card === card.id) {
        const { event, noteId } = state.pending;
        const found = await landed(noteId, event);
        if (found === null) throw new Error(UNSURE);
        state.pending = null;
        if (found) {
            apply(event);
            return;
        }
    }
    const now = Date.now();
    const next = Recall.schedule(state.latest.get(card.id), gradeId, now);
    const event = { ts: new Date(now).toISOString(), card: card.id, grade: gradeId, ...next, e: uuid() };
    const noteId = await logNote(now);
    state.pending = { card: card.id, event, noteId };
    await write(event, noteId);
    state.pending = null;
    apply(event);
}

function item(card) {
    const now = Date.now();
    const latest = state.latest.get(card.id);
    const hints = Object.fromEntries(Recall.GRADES.map((g) => [g, Recall.span(Recall.schedule(latest, g, now).due, now)]));
    return { card, front: card.front, back: card.back, source: card.title || card.path, hints };
}

// MARK: Screens

let session = null;
let reloadTimer = null;
let reviewed = 0;

function overview() {
    session?.destroy();
    session = null;
    const kit = window.aideKit;
    const root = kit.mount(document.body);
    const { due, fresh, newLeft } = counts();
    const children = [
        kit.header({ meta: `${plural(state.cards.length, "card")} in ${state.prefixes.join(", ")}` }),
        ...state.warnings.map((text) => kit.banner({ text, tone: "warning" })),
        kit.stats([
            { value: due, label: "Due now" },
            { value: newLeft, label: "New today" },
            { value: fresh, label: "Not yet seen" },
        ]),
    ];
    if (due + newLeft > 0) children.push(kit.el("div", "aide-row-group", kit.button({ title: "Start review", style: "prominent", onClick: start })));
    else if (!state.cards.length)
        children.push(
            kit.empty({
                title: "No cards yet",
                message: `Write a line like "photosynthesis :: how plants make food from light" in a note under ${state.prefixes[0]}/, or a question, a line with ?, and its answer.`,
            }),
        );
    else children.push(kit.empty({ title: "All caught up", message: "Nothing is due. Come back when the reminder says so." }));
    root.append(kit.el("div", "aide-stack", children));
}

function start() {
    reviewed = 0;
    const startCounts = counts();
    const total = startCounts.due + startCounts.newLeft;
    session = window.aideKit.review(document.body, {
        meta: () => {
            const { due, newLeft } = counts();
            return `${due} due · ${newLeft} new left today`;
        },
        progress: () => ({ value: reviewed, total: Math.max(total, reviewed) }),
        next: async () => {
            const card = nextCard();
            return card ? item(card) : null;
        },
        grade: async (current, gradeId) => {
            await grade(current.card, gradeId);
            reviewed += 1;
        },
        done: { title: "All done", message: "That's everything due for now.", action: { title: "Back", onClick: overview } },
    });
}

function scheduleReload() {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(async () => {
        try {
            await load();
            if (session) session.refresh();
            else overview();
        } catch (error) {
            console.error(error);
        }
    }, 1500);
}

async function main() {
    const kit = window.aideKit;
    kit.mount(document.body).append(kit.el("p", "aide-caption", "Reading your cards…"));
    try {
        await readSettings();
        await load();
        overview();
    } catch (error) {
        kit.mount(document.body).append(kit.banner({ text: `Couldn't read the cards: ${error.message || error}`, tone: "danger" }));
        return;
    }
    const watch = (note) => {
        if (under(note.path, "recall") || state.prefixes.some((prefix) => under(note.path, prefix))) scheduleReload();
    };
    aide.on("note.created", watch);
    aide.on("note.changed", watch);
}

if (globalThis.aide && globalThis.window) main();
