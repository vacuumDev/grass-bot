import Grass from "./lib/grass.js";
import RedisWorker from "./lib/redis-worker.js";

const processGrassAccount = async (login: string, password: string, proxy: string, proxyThreads: number) => {
    await RedisWorker.init();
    const promises = []
    for (let i = 0; i < proxyThreads; i++) {
        const grass = new Grass(i);
        promises.push(grass.startMining(login, password, proxy));
    }
    // Prevent the worker from exiting immediately (if needed)
    await Promise.all(promises);
};

process.on('message', async (msg: { login: string; password: string; proxy: string; proxyThreads: number }) => {
    const { login, password, proxy, proxyThreads } = msg;
    try {
        await processGrassAccount(login, password, proxy, proxyThreads);
    } catch (error: any) {
        // Send error message back if needed
        //@ts-ignore
        process.send({ success: false, error: error.message });
    } finally {
        process.exit();
    }
});
