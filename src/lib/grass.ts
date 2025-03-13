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

// Read config from data/config.json and get the delay range.
const config = JSON.parse(fs.readFileSync("data/config.json", "utf8"));
const delayRange: [number, number] = config.delay;

function randomDelay(): Promise<void> {
    const [min, max] = delayRange;
    const ms = Math.floor(Math.random() * (max - min + 1)) + min;
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export default class Grass {
    private accessToken!: string;
    private refreshToken!: string;
    private proxy!: HttpsProxyAgent<string>;
    private grassApi!: AxiosInstance;
    private ws?: WebSocket;
    private browserId: string;
    private pingCount: number = 0;
    private minScoreThreshold: number = 75;
    private scoreCheckInterval?: NodeJS.Timeout;
    private pingInterval?: NodeJS.Timeout;
    private currentProxyUrl: string;
    private userId!: string;
    private userAgent: string =
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";

    constructor() {
        this.browserId = uuidv4();
    }

    // Log in and set up the axios instance.
    async login(email: string, password: string): Promise<void> {
        this.currentProxyUrl = await ProxyManager.getProxy() as string;
        this.proxy = new HttpsProxyAgent(this.currentProxyUrl);

        try {
            const session = await RedisWorker.getSession(email);
            if(session) {
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

            if(this.accessToken) {
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
        } catch (error) {
            console.error("Error during login:", error.response.data);
            process.exit(-1)
        }
    }

    async getUser(): Promise<UserResponseData> {
        try {
            await randomDelay();
            const res: AxiosResponse<ApiResponseDto<UserResponseData>> = await this.grassApi.get("/retrieveUser");
            return res.data.result.data;
        } catch (error) {
            console.error("Error retrieving user data:", error);
            await this.reconnect();
            throw error;
        }
    }

    async getIpInfo(): Promise<IpResponseData> {
        try {
            await randomDelay();
            const res: AxiosResponse<ApiResponseDto<IpResponseData>> = await this.grassApi.get("/activeIps");
            return res.data.result.data;
        } catch (error) {
            console.error("Error retrieving IP info:", error);
            await this.reconnect();
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
            const res = await axios.post("https://director.getgrass.io/checkin", data, {
                httpsAgent: this.proxy,
                httpAgent: this.proxy,
                timeout: 20000,
            });
            const responseData = res.data;
            if (!responseData.destinations || responseData.destinations.length === 0) {
                throw new Error("No destinations returned from checkIn");
            }
            return { destinations: responseData.destinations, token: responseData.token };
        } catch (error) {
            console.error("Error during checkIn:", error);
            await this.reconnect();
        }
    }

    /**
     * Opens a WebSocket connection using the destination and token from check‑in.
     */
    connectWebSocket(destination: string, token: string): void {
        const wsUrl = `ws://${destination}/?token=${token}`;
        this.ws = new WebSocket(wsUrl, { agent: this.proxy });

        this.ws.on("open", () => {
            this.sendPing();
            // Start periodic tasks: sending ping and checking score.
            this.startPeriodicTasks();
        });

        this.ws.on("message", async (data: WebSocket.Data) => {
            const messageStr = data.toString();
            console.log('Received message', messageStr);
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
                        console.log(`Sending HTTP_REQUEST with message: ${responseMessage}`)
                    } catch (err) {
                        console.error("Error during HTTP_REQUEST:", err);
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
                    console.log(`Sent pong message with id ${message.id}`)
                } else if (message.action === "MINING_REWARD") {
                    // Handle mining reward messages (if available).
                    const points = message.data?.points || 0;
                    // Optionally update total points by calling getUser or a dedicated endpoint.
                }
            } catch (err) {
                console.error("Error parsing message:", err);
            }
        });

        this.ws.on("error", async (error: Error) => {
            console.error("WebSocket error:", error);
            // On error, change proxy and reconnect.
            this.handleWebSocketError();
            await this.reconnect();
        });

        this.ws.on("close", (code: number, reason: Buffer) => {
            console.log(`Connection closed: Code ${code}, Reason: ${reason.toString()}`);
            // Stop periodic tasks.
            this.stopPeriodicTasks();
            // Attempt reconnection with a new proxy.
            this.reconnect();
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
            console.log(`Sent PING message with id: ${pingId} | Total Pings: ${this.pingCount}`);
        }
    }

    // Send an arbitrary message over the WebSocket.
    sendMessage(message: any): void {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(message));
        } else {
            console.error("WebSocket is not open. Cannot send message.");
            this.reconnect()
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
        } catch (error) {
            console.error("Error performing HTTP request:", error);
            await this.reconnect();
            throw error;
        }
    }

    // Check the mining score by calling the /activeDevices endpoint.
    async checkMiningScore(): Promise<boolean> {
        try {
            await randomDelay();
            const res = await this.grassApi.get("/activeDevices", { timeout: 20000 });
            const devices = res.data.result.data;
            const device = devices.find((d: any) => d.deviceId === this.browserId);

            let currentScore = 0;
            if (device) {
                currentScore = device.ipScore;
            }
            console.log(`Network Score for device ${this.browserId}: ${currentScore}%`);

            if (currentScore === 0 || currentScore < this.minScoreThreshold) {
                console.warn(`Score (${currentScore}%) is below threshold (${this.minScoreThreshold}%), reconnecting.`);
                await this.reconnect();
                return false;
            }
            return true;
        } catch (error) {
            console.error("Error checking mining score:", error);
            await this.reconnect();
            return false;
        }
    }

    // Update the total points by calling the getUser endpoint.
    async updateTotalPoints(): Promise<number> {
        try {
            const user = await this.getUser();
            console.log(`Total points: ${user.totalPoints}`);
            return user.totalPoints;
        } catch (error) {
            console.error("Error updating total points:", error);
            await this.reconnect();
            return 0;
        }
    }

    // Start periodic tasks: sending pings and checking score.
    startPeriodicTasks(): void {
        this.stopPeriodicTasks();
        this.pingInterval = setInterval(() => {
            this.sendPing();
        }, 60000);
        this.scoreCheckInterval = setInterval(async () => {
            const scoreOk = await this.checkMiningScore();
            if (!scoreOk) {
                this.stopPeriodicTasks();
                if (this.ws) {
                    this.ws.close();
                }
            } else {
                await this.updateTotalPoints();
            }
        }, 180_000 * 10);
    }

    // Stop all periodic intervals.
    stopPeriodicTasks(): void {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = undefined;
        }
        if (this.scoreCheckInterval) {
            clearInterval(this.scoreCheckInterval);
            this.scoreCheckInterval = undefined;
        }
    }

    // Change to a new proxy using the ProxyManager.
    async changeProxy(): Promise<void> {
        console.log("Changing proxy...");
        this.currentProxyUrl = await ProxyManager.getProxy() as string;
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
        console.log(`Proxy changed to: ${this.currentProxyUrl}`);
    }

    // Handle WebSocket errors by closing the connection.
    handleWebSocketError(): void {
        if (this.ws) {
            this.ws.close();
        }
    }

    // Attempt to reconnect the WebSocket with a new proxy.
    async reconnect(): Promise<void> {
        console.log("Reconnecting WebSocket with new proxy...");
        this.browserId = uuidv4();
        await randomDelay();
        await this.changeProxy();
        try {
            const { destinations, token } = await this.checkIn();
            this.connectWebSocket(destinations[0] as string, token);
        } catch (error) {
            console.error("Reconnection failed:", error);
            setTimeout(() => {
                this.reconnect();
            }, 10000);
        }
    }

    // Start the entire mining process: login, check‑in, and open the WebSocket.
    async startMining(email: string, password: string): Promise<void> {
        try {
            await this.login(email, password);
            await randomDelay();
            const { destinations, token } = await this.checkIn();
            await randomDelay();
            this.connectWebSocket(destinations[0] as string, token);
            await randomDelay();
        } catch (error) {
            console.error("Error starting mining:", error);
        }
    }
}