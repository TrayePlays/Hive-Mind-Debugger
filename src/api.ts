import { serverData } from "./serverData"
import { acquireRequestWriteLock, ModSocket, runCommand, sleep } from "./utils"
import { parseMidi } from "midi-file"
import puppeteer from "puppeteer"
import sharp from "sharp";
const MAX_REQUESTS_IN_30 = serverData.config.MAX_REQUESTS_IN_30;
const MAX_MIDI_IN_5 = serverData.config.MAX_MIDI_IN_5;

interface Request {
    type: RequestTypes
    id: string
    apiName: string,
    data: RequestData,
    scriptEvent: boolean
}

type RequestData = HttpRequestData

interface HttpRequestData {
    uri: string,
    init?: RequestInit,
    extraInfo?: ExtraHttpRequestInfo
}

interface ExtraHttpRequestInfo {
    crop?: { left: number, top: number, width: number, height: number };
}

// More request types later
enum RequestTypes {
    HttpRequest = "httpRequest", // v0.2+
    MidiRequest = "midiRequest" // v0.4+
}

enum ServerStatusResponse {
    Ran = -1,
    Success = 0,
    Failure = 1
}

async function sendResponse(socket: ModSocket, data: { status: ServerStatusResponse, id: string, data?: string, message?: string }, scriptEvent = true) {
    const scriptEventQuote = scriptEvent ? "" : `"`
    await runCommand(socket, `${scriptEvent ? "scriptevent hivemind:" : ""}respond ${scriptEventQuote}${data.id}|${data.status}${data.message ? `|${data.message}` : ""}${data.data ? `|${data.data}` : ""}${scriptEventQuote}`)
}

async function runBatched(socket: ModSocket, commands: string[], batchSize = 1, delay = 1) {
    let index = 0;

    while (index < commands.length) {
        const end = Math.min(index + batchSize, commands.length);

        for (let i = index; i < end; i++) {
            if (Math.floor(end / 2) == i) await new Promise(r => setImmediate(r));
            await runCommand(socket, commands[i]);
        }

        index = end;

        if (index < commands.length) {
            await sleep(delay);
        }
    }
}

function checkRateLimit(socket: ModSocket): boolean {
    if (!socket || socket.socket.destroyed || !socket.socket.writable) {
        return false;
    }

    const now = Date.now();

    if (!socket.rateLimit) {
        socket.rateLimit = {
            tokens: MAX_REQUESTS_IN_30,
            lastRefill: now
        };
    }

    const bucket = socket.rateLimit;

    const refillRate = MAX_REQUESTS_IN_30 / 30000;
    const elapsed = now - bucket.lastRefill;

    bucket.tokens = Math.min(MAX_REQUESTS_IN_30, bucket.tokens + elapsed * refillRate);

    bucket.lastRefill = now;

    if (bucket.tokens < 1) {
        return false;
    }

    bucket.tokens -= 1;
    return true;
}

function checkMidiLimit(socket: ModSocket): boolean {
    if (!socket || socket.socket.destroyed || !socket.socket.writable) {
        return false;
    }

    const now = Date.now();

    if (!socket.midiLimit) {
        socket.midiLimit = {
            tokens: MAX_MIDI_IN_5,
            lastRefill: now
        };
    }

    const bucket = socket.midiLimit;

    const refillRate = MAX_MIDI_IN_5 / 5000;
    const elapsed = now - bucket.lastRefill;

    bucket.tokens = Math.min(MAX_MIDI_IN_5, bucket.tokens + elapsed * refillRate);

    bucket.lastRefill = now;

    if (bucket.tokens < 1) {
        return false;
    }

    bucket.tokens -= 1;
    return true;
}

async function queueRequest(socket: ModSocket, request: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        socket.requestQueue.push(async () => {
            try {
                await request();
                resolve();
            } catch (err) {
                reject(err);
            }
        });

        processRequestQueue(socket);
    });
}

async function processRequestQueue(socket: ModSocket): Promise<void> {
    if (socket.processingRequests) return;

    socket.processingRequests = true;

    try {
        while (socket.requestQueue.length > 0) {
            const request = socket.requestQueue.shift();

            if (!request) continue;

            try {
                await request();
            } catch (err) {
                console.error("Request failed:", err);
            }
        }
    } finally {
        socket.processingRequests = false;

        if (socket.requestQueue.length > 0) {
            processRequestQueue(socket);
        }
    }
}

export function handleRequest(data: string, socket: ModSocket) {
    queueRequest(socket, () => handleRequestAsync(data, socket));
}

export async function handleRequestAsync(data: string, socket: ModSocket) {
    try {
        if (socket.hivemindData?.name == "SongPlayer") console.log("HANDLE REQUEST CALLED", Date.now());
        const requestStr = data
        const request = JSON.parse(requestStr) as Request

        if (socket.hivemindData?.name == "SongPlayer") console.log("HANDLE REQUEST", request.id, Date.now());

        const scriptEvent = request.scriptEvent
        const scriptEventQuote = scriptEvent ? "" : `"`
        await runCommand(socket, `${scriptEvent ? "scriptevent hivemind:" : ""}set remove ${scriptEventQuote}${request.id}${scriptEventQuote} hivemindRequest${request.id}`)

        if (request.id == undefined) {
            await sendResponse(socket, { status: ServerStatusResponse.Failure, id: "ERROR", message: "No request id!" }, scriptEvent)
            return;
        }
        if (!Object.values(RequestTypes).includes(request?.type)) {
            await sendResponse(socket, { status: ServerStatusResponse.Failure, id: request.id, message: "Unknown request type!" }, scriptEvent)
            return;
        };

        await sendResponse(socket, { status: ServerStatusResponse.Ran, id: request.id }, scriptEvent);

        if (request.type == RequestTypes.HttpRequest) {
            if (!checkRateLimit(socket)) {
                await sendResponse(socket, { status: ServerStatusResponse.Failure, id: request.id, message: `You are rate limited!` }, scriptEvent)
                return;
            }
            if (request.data.uri == undefined) {
                await sendResponse(socket, { status: ServerStatusResponse.Failure, id: request.id, message: "Unknown uri!" }, scriptEvent)
                return;
            }
            try {
                const res = await fetch(request.data.uri, request.data.init);
                if (!res.ok) {
                    const errMsg = await res.text()
                    await sendResponse(socket, { status: ServerStatusResponse.Failure, id: request.id, message: `HTTP Error! Status code: ${res.status}`, data: errMsg }, scriptEvent)
                    return;
                }

                const contentType = res.headers.get('content-type') || '';
                const maxResponseSize = 10 * 1024 * 1024;
                const contentLength = Number(res.headers.get('content-length') || 0);

                if (contentLength > maxResponseSize) {
                    await sendResponse(socket, { id: request.id, status: ServerStatusResponse.Failure, message: `Response is too large! Maximum size is 10 MB.` }, scriptEvent)
                    return;
                }

                let dataReceived: any;
                if (contentType.includes("application/json")) {
                    dataReceived = await res.json();
                } else if (contentType.startsWith("image/")) {
                    const arrBuffer = await res.arrayBuffer();

                    if (arrBuffer.byteLength > maxResponseSize) {
                        await sendResponse(socket, { id: request.id, status: ServerStatusResponse.Failure, message: `Response is too large! Maximum size is 10 MB.` }, scriptEvent)
                        return;
                    }

                    const buffer = Buffer.from(arrBuffer);
                    let image = sharp(buffer).ensureAlpha()
                    const crop = request.data.extraInfo?.crop

                    if (crop != undefined) {
                        image = image.extract(crop);
                    }

                    const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });

                    dataReceived = {
                        data: Array.from(data),
                        width: info.width,
                        height: info.height
                    };
                } else {
                    if (!res.body) {
                        dataReceived = await res.text();
                    } else {
                        const reader = res.body.getReader();
                        const chunks: Buffer[] = [];
                        let totalSize = 0;

                        while (true) {
                            const { done, value } = await reader.read();

                            if (done) break;

                            totalSize += value.byteLength;

                            if (totalSize > maxResponseSize) {
                                await reader.cancel();
                                await sendResponse(socket, { id: request.id, status: ServerStatusResponse.Failure, message: `Response is too large! Maximum size is 10 MB.` }, scriptEvent)
                                return;
                            }

                            chunks.push(Buffer.from(value));
                        }

                        dataReceived = Buffer.concat(chunks).toString("utf8");
                    }
                }

                let str = JSON.stringify(JSON.stringify(dataReceived)).slice(1, -1);
                if (scriptEvent) str = JSON.stringify(dataReceived);

                // 2074 max length of command
                const maxChunk = 2000 - request.id.length - (scriptEvent ? 21 : 0);
                const release = await acquireRequestWriteLock(socket);
                try {
                    let i = 0;
                    while (i < str.length) {
                        let end = Math.min(i + maxChunk, str.length);
                        let backslashCount = 0;
                        while (end - 1 - backslashCount >= i && str[end - 1 - backslashCount] === '\\') {
                            backslashCount++;
                        }
                        if (backslashCount % 2 === 1 && end < str.length) {
                            end++;
                        }
                        const chunk = str.slice(i, end);
                        const command = `${scriptEvent ? "scriptevent hivemind:" : ""}set add ${scriptEventQuote}${request.id}${scriptEventQuote} ${scriptEventQuote}${chunk}${scriptEventQuote}`;
                        if (socket.hivemindData?.name == "SongPlayer") {
                            console.log({
                                id: request.id,
                                chunk: i,
                                total: str.length,
                                queue: socket.writeQueue.length,
                                writable: socket.socket.writable,
                                destroyed: socket.socket.destroyed,
                                writableLength: socket.socket.writableLength
                            });
                        }
                        await runCommand(socket, command);
                        i = end;
                    }
                } finally {
                    release();
                }

                await sendResponse(socket, { id: request.id, status: ServerStatusResponse.Success, message: `Get your data with .getData()` }, scriptEvent)
            } catch (e: any) {
                console.error(e.stack);
                await sendResponse(socket, { id: request.id, status: ServerStatusResponse.Failure, message: `Failed to get data from website: ${e.message}` }, scriptEvent)
            }
        }
        if (request.type == RequestTypes.MidiRequest) {
            if (!checkMidiLimit(socket)) {
                await sendResponse(socket, { status: ServerStatusResponse.Failure, id: request.id, message: `You are midi limited!` }, scriptEvent)
                return;
            }
            if (request.data.uri == undefined) {
                await sendResponse(socket, { status: ServerStatusResponse.Failure, id: request.id, message: "Unknown uri!" }, scriptEvent)
                return;
            }
            try {
                const regex = /^https?:\/\/(?:www\.)?onlinesequencer\.net\/\d+$/;
                if (!regex.test(request.data.uri)) {
                    await sendResponse(socket, { status: ServerStatusResponse.Failure, id: request.id, message: "Invalid URI has to be onlinesequencer.net/(id)" }, scriptEvent)
                    return;
                }
                const res = await getOnlineSequencerData(request.data.uri);
                if (res == null) {
                    await sendResponse(socket, { status: ServerStatusResponse.Failure, id: request.id, message: "Failed to get data from onlinesequencer link" }, scriptEvent)
                    return;
                }
                let dataReceived;
                try {
                    dataReceived = parseMidi(res);
                } catch (e: any) {
                    console.warn(e)
                }
                let str = JSON.stringify(JSON.stringify(dataReceived)).slice(1, -1);
                if (scriptEvent) str = JSON.stringify(dataReceived);

                // 2074 max length of command
                const maxChunk = 2000 - request.id.length - (scriptEvent ? 21 : 0);
                const release = await acquireRequestWriteLock(socket);
                try {
                    let i = 0;
                    while (i < str.length) {
                        let end = Math.min(i + maxChunk, str.length);
                        let backslashCount = 0;
                        while (end - 1 - backslashCount >= i && str[end - 1 - backslashCount] === '\\') {
                            backslashCount++;
                        }
                        if (backslashCount % 2 === 1 && end < str.length) {
                            end++;
                        }
                        const chunk = str.slice(i, end);
                        const command = `${scriptEvent ? "scriptevent hivemind:" : ""}set add ${scriptEventQuote}${request.id}${scriptEventQuote} ${scriptEventQuote}${chunk}${scriptEventQuote}`;
                        if (socket.hivemindData?.name == "SongPlayer") {
                            console.log({
                                id: request.id,
                                chunk: i,
                                total: str.length,
                                queue: socket.writeQueue.length,
                                writable: socket.socket.writable,
                                destroyed: socket.socket.destroyed,
                                writableLength: socket.socket.writableLength
                            });
                        }
                        await runCommand(socket, command);
                        i = end;
                    }
                } finally {
                    release();
                }

                await sendResponse(socket, { id: request.id, status: ServerStatusResponse.Success, message: `Get your data with .getData()` }, scriptEvent)
            } catch (e: any) {
                console.error(e.stack);
                await sendResponse(socket, { id: request.id, status: ServerStatusResponse.Failure, message: `Failed to get data from website: ${e.message}` }, scriptEvent)
            }
        }
    } catch (e: any) {
        console.error(e.stack);
    }
}

async function getOnlineSequencerData(sequenceUrl: string): Promise<number[] | null> {
    const browser = await puppeteer.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage'
        ]
    });
    const page = await browser.newPage();

    try {
        await page.goto(sequenceUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

        await new Promise(resolve => setTimeout(resolve, 1000));

        const rawMidiBytes = await page.evaluate(async (): Promise<number[]> => {
            if (typeof (window as any).exportMidi !== 'function') {
                throw new Error("exportMidi function not found");
            }

            let interceptedBytes: number[] | null = null;
            const originalSaveBlob = (window as any).saveBlob;

            (window as any).saveBlob = function (filename: string, dataArray: any[], mimeType: string) {
                if (dataArray && dataArray[0]) {
                    interceptedBytes = Array.from(dataArray[0]);
                }
            };
            (window as any).exportMidi();
            (window as any).saveBlob = originalSaveBlob;

            if (!interceptedBytes) {
                throw new Error("Failed to intercept MIDI data via saveBlob invocation")
            }

            return interceptedBytes;
        });

        await browser.close();
        return rawMidiBytes;

    } catch (error) {
        await browser.close();
        throw error;
    }
}