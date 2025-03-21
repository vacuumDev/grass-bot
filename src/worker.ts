import Grass from "./lib/grass.js";
import RedisWorker from "./lib/redis-worker.js";

const delay = async (ms: number) => {
    return new Promise((resolve) => setTimeout(resolve, ms));
};

const processGrassAccount = async (login: string, password: string, proxy: string, proxyThreads: number) => {
    await RedisWorker.init();
    const promises = [];

    const min = 1000, max = 10_000;
    const ms = Math.floor(Math.random() * (max - min + 1)) + min;

    for (let i = 0; i < proxyThreads; i++) {
        await delay(ms)
        const grass = new Grass(i);
        promises.push(grass.startMining(login, password, proxy));
    }
    // Prevent the worker from exiting immediately (if needed)
    await Promise.all(promises);
    await new Promise(() => {});
};

process.on('message', async (msg: { login: string; password: string; proxy: string; proxyThreads: number }) => {
    const { login, password, proxy, proxyThreads } = msg;
    try {
        await processGrassAccount(login, password, proxy, proxyThreads);
    } catch (error: any) {
        // Send error message back if needed
        //@ts-ignore
        process.send({ success: false, error: error.message });
    }
});
