import axios from "axios";
import fs from 'fs';

const proxies = fs.readFileSync('data/proxies.txt').toString().split('\n');

export default class ProxyManager {
    private static index: number = 0;
    private static proxies: string[] = proxies;

    static getProxy(): string | null {
        if(this.proxies.length === this.index)
            return null;

        return 'http://maddnivan_gmail_com-country-any-filter-medium:hy9o97m71v@gate.nodemaven.com:8080' as string;
    }

    static getProxies(proxyCount: number): string[] | null {
        if(this.proxies.length < this.index + proxyCount)
            return null;

        const proxies = this.proxies.slice(this.index, this.index + proxyCount);

        this.index += proxyCount;

        return proxies;
    }
}