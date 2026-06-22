import { Socket } from "net";
import { serverData } from "./serverData";

export function messageDiscord(message: string) {
    if (!serverData.discordSocket) return;
    serverData.discordSocket.write(message);
}

export function onDiscordClose(socket: Socket) {
    if (!socket) return;
    socket.destroy();
    serverData.discordSocket = undefined;
}