import fs from 'fs';
import RedisWorker from "./redis-worker.js";
import {HttpsProxyAgent} from "https-proxy-agent";

const proxies = fs.readFileSync('data/proxies.txt').toString().split('\n');
const config = JSON.parse(fs.readFileSync("data/config.json", "utf8"));

export default class ProxyManager {
    static async getProxy(useRotatingProxy = false): Promise<string> {
        if(useRotatingProxy)
            return config.rotatingProxy;

        let index = await RedisWorker.getIndex();

        if (index >= proxies.length)
            await RedisWorker.resetIndex();

        index = await RedisWorker.getNext();
        let proxy = proxies[index] as string;
        try {
            const agent = new HttpsProxyAgent(proxy);
        } catch (e) {
            await RedisWorker.resetIndex();
            index = await RedisWorker.getNext();
            proxy = proxies[index] as string;
        }

        return proxy;
    }
}