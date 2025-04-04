import Grass from "./lib/grass.js";
import RedisWorker from "./lib/redis-worker.js";
import {delay, getRandomNumber, headersInterceptor} from "./lib/helper.js";
import axios from "axios";
import config from "./lib/config.js";

const processGrassAccount = async (
  login: string,
  password: string,
  stickyProxy: string,
  rotatingProxy: string,
  proxyThreads: number,
  isPrimary: boolean,
  userAgent: string,
) => {
  await RedisWorker.init();
  const promises = [];

  const min = config.delay[0],
    max = config.delay[1];

  for (let i = 0; i < proxyThreads; i++) {
    const isLowAmount = isPrimary && proxyThreads < 30;
    const ms = Math.floor(Math.random() * (max - min + 1)) + min;
    const grass = new Grass(i, isPrimary && i === 0, userAgent, isLowAmount, login);

    if(i === 0 && isPrimary) {
      try {
        await grass.login(login, password, stickyProxy);
      } catch (err) {
        await grass.changeProxy();
        await delay(getRandomNumber(config.accDelay[0], config.accDelay[1]));
        await grass.login(login, password, stickyProxy);
      }
    }

    promises.push(
      grass.startMining(login, password, stickyProxy, rotatingProxy),
    );
    await delay(ms);
  }
  // Prevent the worker from exiting immediately (if needed)
  await Promise.all(promises);
  await new Promise(() => {});
};

process.on(
  "message",
  async (msg: {
    login: string;
    password: string;
    stickyProxy: string;
    rotatingProxy: string;
    isPrimary: boolean;
    proxyThreads: number;
    userAgent: string;
  }) => {
    const {
      login,
      password,
      stickyProxy,
      rotatingProxy,
      proxyThreads,
      isPrimary,
      userAgent,
    } = msg;
    try {
      await processGrassAccount(
        login,
        password,
        stickyProxy,
        rotatingProxy,
        proxyThreads,
        isPrimary,
        userAgent,
      );
    } catch (error: any) {
      // Send error message back if needed
      //@ts-ignore
      process.send({ success: false, error: error.message });
    }
  },
);
