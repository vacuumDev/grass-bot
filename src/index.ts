import { fork } from 'child_process';
import fs from 'fs';
import path from 'path';
import RedisWorker from "./lib/redis-worker.js";
import GrassMiner from "./lib/grass";

// Read and parse configuration
const accounts = JSON.parse(fs.readFileSync('data/config.json', 'utf-8')).accounts;
console.log('Loaded config:', accounts);

function randomDelay(): Promise<void> {
    const min = 100;
    const max = 10000;
    const ms = Math.floor(Math.random() * (max - min + 1)) + min;
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Function to run a worker process for given credentials
const runWorker = (login: string, password: string) => {
    return new Promise((resolve, reject) => {
        // Resolve the absolute path to worker.js
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

        // Send the login and password to the worker
        worker.send({ login, password });
    });
};

const main = async () => {
    await RedisWorker.init();

    // Collect all worker promises
    const workerPromises = [];
    for (const account of accounts) {
        for (let i = 0; i < account.proxyThreads; i++) {
            workerPromises.push(runWorker(account.login, account.password));
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
