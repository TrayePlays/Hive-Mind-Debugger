import { Browser, Page } from "puppeteer";
import puppeteer from "puppeteer";

const MAX_CONCURRENT_PAGES = 2;
const MAX_PAGES_BEFORE_BROWSER_RESTART = 5;
const PAGE_OPERATION_TIMEOUT = 60_000;

const CHROME_ARGS = [
    "--no-sandbox",
    "--disable-setuid-sandbox",

    "--disable-dev-shm-usage",

    "--disable-gpu",

    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-breakpad",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-features=Translate,MediaRouter,OptimizationHints",
    "--disable-hang-monitor",
    "--disable-popup-blocking",
    "--disable-prompt-on-repost",
    "--disable-sync",

    "--renderer-process-limit=4",

    "--mute-audio",

    "--no-first-run",
    "--no-default-browser-check",
];

let browser: Browser | null = null;
let browserPromise: Promise<Browser> | null = null;
let browserClosePromise: Promise<void> | null = null;
let activePages = 0;
let pagesCreated = 0;
let browserRestartRequested = false;
const waitQueue: Array<() => void> = [];

function getBrowserPid(target: Browser | null): number | undefined {
    try {
        return target?.process()?.pid;
    } catch {
        return undefined;
    }
}

async function closeBrowser(): Promise<void> {
    if (browserClosePromise) {
        await browserClosePromise;
        return;
    }

    const currentBrowser = browser;

    if (!currentBrowser) {
        browserRestartRequested = false;
        return;
    }

    browser = null;
    browserRestartRequested = false;

    const pid = getBrowserPid(currentBrowser);

    browserClosePromise = (async () => {
        console.log(`[browserPool] Closing Chromium${pid ? ` (pid ${pid})` : ""}...`);

        try {
            await currentBrowser.close();
        } catch (err) {
            console.log("[browserPool] Failed to close Chromium:", err);

            try {
                const process = currentBrowser.process();

                if (process && !process.killed) {
                    process.kill("SIGKILL");
                }
            } catch (killErr) {
                console.log("[browserPool] Failed to kill Chromium:", killErr);
            }
        }

        console.log(`[browserPool] Chromium closed${pid ? ` (pid ${pid})` : ""}`);
    })();

    try {
        await browserClosePromise;
    } finally {
        browserClosePromise = null;
    }
}

async function getBrowser(): Promise<Browser> {
    if (browserClosePromise) {
        await browserClosePromise;
    }

    if (browser && browser.connected && !browserRestartRequested) {
        return browser;
    }

    if (browserPromise) {
        return browserPromise;
    }

    console.log("[browserPool] Launching Chromium...");

    browserPromise = puppeteer.launch({
        headless: true,
        args: CHROME_ARGS,
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
    });

    try {
        const newBrowser = await browserPromise;

        browser = newBrowser;
        pagesCreated = 0;
        browserRestartRequested = false;

        const pid = getBrowserPid(newBrowser);

        console.log(`[browserPool] Chromium launched${pid ? ` (pid ${pid})` : ""}`);

        newBrowser.on("disconnected", () => {
            console.log(`[browserPool] Chromium disconnected${pid ? ` (pid ${pid})` : ""}`);

            if (browser === newBrowser) {
                browser = null;
            }
        });

        return newBrowser;
    } catch (err) {
        browser = null;
        console.log("[browserPool] Chromium launch failed:", err);
        throw err;
    } finally {
        browserPromise = null;
    }
}

async function acquireSlot(): Promise<void> {
    if (activePages < MAX_CONCURRENT_PAGES) {
        activePages++;
        return;
    }

    await new Promise<void>((resolve) => {
        waitQueue.push(resolve);
    });

    activePages++;
}

function releaseSlot(): void {
    activePages--;

    if (activePages < 0) {
        activePages = 0;
    }

    const next = waitQueue.shift();

    if (next) {
        next();
    }
}

async function waitForBrowser(): Promise<Browser> {
    while (true) {
        if (browserClosePromise) {
            await browserClosePromise;
            continue;
        }

        if (browser && browser.connected && !browserRestartRequested) {
            return browser;
        }

        if (browserRestartRequested) {
            if (activePages > 0) {
                await new Promise<void>((resolve) => {
                    setTimeout(resolve, 25);
                });

                continue;
            }

            await closeBrowser();
            continue;
        }

        return await getBrowser();
    }
}

export async function withPage<T>(callback: (page: Page) => Promise<T>): Promise<T> {
    await acquireSlot();
    let page: Page | null = null;
    let currentBrowser: Browser | null = null;

    try {
        currentBrowser = await waitForBrowser();

        if (!currentBrowser.connected) {
            throw new Error("Chromium disconnected before page creation");
        }

        page = await currentBrowser.newPage();

        pagesCreated++;

        console.log(`[browserPool] New page created: ${pagesCreated}/${MAX_PAGES_BEFORE_BROWSER_RESTART} ` + `(active=${activePages}, pid=${getBrowserPid(currentBrowser) ?? "?"})`);

        if (pagesCreated >= MAX_PAGES_BEFORE_BROWSER_RESTART) {
            browserRestartRequested = true;

            console.log(`[browserPool] Chromium marked for restart after ${pagesCreated} pages`);
        }

        page.setDefaultTimeout(PAGE_OPERATION_TIMEOUT);
        page.setDefaultNavigationTimeout(PAGE_OPERATION_TIMEOUT);

        return await callback(page);

    } finally {

        //close the page before releasing the slot.
        if (page) {
            try {
                await page.close();
            } catch (err) {
                console.log("[browserPool] Failed to close page:", err);
            }
        }

        /*
         * activePages still includes the current request here.
         * Therefore activePages === 1 means this is the last active page.
         */
        const shouldRestart = browserRestartRequested && activePages === 1 && browser === currentBrowser;

        /*
         * Restart Chromium BEFORE releasing the slot.
         *
         * This prevents a queued request from immediately starting
         * another page on the browser that is being retired.
         */
        if (shouldRestart) {
            try {
                await closeBrowser();
            } catch (err) {
                console.log("[browserPool] Failed to recycle Chromium:", err);
            }
        }

        releaseSlot();
    }
}

export function getBrowserPoolStats() {
    return {
        browserConnected: !!browser?.connected,
        browserPid: getBrowserPid(browser),
        activePages,
        queuedRequests: waitQueue.length,
        pagesCreated,
        maxPagesBeforeRestart: MAX_PAGES_BEFORE_BROWSER_RESTART,
        browserRestartRequested,
        browserLaunching: !!browserPromise,
        browserClosing: !!browserClosePromise,
    };
}

export async function closeBrowserPool(): Promise<void> {
    if (activePages > 0) {
        console.log(`[browserPool] closeBrowserPool called with ${activePages} active page(s)`);
    }

    if (browserPromise) {
        try {
            await browserPromise;
        } catch {
            //launch failure is already logged
        }
    }

    if (browserClosePromise) {
        try {
            await browserClosePromise;
        } catch {
            //close failure is already logged
        }
    }

    if (browser && activePages === 0) {
        await closeBrowser();
    }
}
