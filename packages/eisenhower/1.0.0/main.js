// Important = priority high or highest; urgent = due (or scheduled) within two days.
const DAY = 24 * 60 * 60 * 1000;

const quadrant = (todo, today) => {
    const important = todo.priority === "high" || todo.priority === "highest";
    const date = todo.due || todo.scheduled;
    const urgent = date !== undefined && new Date(date) - today <= 2 * DAY;
    if (important && urgent) return "do";
    if (important) return "schedule";
    if (urgent) return "delegate";
    return "drop";
};

const status = (text) => {
    document.getElementById("status").textContent = text;
};

const render = (todos) => {
    const today = new Date(new Date().toISOString().slice(0, 10));
    document.querySelectorAll("section ul").forEach((list) => list.replaceChildren());
    for (const todo of todos) {
        const item = document.createElement("li");
        const done = document.createElement("button");
        done.setAttribute("aria-label", "Complete " + todo.title);
        done.addEventListener("click", () => complete(todo));
        const label = document.createElement("span");
        label.textContent = todo.title;
        item.append(done, label);
        const date = todo.due || todo.scheduled;
        if (date) {
            const due = document.createElement("span");
            due.className = "due";
            due.textContent = date;
            item.append(due);
        }
        document.querySelector(`section[data-q="${quadrant(todo, today)}"] ul`).append(item);
    }
    status(`${todos.length} open`);
};

const load = async () => {
    try {
        render(await aide.call("todos.list"));
    } catch (error) {
        status(String(error));
    }
};

const complete = async (todo) => {
    try {
        await aide.call("todos.setStatus", {
            noteId: todo.noteId,
            line: todo.line,
            version: todo.version,
            status: "x",
            text: todo.text,
        });
    } catch (error) {
        status(String(error));
        return;
    }
    await load();
};

document.addEventListener("visibilitychange", () => {
    if (!document.hidden) load();
});
load();
