import { Socket } from "net";
import { serverData } from "./serverData";

export function messageDiscord(message: string) {
    if (!serverData.discordSocket) return;
    console.log(`wrote ${JSON.stringify({ message, type: "send" }, null, 4)} to discord`)
    serverData.discordSocket.write(JSON.stringify({ message, type: "send" }));
}

export function onDiscordClose(socket: Socket) {
    if (!socket) return;
    socket.destroy();
    serverData.discordSocket = undefined;
}

export function onDiscordMessage(buffer: Buffer) {
    if (!serverData.discordSocket) return;
    const rawString = buffer.toString().trim();
    const parsed = JSON.parse(rawString);
    if (parsed.type == "get") {
        if (parsed.name == "stats") {
            serverData.discordSocket.write(JSON.stringify({type: "stats", data: serverData.stats}));
        }
    }
}