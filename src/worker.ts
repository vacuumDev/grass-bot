import Grass from "./lib/grass.js";
import RedisWorker from "./lib/redis-worker.js";

const processGrassAccount = async (login: string, password: string, proxyThreads: number) => {
    await RedisWorker.init();
    const grass = new Grass();
    await grass.login(login, password);
    const user = await grass.getUser();
    console.log('User info:', user);
    // Pass proxyThreads to your startMining method if it uses it
    await grass.startMining(login, password, proxyThreads);
    // Prevent the worker from exiting immediately (if needed)
    await new Promise(() => {});
};

process.on('message', async (msg: { login: string; password: string; proxyThreads: number }) => {
    const { login, password, proxyThreads } = msg;
    try {
        await processGrassAccount(login, password, proxyThreads);
    } catch (error: any) {
        // Send error message back if needed
        //@ts-ignore
        process.send({ success: false, error: error.message });
    } finally {
        process.exit();
    }
});
