import fs from "fs";

export interface Account {
  login: string;
  proxyThreads: number;
  userAgent: string;
  stickyProxy: string;
  password: string;
  rotatingProxy: string;
  brandVersion: string;
}

interface Config {
  accounts: Account[];
  delay: [number, number];
  accDelay: [number, number];
  threads: [number, number];
  shuffle: boolean;
  redisUrl: string;
  rotatingProxy: string;
  stickyProxy: string;
  debug: boolean;
  countries: string[],
  httpPort: string;
  authToken: string;
}

const config: Config = JSON.parse(fs.readFileSync("data/config.json", "utf-8"));

export default config;
