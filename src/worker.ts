import Grass from "./lib/grass.js";
import RedisWorker from "./lib/redis-worker.js";

const delay = async (ms: number) => {
    return new Promise((resolve) => setTimeout(resolve, ms));
};

const processGrassAccount = async (login: string, password: string, stickyProxy: string, rotatingProxy: string, proxyThreads: number, isPrimary: boolean, userAgent: string) => {
    await RedisWorker.init();
    const promises = [];

    const min = 1000, max = 10_000;
    const ms = Math.floor(Math.random() * (max - min + 1)) + min;

    for (let i = 0; i < proxyThreads; i++) {
        await delay(ms)
        const grass = new Grass(i, isPrimary && i === 0, userAgent);
        promises.push(grass.startMining(login, password, stickyProxy, rotatingProxy));
    }
    // Prevent the worker from exiting immediately (if needed)
    await Promise.all(promises);
    await new Promise(() => {});
};

process.on('message', async (msg: { login: string; password: string; stickyProxy: string; rotatingProxy: string; isPrimary: boolean; proxyThreads: number; userAgent: string }) => {
    const { login, password, stickyProxy, rotatingProxy, proxyThreads, isPrimary, userAgent } = msg;
    try {
        await processGrassAccount(login, password, stickyProxy, rotatingProxy, proxyThreads, isPrimary, userAgent);
    } catch (error: any) {
        // Send error message back if needed
        //@ts-ignore
        process.send({ success: false, error: error.message });
    }
});
