import Grass from "./lib/grass.js";
import RedisWorker from "./lib/redis-worker.js";
import {delay, getRandomBrandVersion, getRandomNumber, getValidProxy, headersInterceptor} from "./lib/helper.js";
import config from "./lib/config.js";

const processGrassAccount = async (
    login: string,
    password: string,
    stickyProxy: string,
    rotatingProxy: string,
    proxyThreads: number,
    isPrimary: boolean,
    userAgent: string,
    brandVersion: string
) => {
  await RedisWorker.init();
  const promises = [];
  brandVersion = brandVersion != null ? brandVersion : String(getRandomBrandVersion());

  const min = config.delay[0],
      max = config.delay[1];

  for (let i = 0; i < proxyThreads; i++) {
    const isLowAmount = isPrimary && proxyThreads < 30;
    const ms = Math.floor(Math.random() * (max - min + 1)) + min;
    const grass = new Grass(i, isPrimary && i === 0, userAgent, isLowAmount, login, brandVersion);

    // let validProxy = await getValidProxy(stickyProxy);
    // while (!validProxy) {
    //   validProxy = await getValidProxy(stickyProxy);
    //   await delay(100);
    // }
    //
    // stickyProxy = validProxy;

    while(true) {
      try {
        await grass.login(login, password, stickyProxy);
        break;
      } catch (err) {
        await delay(5000 + getRandomNumber(config.accDelay[0], config.accDelay[1]));
        let validProxy = await getValidProxy(stickyProxy);
        while (!validProxy) {
          validProxy = await getValidProxy(stickyProxy);
          await delay(100);
        }

        stickyProxy = validProxy;
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
      brandVersion: string;
    }) => {
      const {
        login,
        password,
        stickyProxy,
        rotatingProxy,
        proxyThreads,
        isPrimary,
        userAgent,
        brandVersion
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
            brandVersion
        );
      } catch (error: any) {
        // Send error message back if needed
        //@ts-ignore
        process.send({ success: false, error: error.message });
      }
    },
);