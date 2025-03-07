import axios from "axios";
import fs from 'fs';

const proxies = fs.readFileSync('data/proxies.txt').toString().split('\n');

export default class ProxyManager {
    private static index: number = 0;
    private static proxies: string[] = proxies;

    static getProxy(): string | null {
        if(this.proxies.length === this.index)
            return null;

        return this.proxies[this.index++] as string;
    }

    static getProxies(proxyCount: number): string[] | null {
        if(this.proxies.length < this.index + proxyCount)
            return null;

        this.index += proxyCount;
        return this.proxies.slice(this.index, this.index + proxyCount);
    }
}