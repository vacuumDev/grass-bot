import redis, {RedisClientType} from 'redis';




class RedisWorker {
    static client: RedisClientType;
    static async init() {
        const client = redis.createClient({
            socket: {
                host: 'localhost',
                port: 6379
            }
        });

        client.on("error", (err) => console.error("Redis error:", err));
        await client.connect();
        const exists = await client.exists("currentIndex");
        if (!exists) {
            await client.set("currentIndex", 0);
        }
        this.client = client;
    }

    // Retrieves the current value of 'currentIndex'
    static async getIndex() {
        const value = await this.client.get("currentIndex");
        return Number(value);
    }

    // Increments the 'currentIndex' and returns the new value
    static async increment() {
        return await this.client.incr("currentIndex");
    }

    // A convenience method that gets and increments the index
    static async getNext() {
        const index = await RedisWorker.getIndex();
        await RedisWorker.increment();
        return index;
    }
}

export default RedisWorker;