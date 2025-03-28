import RedisWorker from "./lib/redis-worker.js";
import path from "path";
import fs from "fs";
import {logger} from "./lib/logger.js";
import {getRandomNumber} from "./lib/helper.js";

const config = JSON.parse(fs.readFileSync('data/config.json', 'utf-8'));
let accounts = config.accounts;

const main = async () => {
    await RedisWorker.init();
    const [minThreads, maxThreads] = config.threads ?? [180, 220];

    const readyAccountsPath = path.join(process.cwd(), 'data/ready_accounts.txt');
    if (fs.existsSync(readyAccountsPath)) {
        const fileContent = fs.readFileSync(readyAccountsPath, 'utf-8');
        const lines = fileContent.split('\n').filter(line => line.trim() !== '');
        for (const line of lines) {
            if(line.includes('|')) {
                const parts = line.split('|');
                if (parts.length >= 6) {
                    const email = parts[0];

                    if (accounts.some((acc: any) => acc.login === email)) {
                        logger.debug(`Account ${email} already exists in config, skipping.`);
                        continue;
                    }

                    const password = parts[4];
                    const stickyProxy = parts[5];
                    const accessToken = parts[6];
                    const userId = parts[7];
                    const userAgent = parts[8];


                    let rotatingProxy = '';

                    if(parts.length === 12)
                        rotatingProxy = parts[11];

                    const account = {
                        login: email,
                        proxyThreads: getRandomNumber(minThreads, maxThreads),
                        userAgent,
                        stickyProxy,
                        password,
                    };

                    if (rotatingProxy !== '') {
                        account.rotatingProxy = rotatingProxy;
                    }
                    try {
                        await RedisWorker.setSession(email as string, JSON.stringify({
                            accessToken: accessToken,
                            userId: userId
                        }));
                        accounts.push(account);
                        logger.debug(`Redis session set for ${email}`);
                    } catch (err) {
                        logger.debug(`Failed to set session for ${email}: ${err}`);
                    }
                } else {
                    logger.debug(`Skipping invalid line in ready_accounts.txt: ${line}`);
                }
            } else {
                const parts = line.split(':');
                if (parts.length >= 6) {
                    const email = parts[0];

                    if (accounts.some((acc: any) => acc.login === email)) {
                        logger.debug(`Account ${email} already exists in config, skipping.`);
                        continue;
                    }

                    const accessToken = parts[4];
                    const userId = parts[5];
                    try {
                        await RedisWorker.setSession(email as string, JSON.stringify({
                            accessToken: accessToken,
                            userId: userId
                        }));
                        accounts.push({
                            login: email,
                            proxyThreads: getRandomNumber(minThreads, maxThreads)
                        });
                        logger.debug(`Redis session set for ${email}`);
                    } catch (err) {
                        logger.debug(`Failed to set session for ${email}: ${err}`);
                    }
                } else {
                    logger.debug(`Skipping invalid line in ready_accounts.txt: ${line}`);
                }
            }
        }
    } else {
        logger.debug('No ready_accounts.txt file found, skipping Redis session setup from file.');
    }

    config.accounts = accounts;
    fs.writeFileSync('data/config.json', JSON.stringify(config, null, 2))
    process.exit(0);
}

main();