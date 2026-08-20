import { Browser, Page } from "puppeteer";
import puppeteer from "puppeteer";

const MAX_CONCURRENT_PAGES = 2;

let browser: Browser | null = null;
let browserPromise: Promise<Browser> | null = null;

let activePages = 0;
const waitQueue: (() => void)[] = [];

async function getBrowser(): Promise<Browser> {
    if (browser && browser.connected) {
        return browser;
    }

    // Prevent multiple simultaneous launches.
    if (browserPromise) {
        return browserPromise;
    }

    browserPromise = puppeteer.launch({
        headless: true,
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
        ],
    });

    try {
        browser = await browserPromise;

        browser.on("disconnected", () => {
            console.error("Chromium disconnected");
            browser = null;
            browserPromise = null;
        });

        return browser;
    } catch (err) {
        browser = null;
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

    const next = waitQueue.shift();

    if (next) {
        next();
    }
}

export async function withPage<T>(callback: (page: Page) => Promise<T>): Promise<T> {
    await acquireSlot();

    let page: Page | null = null;

    try {
        const browser = await getBrowser();

        page = await browser.newPage();

        return await callback(page);
    } finally {
        if (page) {
            try {
                await page.close();
            } catch (err) {
                console.error("Failed to close page:", err);
            }
        }

        releaseSlot();
    }
}