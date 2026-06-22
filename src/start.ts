import { Socket } from "net";
import { DebuggeeResponseEnvelope, handleDebugeeEvent, MessageStreamParser, ModSocket, onClose, onConnectionComplete, ProtocolCapabilities } from "./utils";
import { onDiscordClose } from "./discord";
import { serverData } from "./serverData";
import * as dotenv from "dotenv"

dotenv.config();

export function start(socket: Socket, connectionData: {isConnected?: boolean, protocolCapabilities?: ProtocolCapabilities}) {
    const modSocket = new ModSocket(socket, connectionData);
    onInitConnection(modSocket);
}

export function reload(socket: ModSocket) {
    socket.isConnected = true;
    onDebugeeConnected(socket);
}

function onInitConnection(socket: ModSocket) {
    if (socket.isConnected) {
        onDebugeeConnected(socket);
        return
    };
    const earlyErrorHandler = (e: Error) => {
        console.warn("Early connection error before handshake:", e.message);
    };
    socket.socket.on('error', earlyErrorHandler);

    const checkHandshake = (buffer: Buffer) => {
        const rawString = buffer.toString().trim();

        const queryString = rawString.includes('?') ? rawString.split('?')[1] || rawString : rawString;
        const params = new URLSearchParams(queryString);
        const key = params.get('key');

        socket.socket.off('error', earlyErrorHandler);

        if (key === process.env.KEY) {
            console.log(`Discord Bot Connected!`);
            socket.socket.on("error", (e) => {
                console.warn(e.stack);
            });
            socket.socket.on("close", () => {
                onDiscordClose(socket.socket);
            });
            socket.socket.off('data', checkHandshake);
            serverData.discordSocket = socket.socket;
            return;
        }

        socket.socket.off('data', checkHandshake);

        socket.socket.unshift(buffer);

        onDebugeeConnected(socket);
    };

    socket.socket.on('data', checkHandshake);

    socket.socket.on("close", () => {
        socket.socket.off("data", checkHandshake);
    });
}

function onDebugeeConnected(socket: ModSocket) {
    socket.streamParser = new MessageStreamParser();

    socket.socket.setKeepAlive(true, 15000);

    socket.socket.on("close", () => {
        onClose(socket);
    });

    socket.streamParser.on('message', (envelope: any) => {
        receiveDebugeeMessage(socket, envelope);
    });

    socket.socket.on('error', (e: Error) => {
        console.warn(e.stack);
    });

    socket.socket.pipe(socket.streamParser as any);
    if (socket.isConnected && socket.protocolCapabilities) {
        onConnectionComplete(socket.protocolCapabilities?.version, socket, socket.protocolCapabilities?.plugins[0].module_uuid);
    }
}

function receiveDebugeeMessage(socket: ModSocket, envelope: any) {
    if (envelope.type === 'event') {
        handleDebugeeEvent(socket, envelope.event);
    } else if (envelope.type === 'debuggee-response') {
        socket.requestManager?.handleDebuggeeResponse(envelope as DebuggeeResponseEnvelope);
    } else if (envelope.type === 'response') {
        handleDebugeeResponse(socket, envelope);
    }
}

function handleDebugeeResponse(socket: ModSocket, envelope: any) {
    const requestSeq: number = envelope.request_seq;
    const pending = socket.requests.get(requestSeq);
    if (!pending) {
        return;
    }

    socket.requests.delete(requestSeq);

    if (envelope.error) {
        if (pending.onFail) {
            pending.onFail(new Error(envelope.error));
        }
        console.error(`Debugee response error: ${envelope.error}`);
    } else {
        if (pending.onSuccess) {
            pending.onSuccess(envelope.body);
        }
    }
}