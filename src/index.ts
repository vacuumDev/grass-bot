import { fork } from "child_process";
import path from "path";
import RedisWorker from "./lib/redis-worker.js";
import io from "@pm2/io";
import readline from "readline";
import { logger } from "./lib/logger.js";
import { shuffle } from "./lib/helper.js";
import config, { Account } from "./lib/config.js";
import os from "os";
import express from 'express'

io.init({
  metrics: {
    http: true,
  },
});

const app = express();
const PORT = config.httpPort || 3000;

// Токен для авторизации (задается в конфиге или по умолчанию)
const AUTH_TOKEN = config.authToken || "secret-token";

// Middleware для проверки токена в заголовке authorization
app.use((req, res, next) => {
  if (req.headers.authorization !== AUTH_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});


const workerStatuses = new Map<string, any>();
const accountStartTimes = new Map<string, number>();
const accountPoints = new Map<string, number>();
const accountRegions = new Map<string, string>();
const accountPointsHistory = new Map<
  string,
  { timestamp: number; points: number }[]
>();

const MS_IN_24H = 24 * 60 * 60 * 1000;

function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  return `${days}d ${hours}h ${minutes}m`;
}

let accounts = config.accounts;

// Delay range from config if needed
const [minDelay, maxDelay] = config.accDelay || [100, 10000];

function randomDelay(): Promise<void> {
  const ms = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Function to run a worker process for given credentials and thread count
const runWorker = (
  login: string,
  password: string,
  stickyProxy: string,
  rotatingProxy: string,
  threads: number,
  isPrimary: boolean,
  userAgent: string,
  brandVersion: string
) => {
  return new Promise((_resolve, _reject) => {
    const workerPath = path.join(process.cwd(), "dist/worker.js");
    const worker = fork(workerPath);

    worker.on("message", (msg: any) => {
      if (msg.type === "threadHeartbeat") {
        if (!accountStartTimes.has(msg.email)) {
          accountStartTimes.set(msg.email, msg.timestamp);
        }

        const status: any = {
          state: msg.state,
          lastUpdate: msg.timestamp,
          threadId: msg.threadId,
          email: msg.email,
          pingCount: msg.pingCount,
          region: msg.region,
        };
        workerStatuses.delete(msg.workerId);
        workerStatuses.set(msg.workerId, status);
        accountRegions.delete(msg.email);
        accountRegions.set(msg.email, msg.region);
      } else if (msg.type === "updatePoints") {
        accountPoints.set(msg.email, msg.pingCount);

        // Обновляем историю очков
        const now = Date.now();
        const history = accountPointsHistory.get(msg.email) ?? [];
        history.push({ timestamp: msg.timestamp, points: msg.pingCount });

        // Оставляем только записи за последние 24 часа

        accountPointsHistory.delete(msg.email);
        accountPointsHistory.set(
          msg.email,
          history.filter((entry) => entry.timestamp >= now - MS_IN_24H),
        );
      }
    });

    worker.on("error", (err) => {
      logger.error(`Worker error for ${login}: ${err}`);
    });

    worker.on("exit", (code) => {
      if (code !== 0) {
        logger.error(`Worker for ${login} exited with code ${code}`);
      }
    });

    // Send login, password and thread count to the worker
    worker.send({
      login,
      password,
      stickyProxy,
      rotatingProxy,
      proxyThreads: threads,
      isPrimary,
      userAgent,
      brandVersion
    });
  });
};

const main = async () => {
  await RedisWorker.init();

  logger.debug("Loaded config:" + JSON.stringify(accounts));

  if (config.shuffle) {
    logger.debug("Shuffling enabled");
    shuffle(accounts);
  }

  const workerPromises = [];
  for (const account of accounts) {
    const {
      login,
      password,
      stickyProxy,
      rotatingProxy,
      proxyThreads,
      userAgent,
      brandVersion
    } = account;
    workerPromises.push(
      runWorker(
        login,
        password,
        stickyProxy,
        rotatingProxy,
        proxyThreads,
        true,
        userAgent,
        brandVersion
      ),
    );
    await randomDelay();
  }

  try {
    await Promise.all(workerPromises);
    logger.debug("All workers completed successfully.");
  } catch (error) {
    logger.debug("An error occurred in one of the workers:" + error);
  }
};

main();

const stats = () => {
  const now = Date.now();
  const grouped = new Map<
    string,
    {
      startTime: number;
      id: string;
      email: string;
      totalPoints: number;
      threadsWorking: number;
      threadsTotal: number;
      states: string[];
    }
  >();

  workerStatuses.forEach((status, workerId) => {
    if (now - status.lastUpdate > 240_000) {
      status.state = "inactive";
      logger.debug(`Worker ${workerId} marked as inactive due to inactivity.`);
    }
  });

  for (const [, status] of workerStatuses) {
    const { email, state, pingCount, threadId } = status;
    const accCfg: Account = accounts.find(
      (acc: Account) => acc.login === email,
    )!;
    if (!grouped.has(email)) {
      grouped.set(email, {
        startTime: accountStartTimes.get(email) ?? now,
        id: threadId,
        email: email,
        totalPoints: pingCount,
        threadsWorking: state === "mining" ? 1 : 0,
        threadsTotal: accCfg.proxyThreads ?? 0,
        states: [state],
      });
    } else {
      const acc = grouped.get(email)!;
      acc.totalPoints = pingCount;
      acc.threadsWorking += state === "mining" ? 1 : 0;
      acc.states.push(state);
    }
  }

  let rows: any[] | undefined = [];
  let totalPoints = 0;
  let totalThreads = 0;
  let totalChange24h = 0;

  for (const [, acc] of grouped) {
    const workingTime = formatDuration(now - acc.startTime);
    const accountState = acc.states.includes("mining")
      ? "mining"
      : acc.states[acc.states.length - 1];

    // Текущие очки
    const current = accountPoints.get(acc.email) ?? 0;

    // Ищем точку за 24h назад (или самую раннюю, если нет)
    const history = accountPointsHistory.get(acc.email) ?? [];
    const cutoff = now - MS_IN_24H;
    const oldEntry = history.find((e) => e.timestamp <= cutoff) ?? history[0];
    const change24h = oldEntry ? current - oldEntry.points : 0;

    rows.push({
      "Start Time": new Date(acc.startTime).toISOString(),
      Email: acc.email,
      State: accountState,
      Points: accountPoints.get(acc.email) || 0,
      "24h Change": change24h,
      "Targeting country": accountRegions.get(acc.email) || "N/A",
      "Threads Working": `${acc.threadsWorking}/${acc.threadsTotal}`,
      "Working Time": workingTime,
    });

    totalPoints += accountPoints.get(acc.email) || 0;
    totalThreads += acc.threadsWorking;
    totalChange24h += change24h;
  }

  rows.sort((a, b) => new Date(a["Start Time"]).getTime() - new Date(b["Start Time"]).getTime());

  if (!config.debug) {
    readline.cursorTo(process.stdout, 0, 0);
    readline.clearScreenDown(process.stdout);
  }
  console.table(rows);
  let info: string | undefined =
    `Total Accounts: ${grouped.size} | Total Threads Live: ${totalThreads} | Total Points: ${totalPoints} | Total 24h Change: ${totalChange24h}`;
  console.log(info);
  grouped.clear();
  return;
};
stats();
setInterval(stats, 5_000);

// Эндпоинт для получения статистики
app.get("/getStatistics", (req, res) => {
  const now = Date.now();
  const aggregated = new Map();

  for (const account of accounts) {
    const email = account.login;
    const points = accountPoints.get(email) || 0;
    const history = accountPointsHistory.get(email) || [];
    const cutoff = now - MS_IN_24H;
    const oldEntry = history.find((e) => e.timestamp <= cutoff) || (history[0] || { points: 0 });
    const change24h = points - oldEntry.points;

    let threadsWorking = 0;
    let totalThreads = 0;
    for (const status of workerStatuses.values()) {
      if (status.email === email) {
        totalThreads++;
        if (status.state === "mining") {
          threadsWorking++;
        }
      }
    }
    aggregated.set(email, { points, change24h, threadsWorking, totalThreads });
  }

  let grandTotalPoints = 0;
  let grandTotalChange24h = 0;
  let grandThreadsWorking = 0;
  let grandTotalThreads = 0;

  aggregated.forEach((data) => {
    grandTotalPoints += data.points;
    grandTotalChange24h += data.change24h;
    grandThreadsWorking += data.threadsWorking;
    grandTotalThreads += data.totalThreads;
  });

  const overallStatus = grandThreadsWorking > 0 ? "working" : "inactive";
  const cpus = os.cpus();
  const cpuUsages = cpus.map((cpu, index) => {
    const times = cpu.times;
    const total = times.user + times.nice + times.sys + times.idle + times.irq;
    const usage = ((total - times.idle) / total) * 100;
    return { core: index, usage: Number(usage.toFixed(2)) };
  });
  const averageCpuUsage =
      cpuUsages.reduce((acc, cur) => acc + cur.usage, 0) / cpuUsages.length;

  // Memory usage in GB
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const usedMemGB = usedMem / (1024 ** 3);
  const totalMemGB = totalMem / (1024 ** 3);
  const usedMemPercentage = (usedMem / totalMem) * 100;

  const countries = {};
  accounts.forEach((acc) => {
    const region = accountRegions.get(acc.login) || "N/A";
    countries[region] = (countries[region] || 0) + 1;
  });

  const statsData = {
    totalPoints: grandTotalPoints,
    totalChange24h: grandTotalChange24h,
    status: overallStatus,
    threads: {
      working: grandThreadsWorking,
      total: grandTotalThreads,
    },
    cpu: {
      averageUsage: Number(averageCpuUsage.toFixed(2)),
      cores: cpuUsages, // Array with usage for each core
      numCores: cpus.length, // Total number of cores
    },
    memory: {
      used: Number(usedMemGB.toFixed(2)),
      total: Number(totalMemGB.toFixed(2)),
      usedPercentage: Number(usedMemPercentage.toFixed(2)),
    },
    countries, // List of countries and count of accounts per country
    totalAccounts: accounts.length
  };


  res.json(statsData);
});

app.listen(PORT, () => {
  logger.info(`Express server listening on port ${PORT}`);
});