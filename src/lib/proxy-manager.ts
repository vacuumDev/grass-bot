import fs from 'fs';
import RedisWorker from "./redis-worker.js";

const proxies = fs.readFileSync('data/proxies.txt').toString().split('\n');

export default class ProxyManager {
    private static index: number = 0;
    private static proxies: string[] = proxies;

    static async getProxy(): Promise<string | null> {
        if(this.proxies.length === this.index)
            return null;

        const index = await RedisWorker.getNext();
        console.log(index)
        return proxies[index] as string;
    }

    static getProxies(proxyCount: number): string[] | null {
        if(this.proxies.length < this.index + proxyCount)
            return null;

        const proxies = this.proxies.slice(this.index, this.index + proxyCount);

        this.index += proxyCount;

        return proxies;
    }
}