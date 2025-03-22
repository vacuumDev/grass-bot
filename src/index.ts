// index.ts
import { fork } from 'child_process';
import fs from 'fs';
import path from 'path';
import RedisWorker from "./lib/redis-worker.js";
import io from '@pm2/io';
import readline from 'readline';
import {logger} from "./lib/logger.js";


io.init({
    metrics: {
        http: true,
    }
});

const workerStatuses = new Map<string, any>();
const accountStartTimes = new Map<string, number>();
const accountPoints = new Map<string, number>();

function formatDuration(ms: number): string {
    const totalMinutes = Math.floor(ms / 60000);
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;
    return `${days}d ${hours}h ${minutes}m`;
}

function getRandomInterval(minMs: number, maxMs: number): number {
    return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}


// Read and parse configuration
const config = JSON.parse(fs.readFileSync('data/config.json', 'utf-8'));
let accounts = config.accounts;

// Delay range from config if needed
const [minDelay, maxDelay] = config.delay || [100, 10000];

function randomDelay(): Promise<void> {
    const ms = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Function to run a worker process for given credentials and thread count
const runWorker = (login: string, password: string, stickyProxy: string, rotatingProxy: string, threads: number, isPrimary: boolean) => {
    return new Promise((resolve, reject) => {
        const workerPath = path.join(process.cwd(), 'dist/worker.js');
        const worker = fork(workerPath);

        worker.on('message', (msg) => {
            if (msg.type === 'threadHeartbeat') {
                if (!accountStartTimes.has(msg.email)) {
                    accountStartTimes.set(msg.email, msg.timestamp);
                }

                const status: any = {
                    state: msg.state,
                    lastUpdate: msg.timestamp,
                    threadId: msg.threadId,
                    email: msg.email,
                    pingCount: msg.pingCount
                };
                workerStatuses.set(msg.workerId, status);
            } else if(msg.type === 'updatePoints') {
                accountPoints.set(msg.email, msg.pingCount);
            }
        });

        worker.on('error', (err) => {
            logger.debug(`Worker error for ${login}: ${err}`);
            reject(err);
        });

        worker.on('exit', (code) => {
            if (code !== 0) {
                logger.debug(`Worker for ${login} exited with code ${code}`);
                reject(new Error(`Worker exited with code ${code}`));
            }
        });

        // Send login, password and thread count to the worker
        worker.send({ login, password, stickyProxy, rotatingProxy, proxyThreads: threads, isPrimary });
    });
};

const main = async () => {
    await RedisWorker.init();

    const readyAccountsPath = path.join(process.cwd(), 'data/ready_accounts.txt');
    if (fs.existsSync(readyAccountsPath)) {
        const fileContent = fs.readFileSync(readyAccountsPath, 'utf-8');
        const lines = fileContent.split('\n').filter(line => line.trim() !== '');
        for (const line of lines) {
            const parts = line.split(':');
            if (parts.length >= 6) {
                const email = parts[0];

                if (accounts.some(acc => acc.login === email)) {
                    logger.debug(`Account ${email} already exists in config, skipping.`);
                    continue;
                }

                const accessToken = parts[4];
                const userId = parts[5];
                try {
                    await RedisWorker.setSession(email, JSON.stringify({
                        accessToken: accessToken,
                        userId: userId
                    }));
                    accounts.push({
                        login: email,
                        proxyThreads: 200
                    });
                    logger.debug(`Redis session set for ${email}`);
                } catch (err) {
                    logger.debug(`Failed to set session for ${email}: ${err}`);
                }
            } else {
                logger.debug(`Skipping invalid line in ready_accounts.txt: ${line}`);
            }
        }
    } else {
        logger.debug('No ready_accounts.txt file found, skipping Redis session setup from file.');
    }

    config.accounts = accounts;
    fs.writeFileSync('data/config.json', JSON.stringify(config, null, 2))

    logger.debug('Loaded config:' + JSON.stringify(accounts));

    // For each account, spawn enough workers so each worker gets a set number of threads.
    const workerPromises = [];
    for (const account of accounts) {
        const { login, password, stickyProxy, rotatingProxy, proxyThreads } = account;
        // Determine the number of workers needed (each handling a fixed number of threads)
        const numWorkers = Math.ceil(proxyThreads / 50);
        for (let i = 0; i < numWorkers; i++) {
            const threads = (i === numWorkers - 1) ? proxyThreads - (i * 50) : 50;
            const isPrimary = i === 0;
            workerPromises.push(runWorker(login, password, stickyProxy, rotatingProxy, threads, isPrimary));
            await randomDelay();
        }
    }

    try {
        await Promise.all(workerPromises);
        logger.debug('All workers completed successfully.');
    } catch (error) {
        logger.debug('An error occurred in one of the workers:' + error);
    }
};

main();

// Optionally, display the current statuses on the console every minute:
function scheduleStatsUpdate() {
    setTimeout(() => {
        const now = Date.now();
        const grouped = new Map<string, {
            startTime: number;
            id: string;
            email: string;
            totalPoints: number;
            threadsWorking: number;
            threadsTotal: number;
            states: string[];
        }>();

        for (const [, status] of workerStatuses) {
            const { email, state, pingCount, threadId } = status;
            const accCfg = accounts.find(acc => acc.login === email) || {};
            if (!grouped.has(email)) {
                grouped.set(email, {
                    startTime: accountStartTimes.get(email) ?? now,
                    id: threadId,
                    email: email,
                    totalPoints: pingCount,
                    threadsWorking: state === 'mining' ? 1 : 0,
                    threadsTotal: accCfg.proxyThreads ?? 0,
                    states: [state],
                });
            } else {
                const acc = grouped.get(email)!;
                acc.totalPoints = pingCount;
                acc.threadsWorking += (state === 'mining' ? 1 : 0);
                acc.states.push(state);
            }
        }

        const rows: any[] = [];
        let totalPoints = 0;
        let totalThreads = 0;

        for (const [, acc] of grouped) {
            const workingTime = formatDuration(now - acc.startTime);
            const accountState = acc.states.includes('mining')
                ? 'mining'
                : acc.states[acc.states.length - 1];

            rows.push({
                'Start Time': new Date(acc.startTime).toISOString(),
                'Email': acc.email,
                'State': accountState,
                'Points': accountPoints.get(acc.email) || 0,
                'Threads Working': `${acc.threadsWorking}/${acc.threadsTotal}`,
                'Working Time': workingTime,
            });

            totalPoints += accountPoints.get(acc.email) || 0;
            totalThreads += acc.threadsWorking;
        }
        if(!config.debug) {
            readline.cursorTo(process.stdout, 0, 0);
            readline.clearScreenDown(process.stdout);
        }
        console.table(rows);
        console.log(`Total Accounts: ${grouped.size} | Total Threads Live: ${totalThreads} | Total Points: ${totalPoints}`);

        scheduleStatsUpdate();
    }, 5000); // 10–40 минут getRandomInterval(600000, 2400000)
}

scheduleStatsUpdate();

