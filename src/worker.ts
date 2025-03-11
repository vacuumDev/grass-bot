// worker.js
import Grass from "./lib/grass.js";

const processGrassAccount = async (login, password) => {
    const grass = new Grass();
    await grass.login(login, password);
    const user = await grass.getUser();
    console.log('User info:', user);
    await grass.startMining(login, password);
    await new Promise(() => {});
};

process.on('message', async (msg) => {
    const { login, password } = msg;
    try {
        await processGrassAccount(login, password);
    } catch (error) {
        process.send({ success: false, error: error.message });
    } finally {
        process.exit();
    }
});
