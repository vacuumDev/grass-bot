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


    constructor() {
        this.browserId = uuidv4();
    }

    // Log in and set up the axios instance.
    async login(email: string, password: string): Promise<void> {
        this.currentProxyUrl = (await ProxyManager.getProxy()) as string;
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

            // Retrieve user data to set userId.
            const user: UserResponseData = await this.getUser();
            this.userId = user.userId;
            await RedisWorker.setSession(email, JSON.stringify({
                accessToken: this.accessToken,
                userId: this.userId
            }));
        } catch (error: any) {
            logger.error("Error during login:" + error.message);
        }
    }

    async getUser(): Promise<UserResponseData> {
        try {
            await randomDelay();
            const res: AxiosResponse<ApiResponseDto<UserResponseData>> = await this.grassApi.get("/retrieveUser");
            return res.data.result.data;
        } catch (error: any) {
            logger.error("Error retrieving user data:" + error.message);
            await this.reconnect(true);
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
            await this.reconnect(true);
            throw error;
        }
    }

    // Check‑in call similar to the Python version.
    async checkIn(): Promise<{ destinations: string[]; token: string }> {
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
                throw new Error("No destinations returned from checkIn");
            }
            return { destinations: responseData.destinations, token: responseData.token };
        } catch (error: any) {
            logger.error("Error during checkIn:" + error.message);
            throw new Error("No destinations returned from checkIn");
        }
    }

    /**
     * Opens a WebSocket connection using the destination and token from check‑in.
     */
    async connectWebSocket(destination: string, token: string): Promise<void> {
        const wsUrl = `ws://${destination}/?token=${token}`;
        const rotatingProxy = await ProxyManager.getProxy(true);
        this.ws = new WebSocket(wsUrl, { agent: new HttpsProxyAgent(rotatingProxy) });

        this.ws.on("open", () => {
            // Set connection flags.
            this.sendPing();
            // Start periodic tasks: sending ping and checking score.
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
                        this.sendMessage(responseMessage);
                        logger.debug(`Sending HTTP_REQUEST with message: ${JSON.stringify(responseMessage)}`);
                    } catch (err: any) {
                        try {
                            const result = await this.performHttpRequest(requestUrl);
                            const responseMessage = {
                                id: message.id,
                                origin_action: message.action,
                                result: result,
                            };
                            this.sendMessage(responseMessage);
                            logger.debug(`Sending HTTP_REQUEST with message: ${JSON.stringify(responseMessage)}`);
                        } catch (err: any) {
                            logger.error("Error during HTTP_REQUEST:" + err.message);
                            await this.changeProxy();
                            this.ws?.close();
                            return;
                        }
                    }
                } else if (message.action === "PING") {
                    // Respond to PING messages with a PONG.
                    const pongResponse = {
                        id: message.id,
                        origin_action: "PONG",
                    };
                    this.sendMessage(pongResponse);
                } else if (message.action === "PONG") {
                    const pongResponse = {
                        id: message.id,
                        origin_action: "PONG",
                    };
                    this.sendMessage(pongResponse);
                    logger.debug(`Sent pong message with id ${message.id}`);
                } else if (message.action === "MINING_REWARD") {
                    // Handle mining reward messages (if available).
                    const points = message.data?.points || 0;
                    // Optionally update total points by calling getUser or a dedicated endpoint.
                }
            } catch (err: any) {
                logger.error("Error parsing message:" + err.message);
            }
        });

        this.ws.on("error", async (error: Error) => {
            logger.error("WebSocket error:" + error.message);
            // On error, change proxy and reconnect.
            this.handleWebSocketError();
        });

        this.ws.on("close", async (code: number, reason: Buffer) => {
            logger.info(`Connection closed: Code ${code}, Reason: ${reason.toString()}`);
            // Update flag.
            // Stop periodic tasks.
            this.stopPeriodicTasks();
            // Attempt reconnection with a new proxy.
            await this.reconnect();
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
    sendMessage(message: any): void {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(message));
        } else {
            logger.error("WebSocket is not open. Cannot send message.");
            this.reconnect();
        }
    }

    // Perform an HTTP GET request and return the response (with Base64‑encoded body).
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

    // Check the mining score by calling the /activeDevices endpoint.
    async checkMiningScore(): Promise<boolean> {
        try {
            await randomDelay();
            const res = await this.grassApi.get(`/retrieveDevice?input=%7B%22deviceId%22:%22${this.browserId}%22%7D`, { timeout: 20000 });

            // Find the device where deviceId matches the current browserId
            const device = res.data.result.data;
            logger.debug('Devices: ' + JSON.stringify(device));

            let currentScore = 0;
            if (device) {
                // Get ipScore as the network score
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
            await this.reconnect(true);
            return false;
        }
    }

    // Update the total points by calling the getUser endpoint.
    async updateTotalPoints() {
        try {
            logger.debug(`Update points for later statistics`);
        } catch (error: any) {
            logger.error("Error updating total points:" + error.message);
            await this.reconnect(true);
            return 0;
        }
    }

    // Start periodic tasks: sending pings and checking score.
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
                await this.reconnect();
            }
        }, 180_000 * 10);
    }

    // Stop all periodic intervals.
    stopPeriodicTasks(): void {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = undefined;
        }
    }

    // Change to a new proxy using the ProxyManager.
    async changeProxy(): Promise<void> {
        logger.debug("Changing proxy...");
        this.currentProxyUrl = (await ProxyManager.getProxy()) as string;
        this.proxy = new HttpsProxyAgent(this.currentProxyUrl);
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
        logger.info(`Proxy changed to: ${this.currentProxyUrl}`);
    }

    // Handle WebSocket errors by closing the connection.
    handleWebSocketError(): void {
        if (this.ws) {
            this.ws.close();
        }
    }

    // Attempt to reconnect the WebSocket with a new proxy.
    async reconnect(needProxyChange = false): Promise<void> {
        this.stopPeriodicTasks();
        this.browserId = uuidv4();
        await randomDelay();

        if(needProxyChange) {
            await this.changeProxy();
        }
        try {
            const { destinations, token } = await this.checkIn();
            await this.connectWebSocket(destinations[0] as string, token);
        } catch (error: any) {
            logger.error("Reconnection failed:" + error.message);
            await delay(60000);
            await this.reconnect();
        }
    }

    // Start the entire mining process: login, check‑in, and open the WebSocket.
    async startMining(email: string, password: string): Promise<void> {
        try {
            await this.login(email, password);
        } catch (err: any) {
            logger.error(`Cannot login to ${email} ${password}: ${err.message}`);
            return;
        }
        try {
            await randomDelay();
            const { destinations, token } = await this.checkIn();
            await randomDelay();
            await this.connectWebSocket(destinations[0] as string, token);
            await randomDelay();
        } catch (error: any) {
            logger.error("Error starting mining:" + error.message);
            await delay(60000);
            await this.reconnect();
        }
    }
}
