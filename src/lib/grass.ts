import { HttpsProxyAgent } from "https-proxy-agent";
import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from "axios";
import ApiResponseDto from "../dto/api-response.dto.js";
import LoginResponseData from "../dto/login-response.dto.js";
import UserResponseData from "../dto/user-response.dto.js";
import { IpResponseData } from "../dto/ip-info.dto.js";
import WebSocket from "ws";
import { v4 as uuidv4 } from "uuid";
import ProxyManager from "./proxy-manager.js";
import fs from "fs";
import RedisWorker from "./redis-worker.js";
import { logger } from "./logger.js";

// Read config from data/config.json and get the delay range.
const config = JSON.parse(fs.readFileSync("data/config.json", "utf8"));
const delayRange: [number, number] = config.delay;

function randomDelay(): Promise<void> {
    const [min, max] = delayRange;
    const ms = Math.floor(Math.random() * (max - min + 1)) + min;
    return new Promise((resolve) => setTimeout(resolve, ms));
}

const delay = async (ms: number) => {
    return new Promise((resolve) => setTimeout(resolve, ms));
};

export default class Grass {
    private accessToken!: string;
    private refreshToken!: string;
    private proxy!: HttpsProxyAgent<string>;
    private grassApi!: AxiosInstance;
    private ws?: WebSocket;
    private browserId: string;
    private pingCount: number = 0;
    private minScoreThreshold: number = 75;
    private pingInterval?: NodeJS.Timeout;
    private currentProxyUrl?: string;
    private userId!: string;
    private userAgent: string =
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";

    // Track current state of this thread
    private currentThreadState: string = "idle";
    private index: number = 0;
    private email: string;
    // Flag to track whether a reconnect is in progress
    private isReconnecting: boolean = false;

    constructor(i: number) {
        this.browserId = uuidv4();
        this.index = i;
    }

    /**
     * Update the thread's current state and send a heartbeat to the parent process.
     */
    public setThreadState(state: string): void {
        this.currentThreadState = state;
        if (process.send) {
            process.send({
                type: 'threadHeartbeat',
                workerId: `${process.pid}:${this.index}`,
                threadId: this.browserId,
                state: this.currentThreadState,
                email: this.email,
                timestamp: Date.now()
            });
        }
    }

    // Log in and set up the axios instance.
    async login(email: string, password: string, proxy: string | undefined): Promise<void> {
        this.setThreadState("logging in");
        if (!proxy)
            this.currentProxyUrl = (await ProxyManager.getProxy()) as string;
        else
            this.currentProxyUrl = proxy;
        console.log(this.currentProxyUrl);
        this.proxy = new HttpsProxyAgent(this.currentProxyUrl);

        try {
            const session = await RedisWorker.getSession(email);
            if (session) {
                const parsedSession = JSON.parse(session);
                this.accessToken = parsedSession.accessToken;
                this.userId = parsedSession.userId;
                const config: AxiosRequestConfig = {
                    baseURL: "https://api.getgrass.io",
                    headers: {
                        Authorization: this.accessToken,
                        "User-Agent": this.userAgent,
                    },
                    httpsAgent: this.proxy,
                    httpAgent: this.proxy,
                    timeout: 20000,
                };

                this.grassApi = axios.create(config);
                this.setThreadState("logged in (session reused)");
                return;
            }

            if (this.accessToken) {
                const config: AxiosRequestConfig = {
                    baseURL: "https://api.getgrass.io",
                    headers: {
                        Authorization: this.accessToken,
                        "User-Agent": this.userAgent,
                    },
                    httpsAgent: this.proxy,
                    httpAgent: this.proxy,
                    timeout: 20000,
                };

                this.grassApi = axios.create(config);
                this.setThreadState("logged in");
                return;
            }

            // Add a random delay before making the login request.
            await randomDelay();
            const res: AxiosResponse<ApiResponseDto<LoginResponseData>> = await axios.post(
                "https://api.getgrass.io/login",
                {
                    username: email,
                    password,
                    v: "5.0.0",
                },
                {
                    httpsAgent: this.proxy,
                    httpAgent: this.proxy,
                    timeout: 20000,
                }
            );
            this.accessToken = res.data.result.data.accessToken;
            this.refreshToken = res.data.result.data.refreshToken;

            const configAxios: AxiosRequestConfig = {
                baseURL: "https://api.getgrass.io",
                headers: {
                    Authorization: this.accessToken,
                    "User-Agent": this.userAgent,
                },
                httpsAgent: this.proxy,
                httpAgent: this.proxy,
                timeout: 20000,
            };

            this.grassApi = axios.create(configAxios);

            // Retrieve user data to set userId.
            const user: UserResponseData = await this.getUser();
            this.userId = user.userId;
            await RedisWorker.setSession(email, JSON.stringify({
                accessToken: this.accessToken,
                userId: this.userId
            }));
            this.setThreadState("logged in");
        } catch (error: any) {
            this.setThreadState("login error");
            logger.error("Error during login:" + error.message);
            throw error;
        }
    }

    async getUser(): Promise<UserResponseData> {
        try {
            await randomDelay();
            const res: AxiosResponse<ApiResponseDto<UserResponseData>> = await this.grassApi.get("/retrieveUser");
            return res.data.result.data;
        } catch (error: any) {
            logger.error("Error retrieving user data:" + error.message);
            // Call reconnect if fetching user data fails.
            await this.triggerReconnect(true);
            throw error;
        }
    }

    async getIpInfo(): Promise<IpResponseData> {
        try {
            await randomDelay();
            const res: AxiosResponse<ApiResponseDto<IpResponseData>> = await this.grassApi.get("/activeIps");
            return res.data.result.data;
        } catch (error: any) {
            logger.error("Error retrieving IP info:" + error.message);
            await this.triggerReconnect(true);
            throw error;
        }
    }

    // Check‑in call similar to the Python version.
    async checkIn(): Promise<{ destinations: string[]; token: string }> {
        this.setThreadState("checking in");
        try {
            const data = {
                browserId: this.browserId,
                userId: this.userId,
                version: "5.0.0",
                extensionId: "lkbnfiajjmbhnfledhphioinpickokdi",
                userAgent: this.userAgent,
                deviceType: "extension",
            };
            await randomDelay();
            const rotatingProxy = await ProxyManager.getProxy(true);
            const res = await axios.post("https://director.getgrass.io/checkin", data, {
                httpsAgent: new HttpsProxyAgent(rotatingProxy),
                httpAgent: new HttpsProxyAgent(rotatingProxy),
                timeout: 20000,
            });
            const responseData = res.data;
            if (!responseData.destinations || responseData.destinations.length === 0) {
                this.setThreadState("checkIn error");
                throw new Error("No destinations returned from checkIn");
            }
            this.setThreadState("checked in");
            return { destinations: responseData.destinations, token: responseData.token };
        } catch (error: any) {
            this.setThreadState("checkIn error");
            logger.error("Error during checkIn:" + error.message);
            throw new Error("No destinations returned from checkIn");
        }
    }

    /**
     * Opens a WebSocket connection using the destination and token from check‑in.
     */
    async connectWebSocket(destination: string, token: string): Promise<void> {
        this.setThreadState("connecting websocket");
        const wsUrl = `ws://${destination}/?token=${token}`;
        const rotatingProxy = await ProxyManager.getProxy(true);
        this.ws = new WebSocket(wsUrl, { agent: new HttpsProxyAgent(rotatingProxy) });

        this.ws.on("open", () => {
            // On successful connection, clear the reconnect flag.
            this.isReconnecting = false;
            this.setThreadState("mining");
            this.sendPing();
            this.startPeriodicTasks();
            logger.info("WebSocket connection opened.");
        });

        this.ws.on("message", async (data: WebSocket.Data) => {
            const messageStr = data.toString();
            logger.debug(`Received message: ${messageStr}`);
            try {
                const message = JSON.parse(messageStr);
                if (message.action === "HTTP_REQUEST") {
                    const requestUrl = message.data.url;
                    try {
                        const result = await this.performHttpRequest(requestUrl);
                        const responseMessage = {
                            id: message.id,
                            origin_action: message.action,
                            result: result,
                        };
                        await this.sendMessage(responseMessage);
                        logger.debug(`Sending HTTP_REQUEST with message: ${JSON.stringify(responseMessage)}`);
                    } catch (err: any) {
                        try {
                            const result = await this.performHttpRequest(requestUrl);
                            const responseMessage = {
                                id: message.id,
                                origin_action: message.action,
                                result: result,
                            };
                            await this.sendMessage(responseMessage);
                            logger.debug(`Sending HTTP_REQUEST with message: ${JSON.stringify(responseMessage)}`);
                        } catch (err: any) {
                            logger.error("Error during HTTP_REQUEST:" + err.message);
                            await this.triggerReconnect();
                            this.ws?.close();
                            return;
                        }
                    }
                } else if (message.action === "PING") {
                    const pongResponse = {
                        id: message.id,
                        origin_action: "PONG",
                    };
                    await this.sendMessage(pongResponse);
                } else if (message.action === "PONG") {
                    const pongResponse = {
                        id: message.id,
                        origin_action: "PONG",
                    };
                    await this.sendMessage(pongResponse);
                    logger.debug(`Sent pong message with id ${message.id}`);
                } else if (message.action === "MINING_REWARD") {
                    const points = message.data?.points || 0;
                    // Handle mining reward messages.
                }
            } catch (err: any) {
                logger.error("Error parsing message:" + err.message);
            }
        });

        this.ws.on("error", async (error: Error) => {
            logger.error("WebSocket error:" + error.message);
            this.handleWebSocketError();
        });

        this.ws.on("close", async (code: number, reason: Buffer) => {
            logger.info(`Connection closed: Code ${code}, Reason: ${reason.toString()}`);
            this.stopPeriodicTasks();
            // Centralize reconnection from here.
            await this.triggerReconnect();
        });
    }

    // Send browser information to the server.
    sendBrowserInfo(): void {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            const browserInfo = {
                id: uuidv4(),
                origin_action: "AUTH",
                result: {
                    browser_id: this.browserId,
                    user_id: this.userId,
                    user_agent: this.userAgent,
                    timestamp: Math.floor(Date.now() / 1000),
                    device_type: "extension",
                    version: "5.1.1",
                    extension_id: "ilehaonighjijnmpnagapkhpcdbhclfg",
                },
            };
            this.ws.send(JSON.stringify(browserInfo));
        }
    }

    // Send a PING message.
    sendPing(): void {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            const pingId = uuidv4();
            const pingMessage = {
                id: pingId,
                version: "1.0.0",
                action: "PING",
                data: {},
            };
            this.ws.send(JSON.stringify(pingMessage));
            this.pingCount++;
            logger.debug(`Sent PING message with id: ${pingId} | Total Pings: ${this.pingCount}`);
        }
    }

    // Send an arbitrary message over the WebSocket.
    async sendMessage(message: any): Promise<void> {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(message));
        } else {
            logger.error("WebSocket is not open. Cannot send message.");
            await this.triggerReconnect();
        }
    }

    // Perform an HTTP GET request and return the response.
    async performHttpRequest(url: string): Promise<any> {
        try {
            await randomDelay();
            const response = await axios.get(url, {
                httpAgent: this.proxy,
                httpsAgent: this.proxy,
                timeout: 20000,
            });
            const encodedBody = Buffer.from(JSON.stringify(response.data)).toString("base64");
            const headersObj: Record<string, string> = {};
            for (const key in response.headers) {
                headersObj[key] = response.headers[key];
            }
            return {
                url: url,
                status: response.status,
                status_text: response.statusText,
                headers: headersObj,
                body: encodedBody,
            };
        } catch (error: any) {
            logger.error("Error performing HTTP request:" + error.message);
            throw error;
        }
    }

    // Check the mining score.
    async checkMiningScore(): Promise<boolean> {
        try {
            await randomDelay();
            const res = await this.grassApi.get(`/retrieveDevice?input=%7B%22deviceId%22:%22${this.browserId}%22%7D`, { timeout: 20000 });
            const device = res.data.result.data;
            logger.debug('Devices: ' + JSON.stringify(device));
            let currentScore = 0;
            if (device) {
                currentScore = device.ipScore;
            }
            console.log(`Network Score for device ${this.browserId}: ${currentScore}%`);

            if (currentScore === 0 || currentScore < this.minScoreThreshold) {
                logger.warn(`Score (${currentScore}%) is below threshold (${this.minScoreThreshold}%), reconnecting.`);
                return false;
            }
            return true;
        } catch (error: any) {
            logger.error("Error checking mining score:" + error.message);
            if (error.response) {
                await this.triggerReconnect(error.response.status !== 404);
            } else {
                await this.triggerReconnect(true);
            }
            return false;
        }
    }

    // Update total points (for later statistics).
    async updateTotalPoints() {
        try {
            logger.debug(`Update points for later statistics`);
        } catch (error: any) {
            logger.error("Error updating total points:" + error.message);
            await this.triggerReconnect(true);
            return 0;
        }
    }

    // Start periodic tasks.
    startPeriodicTasks(): void {
        this.stopPeriodicTasks();
        this.pingInterval = setInterval(async () => {
            await randomDelay();
            this.sendPing();
        }, 60000);
        setTimeout(async () => {
            await randomDelay();
            const scoreOk = await this.checkMiningScore();
            if (!scoreOk) {
                this.stopPeriodicTasks();
                if (this.ws) {
                    this.ws.close();
                }
                await this.triggerReconnect();
            }
        }, 180_000 * 20);
    }

    // Stop all periodic intervals.
    stopPeriodicTasks(): void {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = undefined;
        }
    }

    // Change to a new proxy.
    async changeProxy(): Promise<void> {
        logger.debug("Changing proxy...");
        this.currentProxyUrl = (await ProxyManager.getProxy()) as string;
        this.proxy = new HttpsProxyAgent(this.currentProxyUrl);
        const configAxios: AxiosRequestConfig = {
            baseURL: "https://api.getgrass.io",
            headers: {
                Authorization: this.accessToken,
                "User-Agent": this.userAgent,
            },
            httpsAgent: this.proxy,
            httpAgent: this.proxy,
            timeout: 20000,
        };
        this.grassApi = axios.create(configAxios);
        logger.info(`Proxy changed to: ${this.currentProxyUrl}`);
    }

    // Handle WebSocket errors.
    handleWebSocketError(): void {
        if (this.ws) {
            this.ws.close();
            // Optionally ensure that isReconnecting is true.
            this.isReconnecting = true;
        }
    }

    /**
     * Trigger a reconnect if one is not already in progress.
     */
    async triggerReconnect(needProxyChange: boolean = false): Promise<void> {
        if (this.isReconnecting) {
            logger.info("Already reconnecting, skipping additional reconnect attempt.");
            return;
        }
        this.isReconnecting = true;
        this.setThreadState("reconnecting");
        this.stopPeriodicTasks();
        this.browserId = uuidv4();
        await randomDelay();

        if (needProxyChange) {
            await this.changeProxy();
        }
        try {
            const { destinations, token } = await this.checkIn();
            await this.connectWebSocket(destinations[0] as string, token);
            logger.info("Reconnected successfully.");
            this.setThreadState("mining");
            // The "open" event in connectWebSocket will clear isReconnecting.
        } catch (error: any) {
            logger.error("Reconnection failed:" + error.message);
            this.setThreadState("reconnect retry");
            // Reset the flag to allow future attempts.
            this.isReconnecting = false;
            await delay(60000);
            await this.triggerReconnect(false);
        }
    }

    // Start the mining process.
    async startMining(email: string, password: string, proxy: string | undefined): Promise<void> {
        this.setThreadState("starting mining");
        this.email = email;
        try {
            await this.login(email, password, proxy);
        } catch (err: any) {
            this.setThreadState("login failed");
            logger.error(`Cannot login to ${email}: ${err.message}`);
            return;
        }
        try {
            await randomDelay();
            const { destinations, token } = await this.checkIn();
            await randomDelay();
            await this.connectWebSocket(destinations[0] as string, token);
            await randomDelay();
        } catch (error: any) {
            this.setThreadState("mining error");
            logger.error("Error starting mining:" + error.message);
            await delay(60000);
            await this.triggerReconnect();
        }
    }
}
