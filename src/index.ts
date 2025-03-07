import 'dotenv/config';

import Grass from "./lib/grass";
import fs from 'fs';
import {Config} from "./types/config.type";
import ProxyManager from "./lib/proxy-manager";

const processGrassAccount = async (login: string, password: string, proxy: string) => {
    const grass = new Grass(proxy);
    await grass.login(login, password);

    const user = await grass.getUser();
    const deviceId = await grass.getDeviceId()

    if(!deviceId) throw new Error(`Can not receive deviceId for account ${login}:${password}`)
    await grass.checkIn(user.userId, deviceId, "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)")
}

const main = async () => {
    const config: Config[] = JSON.parse(fs.readFileSync('data/config.json').toString());
    for (const account of config) {
        const proxies = ProxyManager.getProxies(account.proxyThreads);

        if(!proxies)
            throw new Error('Not enough proxies for processing all accounts')

        const accountProcesses = [];
        for (const proxy of proxies) {
            accountProcesses.push(processGrassAccount(account.login, account.password, proxy));
        }
        await Promise.all(accountProcesses);
    }
}

main();