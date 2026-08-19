import puppeteer, { Browser, Page } from "puppeteer";

const MAX_BROWSERS = 3;

interface BrowserSlot {
    browser: Browser;
    busy: boolean;
}

const browsers: BrowserSlot[] = [];
const waitQueue: ((slot: BrowserSlot) => void)[] = [];

async function createBrowser(): Promise<BrowserSlot> {
    const browser = await puppeteer.launch({
        headless: true,
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage"
        ]
    });

    return {
        browser,
        busy: false
    };
}

async function getBrowser(): Promise<BrowserSlot> {
    const available = browsers.find(b => !b.busy);

    if (available) {
        available.busy = true;
        return available;
    }

    if (browsers.length < MAX_BROWSERS) {
        const slot = await createBrowser();
        slot.busy = true;
        browsers.push(slot);
        return slot;
    }

    return new Promise(resolve => {
        waitQueue.push(slot => {
            slot.busy = true;
            resolve(slot);
        });
    });
}

function releaseBrowser(slot: BrowserSlot) {
    const waiter = waitQueue.shift();

    if (waiter) {
        waiter(slot);
    } else {
        slot.busy = false;
    }
}

export async function withBrowser<T>(callback: (browser: Browser) => Promise<T>): Promise<T> {
    const slot = await getBrowser();

    try {
        return await callback(slot.browser);
    } finally {
        releaseBrowser(slot);
    }
}