import { Server } from 'net';
import { serverData } from './serverData';
import path from 'path';
import fs from 'fs';
import { onReload } from './utils';
import { loadConfig } from './configLoader';

// Using port 19144 because its default port
const server = new Server().listen(19144);
console.log(`Started Server.\nConnect with /script debugger connect or /script debugger connect traye.ddns.net`);

server.on("error", (e) => {
    console.warn(e.stack)
})

server.on("connection", async (socket) => {
    const start = reloadStart().start;
    start(socket);
});

function watchFileAndReload(file: string, onChange: () => void) {
    let initialized = false;
    let timeout: NodeJS.Timeout | null = null;

    fs.watch(file, () => {
        if (timeout) clearTimeout(timeout);

        if (!initialized) {
            initialized = true;
            return;
        }
        timeout = setTimeout(() => {
            onChange();
        }, 50)
    });
}

function reloadServer() {
    const { reload } = reloadStart();

    for (const socket of serverData.connectedSockets) {
        onReload(socket);
        reload(socket);
    }
}

function reloadConfig() {
    console.log("Config updated!");
    serverData.config = loadConfig();
}

// For hot-reloading
watchFileAndReload(path.join(__dirname, "./api.js"), reloadServer);
watchFileAndReload(path.join(__dirname, "./utils.js"), reloadServer);
watchFileAndReload(path.join(__dirname, "./start.js"), reloadServer);

watchFileAndReload(path.join(__dirname, "./config.js"), reloadConfig);

function reloadStart() {
    require("./utils.js").resetUtils();
    delete require.cache[require.resolve("./api.js")]
    delete require.cache[require.resolve("./utils.js")];
    delete require.cache[require.resolve("./start.js")];
    return require("./start.js");
}