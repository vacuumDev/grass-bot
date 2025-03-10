import 'dotenv/config';

import Grass from "./lib/grass.js";
import fs from 'fs';
import {Config} from "./types/config.type.js";

const processGrassAccount = async (login: string, password: string) => {
    const grass = new Grass();
    await grass.login(login, password);

    const user = await grass.getUser();
    console.log(user)

    await grass.startMining(
        login,
        password
    );
}

const main = async () => {
    const config: Config[] = JSON.parse(fs.readFileSync('data/config.json').toString());

    console.log('Config', config);
    for (const account of config) {
        const accountProcesses = [];
        for (let i = 0; i < account.proxyThreads; i++) {
            accountProcesses.push(processGrassAccount(account.login, account.password));
        }
        await Promise.all(accountProcesses);
    }
}

main();