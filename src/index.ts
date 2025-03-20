// index.ts
import { fork } from 'child_process';
import fs from 'fs';
import path from 'path';
import RedisWorker from "./lib/redis-worker.js";
import io from '@pm2/io';

io.init({
    metrics: {
        http: true,
    }
});

const workerStatuses = new Map<string, any>();


// Read and parse configuration
const config = JSON.parse(fs.readFileSync('data/config.json', 'utf-8'));
const accounts = config.accounts;
console.log('Loaded config:', accounts);

// Delay range from config if needed
const [minDelay, maxDelay] = config.delay || [100, 10000];

function randomDelay(): Promise<void> {
    const ms = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Function to run a worker process for given credentials and thread count
const runWorker = (login: string, password: string, proxy: string, threads: number) => {
    return new Promise((resolve, reject) => {
        const workerPath = path.join(process.cwd(), 'dist/worker.js');
        const worker = fork(workerPath);

        worker.on('message', (msg) => {
            if (msg.type === 'threadHeartbeat') {
                const status: any = {
                    state: msg.state,
                    lastUpdate: msg.timestamp,
                    threadId: msg.threadId,
                    email: msg.email
                };
                workerStatuses.set(msg.workerId, status);
                console.log(`Received heartbeat from worker ${msg.workerId}: ${msg.state}`);
            }
        });

        worker.on('error', (err) => {
            console.error(`Worker error for ${login}: ${err}`);
            reject(err);
        });

        worker.on('exit', (code) => {
            if (code !== 0) {
                console.error(`Worker for ${login} exited with code ${code}`);
                reject(new Error(`Worker exited with code ${code}`));
            }
        });

        // Send login, password and thread count to the worker
        worker.send({ login, password, proxy, proxyThreads: threads });
    });
};

const main = async () => {
    await RedisWorker.init();

    // For each account, spawn enough workers so each worker gets a set number of threads.
    const workerPromises = [];
    for (const account of accounts) {
        const { login, password, proxy, proxyThreads } = account;
        // Determine the number of workers needed (each handling a fixed number of threads)
        const numWorkers = Math.ceil(proxyThreads / 50);
        for (let i = 0; i < numWorkers; i++) {
            const threads = (i === numWorkers - 1) ? proxyThreads - (i * 50) : 50;
            workerPromises.push(runWorker(login, password, proxy, threads));
            await randomDelay();
        }
    }

    try {
        await Promise.all(workerPromises);
        console.log('All workers completed successfully.');
    } catch (error) {
        console.error('An error occurred in one of the workers:', error);
    }
};

main();

// Optionally, display the current statuses on the console every minute:
setInterval(() => {
    if (config.debug) {
        const tableData = Array.from(workerStatuses.entries()).map(([workerId, { state, lastUpdate, threadId, email }]) => {
            return {
                workerId,
                threadId: threadId || 'N/A',
                email,
                state,
                lastUpdate: new Date(lastUpdate).toLocaleTimeString()
            };
        });
        console.table(tableData);
    } else {
        const miningCount = Array.from(workerStatuses.values()).filter(status => status.state === 'mining').length;
        console.log(`Number of workers mining: ${miningCount}`);
    }
}, 60000);
