import RedisWorker from "./lib/redis-worker.js";
import path from "path";
import fs from "fs";
import {logger} from "./lib/logger.js";

const config = JSON.parse(fs.readFileSync('data/config.json', 'utf-8'));
let accounts = config.accounts;

const main = async () => {
    await RedisWorker.init();

    const readyAccountsPath = path.join(process.cwd(), 'data/ready_accounts.txt');
    if (fs.existsSync(readyAccountsPath)) {
        const fileContent = fs.readFileSync(readyAccountsPath, 'utf-8');
        const lines = fileContent.split('\n').filter(line => line.trim() !== '');
        for (const line of lines) {
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
                try {
                    await RedisWorker.setSession(email as string, JSON.stringify({
                        accessToken: accessToken,
                        userId: userId
                    }));
                    accounts.push({
                        login: email,
                        proxyThreads: 200,
                        userAgent,
                        stickyProxy,
                        password
                    });
                    logger.debug(`Redis session set for ${email}`);
                } catch (err) {
                    logger.debug(`Failed to set session for ${email}: ${err}`);
                }
            } else {
                logger.debug(`Skipping invalid line in ready_accounts.txt: ${line}`);
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