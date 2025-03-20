import fs from 'fs';
import RedisWorker from "./redis-worker.js";
import {HttpsProxyAgent} from "https-proxy-agent";

const config = JSON.parse(fs.readFileSync("data/config.json", "utf8"));

function generateRandom12Hex() {
    let hex = '';
    for (let i = 0; i < 12; i++) {
        hex += Math.floor(Math.random() * 16).toString(16);
    }
    return hex;
}

export default class ProxyManager {
    static rotatingProxy = config.rotatingProxy;
    static stickyProxy = config.stickyProxy;
    static async getProxy(useRotatingProxy = false): Promise<string> {
        if(useRotatingProxy)
            return ProxyManager.rotatingProxy;

        let proxy = ProxyManager.stickyProxy.replace('{ID}', generateRandom12Hex());
        try {
            const agent = new HttpsProxyAgent(proxy);
        } catch (e) {
            proxy = ProxyManager.stickyProxy.replace('{ID}', generateRandom12Hex());
        }

        return proxy;
    }
}