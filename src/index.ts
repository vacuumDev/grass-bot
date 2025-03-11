import { fork } from 'child_process';
import fs from 'fs';
import path from 'path';

// Read and parse configuration
const config = JSON.parse(fs.readFileSync('data/config.json', 'utf-8'));
console.log('Loaded config:', config);

// Function to run a worker process for given credentials
const runWorker = (login, password) => {
    return new Promise((resolve, reject) => {
        // Resolve the absolute path to worker.js
        console.log(process.cwd(), 'worker.js')
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
    // Collect all worker promises
    const workerPromises = [];
    for (const account of config) {
        for (let i = 0; i < account.proxyThreads; i++) {
            workerPromises.push(runWorker(account.login, account.password));
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
