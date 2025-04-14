import RedisWorker from "./lib/redis-worker.js";
import path from "path";
import fs from "fs";
import { logger } from "./lib/logger.js";
import {delay, generateRandom12Hex, getRandomBrandVersion, getRandomNumber} from "./lib/helper.js";
import config, { Account } from "./lib/config.js";
import UserAgent from "user-agents";

let accounts = config.accounts;

const fixBrokenLines = (
    fileContent: string,
): { fixedContent: string; lines: string[] } => {
  const rawLines = fileContent.split("\n");
  const fixedLines: string[] = [];

  for (let raw of rawLines) {
    raw = raw.replace(/\r$/, ""); // защита от CRLF
    if (!raw.trim()) continue; // пропускаем пустые

    if (raw.startsWith("|")) {
      // строка‑продолжение
      if (fixedLines.length === 0) {
        // на всякий случай, если файл начинается с «|»
        fixedLines.push(raw.replace(/^\|+/, ""));
      } else {
        fixedLines[fixedLines.length - 1] += raw;
      }
    } else {
      fixedLines.push(raw);
    }
  }

  return { fixedContent: fixedLines.join("\n"), lines: fixedLines };
};
const fillAccounts = () => {
  const [minThreads, maxThreads] = config.threads ?? [180, 220];

  accounts = accounts.map((acc: any) => {
    let country = "";
    const COUNTRY_RE =
        /(?:[-_=](?:country|region)[-_]|[-=])([a-z]{2})(?=[.\-_:]|$)/i;
    if(acc.stickyProxy && acc.stickyProxy.match(COUNTRY_RE))
      country = acc.stickyProxy.match(COUNTRY_RE)[1]
    else country = config.countries[getRandomNumber(0, config.countries.length - 1)];

    return {
      login: acc.login,
      password: acc.password ?? 'NO_PASS',
      proxyThreads: acc.proxyThreads ?? getRandomNumber(minThreads, maxThreads),
      userAgent: acc.userAgent ?? new UserAgent({ deviceCategory: 'desktop' }).toString(), // пример, можешь подставить свою генерацию
      stickyProxy: acc.stickyProxy ?? config.stickyProxy
          .replace("{ID}", generateRandom12Hex())
          .replace("{COUNTRY}", country), // пример
      rotatingProxy:
          acc.rotatingProxy ??
          config.rotatingProxy.replace("{COUNTRY}", country),
      brandVersion: acc.brandVersion ?? String(getRandomBrandVersion()), // пример
    } as Account;
  });

  logger.debug("Accounts have been filled with default values if missing.");
  config.accounts = accounts;
  fs.writeFileSync("data/config.json", JSON.stringify(config, null, 2));
  logger.debug("Config file updated after filling accounts.");
};


const main = async () => {
  await RedisWorker.init();
  fillAccounts();
  const [minThreads, maxThreads] = config.threads ?? [180, 220];

  const readyAccountsPath = path.join(process.cwd(), "data/ready_accounts.txt");
  if (fs.existsSync(readyAccountsPath)) {
    const originalContent = fs.readFileSync(readyAccountsPath, "utf-8");
    const { fixedContent, lines } = fixBrokenLines(originalContent);

    if (fixedContent !== originalContent) {
      fs.writeFileSync(readyAccountsPath, fixedContent);
      logger.debug("ready_accounts.txt has been cleaned up.");
    }
    for (const line of lines) {
      if (line.includes("|")) {
        const parts: string[] = line.split("|");
        if (parts.length >= 6) {
          const email = parts[0];

          if (accounts.some((acc: any) => acc.login === email)) {
            logger.debug(
              `Account ${email} already exists in config, skipping.`,
            );
            continue;
          }

          const password = parts[4];
          const stickyProxy = parts[5];
          const accessToken = parts[6];
          const userId = parts[7];
          const userAgent = parts[8];

          let rotatingProxy: string = "";

          if (parts.length === 12) rotatingProxy = parts[11] as string;
          else {
            const match = stickyProxy.match(/country-([a-zA-Z0-9]+)/);

            if (match) {
              rotatingProxy = config.rotatingProxy.replace(`{COUNTRY}`, match[1]);
            }
          }

          let brandVersion: string = "";

          if (parts.length === 13) brandVersion = parts[12] as string;
          else brandVersion = String(getRandomBrandVersion());

          const account: any = {
            login: email,
            proxyThreads: getRandomNumber(minThreads, maxThreads),
            userAgent,
            stickyProxy,
            password,
            rotatingProxy,
            brandVersion
          };

          try {
            await RedisWorker.setSession(
              email as string,
              JSON.stringify({
                accessToken: accessToken,
                userId: userId,
              }),
            );
            accounts.push(account);
            logger.debug(`Redis session set for ${email}`);
          } catch (err) {
            logger.debug(`Failed to set session for ${email}: ${err}`);
          }
        } else {
          logger.debug(`Skipping invalid line in ready_accounts.txt: ${line}`);
        }
      } else {
        const parts = line.split(":");
        if (parts.length >= 6) {
          const email = parts[0];

          if (accounts.some((acc: any) => acc.login === email)) {
            logger.debug(
              `Account ${email} already exists in config, skipping.`,
            );
            continue;
          }

          const accessToken = parts[4];
          const userId = parts[5];
          try {
            await RedisWorker.setSession(
              email as string,
              JSON.stringify({
                accessToken: accessToken,
                userId: userId,
              }),
            );
            //@ts-ignore
            accounts.push({
              login: email!,
              proxyThreads: getRandomNumber(minThreads, maxThreads),
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
    logger.debug(
      "No ready_accounts.txt file found, skipping Redis session setup from file.",
    );
  }

  config.accounts = accounts;
  fs.writeFileSync("data/config.json", JSON.stringify(config, null, 2));
  process.exit(0);
};

main();
