import redis from "redis";
import { logger } from "./logger.js";
import config from "./config.js";

class RedisWorker {
  static client: any;
  static async init() {
    const client = redis.createClient({
      url: config.redisUrl,
    });

    client.on("error", (err) => logger.debug("Redis error:" + err));
    await client.connect();
    this.client = client;
  }

  // Stores a session key with the provided value (string)
  static async setSession(key: string, value: string) {
    return await this.client.set(key, value);
  }

  // Retrieves the session value for the given key
  static async getSession(key: string): Promise<string | null> {
    return await this.client.get(key);
  }
}

export default RedisWorker;
