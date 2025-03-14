import fs from 'fs';
import RedisWorker from "./redis-worker.js";

const proxies = fs.readFileSync('data/proxies.txt').toString().split('\n');
const config = JSON.parse(fs.readFileSync("data/config.json", "utf8"));

export default class ProxyManager {
    static async getProxy(): Promise<string> {
        if(config.useRotatingProxy)
            return config.rotatingProxy;

        let index = await RedisWorker.getIndex();

        if (index >= proxies.length)
            await RedisWorker.resetIndex();

        index = await RedisWorker.getNext();
        return proxies[index] as string;
    }
}