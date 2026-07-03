import { serverData } from "./serverData"
import { ModSocket, runCommand, sleep } from "./utils"
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
    init?: RequestInit
}

// More request types later
enum RequestTypes {
    HttpRequest = "httpRequest" // v0.2+
}

enum ServerStatusResponse {
    Ran = -1,
    Success = 0,
    Failure = 1
}

function sendResponse(socket: ModSocket, data: { status: ServerStatusResponse, id: string, data?: string, message?: string }, scriptEvent = true) {
    const scriptEventQuote = scriptEvent ? "" : `"`
    runCommand(socket, `${scriptEvent ? "scriptevent hivemind:" : ""}respond ${scriptEventQuote}${data.id}|${data.status}${data.message ? `|${data.message}` : ""}${data.data ? `|${data.data}` : ""}${scriptEventQuote}`)
}

async function runBatched(socket: ModSocket, commands: string[], batchSize = 1, delay = 1) {
    let index = 0;

    while (index < commands.length) {
        const end = Math.min(index + batchSize, commands.length);

        for (let i = index; i < end; i++) {
            runCommand(socket, commands[i]);
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
                const dataReceived = await res.json();
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

                await runBatched(socket, strArr, 50, 75)
                sendResponse(socket, { id: request.id, status: ServerStatusResponse.Success, message: `Get your data with .getData() (build time: ${((75 * Math.floor(strArr.length / 10)) / 1000).toFixed(2)}s)` }, scriptEvent)
            } catch (e: any) {
                console.error(e.stack);
                sendResponse(socket, { id: request.id, status: ServerStatusResponse.Failure, message: `Failed to get data from website: ${e.message}` }, scriptEvent)
            }
        }
    } catch (e: any) {
        console.error(e.stack);
    }
}