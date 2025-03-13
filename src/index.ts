import { fork } from 'child_process';
import fs from 'fs';
import path from 'path';
import RedisWorker from "./lib/redis-worker.js";

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
const runWorker = (login: string, password: string, threads: number) => {
    return new Promise((resolve, reject) => {
        const workerPath = path.join(process.cwd(), 'dist/worker.js');
        const worker = fork(workerPath);

        worker.on('message', (msg) => {
            console.log(`Worker message for ${login}: ${JSON.stringify(msg)}`);
            resolve(msg);
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
        worker.send({ login, password, proxyThreads: threads });
    });
};

const main = async () => {
    await RedisWorker.init();

    // For each account, spawn enough workers so each worker gets 20 threads.
    const workerPromises = [];
    for (const account of accounts) {
        const { login, password, proxyThreads } = account;
        // Determine the number of workers needed (each handling 20 threads)
        const numWorkers = Math.ceil(proxyThreads / 20);
        for (let i = 0; i < numWorkers; i++) {
            // For now we pass 20 threads to each worker.
            // Optionally, for the last worker you could pass a smaller number if (proxyThreads % 20 !== 0)
            workerPromises.push(runWorker(login, password, 20));
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
