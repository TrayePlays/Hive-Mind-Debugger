import { Socket } from "net"
import { DebugProtocol } from '@vscode/debugprotocol';
import { handleRequest } from "./api";
import { serverData } from "./serverData";
import { messageDiscord } from "./discord";
const MAX_REQUESTS_IN_30 = serverData.config.MAX_REQUESTS_IN_30;
const LATEST_VERSION = serverData.config.LATEST_VERSION;
const FIRST_VERSION = serverData.config.FIRST_VERSION;

// Set like this to add more types in the future
type CommandResponse = HivemindData

interface HivemindData {
    version: number;
    name: string;
}

export function resetUtils() {
    for (const socket of serverData.connectedSockets) {
        socket.requestManager?.rejectPendingRequests("Utils reloaded");
    }
}

export function getSocketsWithSamePurpose(name: string) {
    return serverData.connectedSockets.filter(s => s.hivemindData?.name == name).length
}

// LIST OF STATEVENT2: 
// entities (checks how much mobs are in the world)
// server_tick_timings (how long a level, script, and script job tick takes to send?)
// networking (shosocket the packets recieved and stuff but doesnt have the data it just has the byte amount D:)
// fine_grained_subscribers (lists all subscribers but idk if it tells u the ones that are yours)
// dynamic_property_values (wow its all the dps who would have guessed)
// handle_count (gets the count for entities that are in each pack?)
// app_memory (gets the bytes that are used and that are free)
// chunks (gets the chunks in every dimension thats loaded ticking or loading)
// commands (triggers when u run a command :O and shosocket the type of the source 'AutomaticPlayer' (socket) 'Player' 'Scripting')
// dynamic_properties (gets save velocity and total memory used of the dynamic properties)

interface StatEvent2 {
    tick: number
    type: 'StatEvent2',
    // Not complete it has more stats. But this stat is the one I'm tracking.
    stats: DPStats[]
}

interface DPStats {
    name: string;
    should_aggregate: boolean
    children: { name: string, should_aggregate: boolean, values: any[] }[]
}

export function onReload(socket: ModSocket) {
    const raw = socket.socket;

    if (socket.streamParser) {
        try {
            raw.unpipe(socket.streamParser as any);
        } catch { }
        socket.streamParser.removeAllListeners();
        socket.streamParser = undefined;
    }

    raw.removeAllListeners("data");
    raw.removeAllListeners("error");
    raw.removeAllListeners("close");

    raw.resume();
    let chunk;
    while ((chunk = raw.read()) !== null) { }
}

export function onClose(socket: ModSocket | undefined, noDelete = false) {
    if (!socket) return;
    if (socket.streamParser != undefined) {
        socket.socket.unpipe(socket.streamParser as any)
        socket.streamParser.removeAllListeners();
        socket.streamParser = undefined;
    }

    serverData.connectedSockets = serverData.connectedSockets.filter(a => a != socket);
    socket.socket.removeAllListeners("data");
    socket.socket.removeAllListeners("error");
    socket.socket.removeAllListeners("close");
    socket.socket.removeAllListeners("timeout");
    socket.sendDiscord = undefined;
    socket.rateLimit = undefined;
    socket.requests.clear();
    socket!.requestManager = undefined;
    clearInterval(socket.interval);
    socket.interval = undefined;
    socket.socket.destroy();
    if (socket.sendDiscord && socket.hivemindData) messageDiscord(`# API (${socket.hivemindData.name}) Disconnected\n**[:bee:]** ${serverData.connectedSockets.length} Online`);
    console.log(`Socket disconnected! ${serverData.connectedSockets.length} Online!`);
    socket.hivemindData = undefined;
}

export async function onConnectionComplete(protocolVersion: number, socket: ModSocket, targetModuleUuid?: string, passcode?: string) {
    sendDebuggeeMessage(socket, {
        type: 'protocol',
        version: protocolVersion,
        target_module_uuid: targetModuleUuid,
        passcode: passcode,
    });

    sendDebuggeeMessage(socket, {
        event: "initialized",
        type: "event"
    });

    sendDebuggeeMessage(socket, {
        type: 'resume',
    });

    if (!socket.isConnected) {
        const data = await Promise.race([
            runCommandAsync(socket, `purpose`),
            runCommandAsync(socket, `scriptevent hivemind:purpose`)
        ])

        if (data) {
            socket.hivemindData = data;
        }

        if (!socket.hivemindData) {
            console.warn(`Socket has no purpose`);
            sendMessage(socket, `§4ERROR: §cNo purpose response! Check your version!`)
            await sleep(2000);
            onClose(socket)
            return;
        }

        if (socket.hivemindData.name.includes(" ")) {
            console.warn(`Socket has space in the name`);
            sendMessage(socket, `§4ERROR: §cRemove the spaces in the API NAME!`)
            await sleep(2000);
            onClose(socket)
            return;
        }
    
        if (socket.hivemindData.name.length > 20) {
            console.warn(`Socket name too long`);
            sendMessage(socket, `§4ERROR: §cAPI Name too long! §7(20 char max)`)
            await sleep(2000);
            onClose(socket)
            return;
        }

        if (socket.hivemindData.version > LATEST_VERSION || socket.hivemindData.version < FIRST_VERSION || isNaN(socket.hivemindData.version)) {
            console.warn(`Socket version ${socket.hivemindData.version} DISCONNECTED`);
            sendMessage(socket, `§4ERROR: §cBro, how did you get this version?!`)
            await sleep(2000);
            onClose(socket)
            return;
        }

        socket.sendDiscord = true
        const totalOnline = serverData.connectedSockets.length;
        const onlineCount = getSocketsWithSamePurpose(socket.hivemindData.name)

        console.log(`Socket connected with purpose: ${socket.hivemindData.name} (${totalOnline} Online)`)

        messageDiscord(`# API (${socket.hivemindData.name}) Connected\n**[:bee:]** ${totalOnline} Online\n-# There ${onlineCount === 1 ? "is" : "are"} ${onlineCount} Online using the mod`)
        sendMessage(socket, `§eWorld connected to §6Hive Mind API v${socket.hivemindData.version}! ${socket.hivemindData.version != LATEST_VERSION ? "§7(§bUpdate Available§7) " : ""}§7(§a${totalOnline} Online§7)`);
        sendMessage(socket, `§7There ${onlineCount === 1 ? "is" : "are"} ${onlineCount} Online§7 playing the same mod as you`)
    }
};

function handleProtocolEvent(socket: ModSocket, protocolCapabilities: ProtocolCapabilities): void {
    socket.protocolCapabilities = protocolCapabilities;
    if (protocolCapabilities.plugins[0] == undefined) {
        onClose(socket);
        return;
    }
    socket.version = protocolCapabilities.version;
    onConnectionComplete(protocolCapabilities.version, socket, protocolCapabilities.plugins[0].module_uuid);
}

async function runCommandAsync(socket: ModSocket, command: string) {
    return new Promise<CommandResponse | undefined>((resolve) => {
        const socketStreamParser = new MessageStreamParser();

        let dpChecks = 0;
        const cleanup = () => {
            clearTimeout(timeout);
            socketStreamParser.off('message', cb);
            socket.socket.unpipe(socketStreamParser as any);
        };

        // takes like 500 per msg
        const timeout = setTimeout(() => {
            cleanup();
            resolve(undefined);
        }, 10_000)


        const cb = (envelope: any) => {
            if (envelope.type == "event" && envelope.event.type == "StatEvent2") {

                const evt = envelope.event as StatEvent2
                for (const stat of evt.stats) {
                    if (stat.name == "dynamic_property_values") {
                        const dps = stat.children
                        const requestDP = dps.find(a => a.name == `hivemindResponse`);

                        if (requestDP) {
                            cleanup();
                            try {
                                const data = JSON.parse(requestDP.values[0])
                                resolve(data);
                            } catch {
                                resolve(undefined)
                            }
                            return;
                        }

                        if (dpChecks > 5) {
                            cleanup();
                            console.warn(`No response in 5 checks`)
                            resolve(undefined)
                        }

                        dpChecks++;
                    }
                }
            }
        }

        runCommand(socket, command);

        socketStreamParser.on('message', cb);

        socket.socket.pipe(socketStreamParser as any);
    })
}

// Debugee (MC) has sent an event.
export function handleDebugeeEvent(socket: ModSocket, eventMessage: any) {
    if (eventMessage.type === 'ProtocolEvent') {
        handleProtocolEvent(socket, eventMessage as ProtocolCapabilities);
    } else if (eventMessage.type === 'StatEvent2') {
        const evt = eventMessage as StatEvent2
        for (const stat of evt.stats) {
            if (stat.name == "dynamic_property_values") {
                const dps = stat.children
                const requestDP = dps.filter(a => a.name.startsWith(`hivemindRequest`)).sort((a, b) => parseInt(b.name.split("hivemindRequest")[1].split(":")[0]) - parseInt(a.name.split("hivemindRequest")[1].split(":")[0]));
                for (const dp of requestDP) {
                    //.values[0] holds the dynamic property value
                    handleRequest(dp.values[0], socket)
                }
            }
        }
    }
}

export function runCommand(socket: ModSocket, command: string): void {
    if (socket.version < ProtocolVersion.SupportProfilerCaptures || socket.version >= ProtocolVersion.SupportCerealSerialization) {
        sendDebuggeeMessage(socket, {
            type: 'minecraftCommand',
            command: command,
            dimension_type: 'overworld',
        });
    } else {
        sendDebuggeeMessage(socket, {
            type: 'minecraftCommand',
            command: {
                command: command,
                dimension_type: 'overworld',
            },
        });
    }
}

export function sendMessage(socket: ModSocket, message: string) {
    runCommand(socket, `tellraw @a {"rawtext":[{"text":"${message}"}]}`)
}

export class ModSocket {
    public requestManager: RequestManager | undefined;
    public requests = new Map<number, any>();
    public socket: Socket;
    public version: number;
    public interval?: NodeJS.Timeout;
    public isConnected: boolean;
    protocolCapabilities?: ProtocolCapabilities;
    streamParser?: MessageStreamParser
    isDiscord?: boolean
    hivemindData?: HivemindData;
    limitedTime?: number
    rateLimit?: {
        tokens: number
        lastRefill: number
    }

    sendDiscord?: boolean

    constructor(existingSocket: Socket, connectionData: { isConnected?: boolean, protocolCapabilities?: ProtocolCapabilities } = { isConnected: false, protocolCapabilities: undefined }) {
        this.rateLimit = {
            tokens: MAX_REQUESTS_IN_30,
            lastRefill: Date.now()
        }
        this.protocolCapabilities = connectionData.protocolCapabilities
        this.isConnected = connectionData.isConnected ?? false
        this.version = 0
        this.socket = existingSocket;
        this.requestManager = new RequestManager(this);
    }
}

// Thanks Mojang https://github.com/Mojang/minecraft-debugger/
// Copyright (C) Microsoft Corporation. All rights reserved.

// Sent from the webview to the debug session
export interface DebuggerRequestArguments {
    request: string;
    args?: unknown;
}

export async function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

// Received from the debuggee (MC) in response to a DebuggerRequestEnvelope
export interface DebuggeeResponseEnvelope {
    type: IncomingEventType.DebuggeeResponse;
    request_seq: number;
    args?: unknown;
    success?: boolean;
    response_message?: string;
}

// Module mapping for getting line numbers for a given module
export interface ModuleMapping {
    [moduleName: string]: string;
}

// capabilites based on protocol version
export interface MinecraftCapabilities {
    supportsCommands: boolean;
    supportsProfiler: boolean;
    supportsBreakpointsAsRequest: boolean;
    supportsDebuggerRequests: boolean;
}

// protocol version history
// 1 - initial version
// 2 - add targetModuleUuid to protocol event
// 3 - add array of plugins and target module ids to incoming protocol event
// 4 - mc can require a passcode to connect
// 5 - debugger can take mc script profiler captures
// 6 - breakpoints as request, MC can reject
// 7 - support for debugger requests, MC can reject or respond with args
// 8 - New serialization tech (use Cereal)

export enum ProtocolVersion {
    _Unknown = 0,
    Initial = 1,
    SupportTargetModuleUuid = 2,
    SupportTargetSelection = 3,
    SupportPasscode = 4,
    SupportProfilerCaptures = 5,
    SupportBreakpointsAsRequest = 6,
    SupportDebuggerRequests = 7,
    SupportCerealSerialization = 8,
}

export interface PluginDetails {
    name: string;
    module_uuid: string;
}

export interface ProtocolCapabilities {
    type: string;
    version: number;
    plugins: PluginDetails[];
    require_passcode?: boolean;
}

export enum IncomingEventType {
    Stopped = 'StoppedEvent',
    Thread = 'ThreadEvent',
    Print = 'PrintEvent',
    Notification = 'NotificationEvent',
    Protocol = 'ProtocolEvent',
    Stat2 = 'StatEvent2',
    Schema = 'SchemaEvent',
    ProfilerCapture = 'ProfilerCapture',
    DebuggeeResponse = 'debuggee-response',
}

export enum OutgoingEventType {
    Protocol = 'protocol',
    MinecraftCommand = 'minecraftCommand',
    StartProfiler = 'startProfiler',
    StopProfiler = 'stopProfiler',
    StopOnException = 'stopOnException',
    Resume = 'resume',
    Request = 'request',
    Breakpoints = 'breakpoints',
    DebuggerRequest = 'debugger-request'
}


export interface ProtocolResponse {
    type: OutgoingEventType.Protocol;
    version: number;
    target_module_uuid?: string;
    passcode?: string;
}

// Sent from the debug session to the debuggee (MC)
export interface DebuggerRequestEnvelope {
    type: OutgoingEventType.DebuggerRequest;
    request: {
        request_seq: number;
        request: string;
        args?: unknown;
    };
}

interface PendingDebuggerRequest {
    resolve: (value: DebuggeeResponseEnvelope) => void;
    reject: (reason?: unknown) => void;
    timeout?: ReturnType<typeof setTimeout>;
}

export function sendDebuggeeMessage(socket: ModSocket, envelope: unknown): void {
    if (!socket || !socket.socket.write) {
        return;
    }

    if (envelope === undefined) {
        console.warn("sendDebuggeeMessage: envelope is undefined");
        return;
    }

    const json = JSON.stringify(envelope);
    if (!json) {
        console.warn("sendDebuggeeMessage: failed to stringify envelope");
        return;
    }

    const jsonBuffer = Buffer.from(json);
    // length prefix is 8 hex followed by newline = 012345678\n
    // not efficient, but protocol is then human readable.
    // json = 1 line json + new line
    const messageLength = jsonBuffer.byteLength + 1;
    let length = '00000000' + messageLength.toString(16) + '\n';
    length = length.substring(length.length - 9);
    const lengthBuffer = Buffer.from(length);
    const newline = Buffer.from('\n');
    const buffer = Buffer.concat([lengthBuffer, jsonBuffer, newline]);

    socket.socket.write(buffer);
}

export class RequestManager {
    private readonly _defaultDebuggerRequestTimeoutMs = 10000;
    private readonly _pendingRequests = new Map<number, PendingDebuggerRequest>();
    private readonly _sender: ModSocket;

    public constructor(sender: ModSocket) {
        this._sender = sender;
    }

    public sendDebuggerRequest(
        response: DebugProtocol.Response,
        debuggerRequestArgs: DebuggerRequestArguments,
        timeoutMs: number = this._defaultDebuggerRequestTimeoutMs,
    ): Promise<DebuggeeResponseEnvelope> {
        const { request, args } = debuggerRequestArgs;
        const seq = response.request_seq;

        return new Promise((resolve, reject) => {
            // Set a timeout to reject the promise if a response is not received within the specified time
            const timeout: ReturnType<typeof setTimeout> = setTimeout(() => {
                if (!this._pendingRequests.has(seq)) {
                    return;
                }

                this._pendingRequests.delete(seq);
                reject(new Error(`Debugger request '${request}' timed out after ${timeoutMs}ms.`));
            }, timeoutMs);

            this._pendingRequests.set(seq, {
                resolve,
                reject,
                timeout,
            });

            // Create an envelope to hold the request, and send it to the debuggee
            const envelope: DebuggerRequestEnvelope = {
                type: OutgoingEventType.DebuggerRequest,
                request: {
                    request_seq: seq,
                    request,
                    args,
                },
            };
            sendDebuggeeMessage(this._sender, envelope);
        });
    }

    public handleDebuggeeResponse(envelope: DebuggeeResponseEnvelope): boolean {
        const pending = this._pendingRequests.get(envelope.request_seq);
        if (!pending) {
            // Can happen if the request times out before a response is received
            return false;
        }

        // Remove the pending request from the map and clear its timeout
        this._pendingRequests.delete(envelope.request_seq);
        if (pending.timeout) {
            clearTimeout(pending.timeout);
        }

        if (!envelope.success) {
            pending.reject(new Error(envelope.response_message ?? 'Debuggee request failed.'));
        } else {
            pending.resolve(envelope);
        }

        return true;
    }

    public rejectPendingRequests(message: string): void {
        for (const pendingRequest of this._pendingRequests.values()) {
            if (pendingRequest.timeout) {
                clearTimeout(pendingRequest.timeout);
            }
            pendingRequest.reject(new Error(message));
        }

        this._pendingRequests.clear();
    }
}

// Copyright (C) Microsoft Corporation.  All rights reserved.

const Parser = require('stream-parser');
const Transform = require('stream').Transform;

// Data transform attached to socket.
// Parses messages to json as they arrive from debugee,
// then raises them as events for consumption by the DA.

export class MessageStreamParser extends Transform {
    constructor() {
        super();
        this._bytes(9, this.onLength);
    }

    private onLength(buffer: Buffer) {
        const hex = buffer.toString().trim();
        const length = parseInt(hex, 16);

        if (!Number.isFinite(length) || length <= 0) {
            console.warn("Invalid length header received:", hex);

            this._bytes(9, this.onLength);
            return;
        }

        this.emit('length', length);
        this._bytes(length, this.onMessage);
    }


    private onMessage(buffer: Buffer) {
        const json = JSON.parse(buffer.toString());
        this.emit('message', json);
        this._bytes(9, this.onLength);
    }
}

Parser(MessageStreamParser.prototype);