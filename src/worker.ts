// worker.js
import Grass from "./lib/grass.js";
import RedisWorker from "./lib/redis-worker.js";

const processGrassAccount = async (login: string, password: string) => {
    await RedisWorker.init();
    const grass = new Grass();
    await grass.login(login, password);
    const user = await grass.getUser();
    console.log('User info:', user);
    await grass.startMining(login, password);
    await new Promise(() => {});
};

process.on('message', async (msg: {login: string; password: string}) => {
    const { login, password } = msg;
    try {
        await processGrassAccount(login, password);
    } catch (error: any) {
        //@ts-ignore
        process.send({ success: false, error: error.message });
    } finally {
        process.exit();
    }
});
