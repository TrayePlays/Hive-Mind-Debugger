import { serverData } from "./serverData"
import { ModSocket, runCommand, sleep } from "./utils"
import sharp from 'sharp';
const MAX_REQUESTS_IN_30 = serverData.config.MAX_REQUESTS_IN_30;

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
    const now = Date.now();
    const bucket = socket.rateLimit!;

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

export async function handleRequest(data: string, socket: ModSocket) {
    try {
        const requestStr = data
        const request = JSON.parse(requestStr) as Request
        const scriptEvent = request.scriptEvent
        const scriptEventQuote = scriptEvent ? "" : `"`
        runCommand(socket, `${scriptEvent ? "scriptevent hivemind:" : ""}set remove ${scriptEventQuote}${request.id}${scriptEventQuote} hivemindRequest${request.id}`)

        if (!checkRateLimit(socket)) {
            sendResponse(socket, { status: ServerStatusResponse.Failure, id: request.id, message: `You are rate limited!` }, scriptEvent)
            return;
        }

        if (request.id == undefined) {
            sendResponse(socket, { status: ServerStatusResponse.Failure, id: "ERROR", message: "No request id!" }, scriptEvent)
            return;
        }
        if (!Object.values(RequestTypes).includes(request?.type)) {
            sendResponse(socket, { status: ServerStatusResponse.Failure, id: request.id, message: "Unknown request type!" }, scriptEvent)
            return;
        };

        sendResponse(socket, { status: ServerStatusResponse.Ran, id: request.id }, scriptEvent);

        if (request.type == RequestTypes.HttpRequest) {
            if (request.data.uri == undefined) {
                sendResponse(socket, { status: ServerStatusResponse.Failure, id: request.id, message: "Unknown uri!" }, scriptEvent)
                return;
            }
            try {
                const res = await fetch(request.data.uri, request.data.init)

                if (!res.ok) {
                    sendResponse(socket, { status: ServerStatusResponse.Failure, id: request.id, message: `HTTP Error! Status code: ${res.status}` })
                    return;
                }

                const contentType = res.headers.get('content-type') || '';
                let dataReceived: any;
                if (contentType.includes("application/json")) {
                    dataReceived = await res.json();
                } else if (contentType.startsWith("image/")) {
                    const arrBuffer = await res.arrayBuffer();
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
                    dataReceived = await res.text();
                }
                let str = JSON.stringify(JSON.stringify(dataReceived)).slice(1, -1);
                if (scriptEvent) str = JSON.stringify(dataReceived);
                // 2074 max length of command
                const maxChunk = 2000 - request.id.length - (scriptEvent ? 21 : 0);
                const chunks = [];

                let i = 0;
                while (i < str.length) {
                    if (i % 50000 === 0) await new Promise(r => setImmediate(r));
                    let end = i + maxChunk;

                    let backslashCount = 0;
                    while (end - 1 - backslashCount >= i && str[end - 1 - backslashCount] === '\\') {
                        backslashCount++;
                    }

                    if (backslashCount % 2 === 1) {
                        end++;
                    }

                    chunks.push(str.slice(i, end));
                    i = end;
                }

                let strArr: string[] = [];
                for (const chunk of chunks) {
                    await new Promise(r => setImmediate(r));
                    strArr.push(`${scriptEvent ? "scriptevent hivemind:" : ""}set add ${scriptEventQuote}${request.id}${scriptEventQuote} ${scriptEventQuote}${chunk}${scriptEventQuote}`);
                }
                await runBatched(socket, strArr, 1, 1000)
                sendResponse(socket, { id: request.id, status: ServerStatusResponse.Success, message: `Get your data with .getData()` }, scriptEvent)
            } catch (e: any) {
                console.error(e.stack);
                sendResponse(socket, { id: request.id, status: ServerStatusResponse.Failure, message: `Failed to get data from website: ${e.message}` }, scriptEvent)
            }
        }
    } catch (e: any) {
        console.error(e.stack);
    }
}