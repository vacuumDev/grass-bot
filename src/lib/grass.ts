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
import UserAgent from "user-agents";

// Чтение конфига и получение диапазона задержки.
const config = JSON.parse(fs.readFileSync("data/config.json", "utf8"));
const delayRange: [number, number] = config.delay;

function generateRandom12Hex() {
    let hex = '';
    for (let i = 0; i < 12; i++) {
        hex += Math.floor(Math.random() * 16).toString(16);
    }
    return hex;
}

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
        new UserAgent({ deviceCategory: 'desktop' }).toString();

    // Текущее состояние потока
    private currentThreadState: string = "idle";
    private index: number = 0;
    private email!: string;
    private rotatingProxy!: string;

    private totalPoints: number = 0;
    private totalPointsTimer?: NodeJS.Timeout;
    private isPrimary;
    private retryCount = 0;
    private isLowAmount: boolean;

    constructor(i: number, isPrimary: boolean, userAgent: string, isLowAmount: boolean) {
        this.isPrimary = isPrimary;
        this.browserId = uuidv4();
        this.index = i;
        this.userAgent = userAgent ? userAgent : this.userAgent;
        this.isLowAmount = isLowAmount;
    }

    /**
     * Обновление состояния потока и отправка heartbeat родительскому процессу.
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
                pingCount: this.totalPoints,
                timestamp: Date.now()
            });
        }
    }

    // Логин и настройка экземпляра axios.
    async login(email: string, password: string, stickyProxy: string): Promise<void> {
        this.setThreadState("logging in");
        this.currentProxyUrl = stickyProxy ? stickyProxy.replace('{ID}', generateRandom12Hex()) : ProxyManager.getProxy();
        this.proxy = new HttpsProxyAgent(this.currentProxyUrl as string);

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

            // Получаем данные пользователя, чтобы установить userId.
            const user: UserResponseData = await this.getUser();
            this.userId = user.userId;
            await RedisWorker.setSession(email, JSON.stringify({
                accessToken: this.accessToken,
                userId: this.userId
            }));
            this.setThreadState("logged in");
        } catch (error: any) {
            this.setThreadState("login error");
            logger.debug("Error during login:" + error);
            throw error;
        }
    }

    async getUser(): Promise<UserResponseData> {
        try {
            await randomDelay();
            const res: AxiosResponse<ApiResponseDto<UserResponseData>> = await this.grassApi.get("/retrieveUser");
            return res.data.result.data;
        } catch (error: any) {
            logger.debug("Error retrieving user data:" + error);
            throw error;
        }
    }

    async getIpInfo(): Promise<IpResponseData> {
        try {
            await randomDelay();
            const res: AxiosResponse<ApiResponseDto<IpResponseData>> = await this.grassApi.get("/activeIps");
            return res.data.result.data;
        } catch (error: any) {
            logger.debug("Error retrieving IP info:" + error);
            throw error;
        }
    }

    // Check‑in: отправляет данные и получает destinations и token.
    async checkIn(): Promise<{ destinations: string[]; token: string }> {
        this.setThreadState("checking in");
        try {
            const data = {
                browserId: this.browserId,
                userId: this.userId,
                version: "5.0.0",
                extensionId: "lkbnfiajjmbhnfledhphioinpickokdi",
                userAgent: new UserAgent({ deviceCategory: 'desktop' }).toString(),
                deviceType: "extension",
            };
            await randomDelay();
            const rotatingProxy = this.rotatingProxy ? this.rotatingProxy : ProxyManager.getProxy(true);
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
            logger.debug("Error during checkIn:" + error);
            throw error;
        }
    }

    /**
     * Открывает WebSocket-соединение, обёрнутое в Promise.
     * При ошибке (например, при отправке сообщения или закрытии сокета) вызывается reject.
     */
    async connectWebSocket(destination: string, token: string): Promise<void> {
        this.setThreadState("connecting websocket");

        const wsUrl = `ws://${destination}/?token=${token}`;
        const rotatingProxy = this.rotatingProxy ? this.rotatingProxy : ProxyManager.getProxy(true);

        return new Promise<void>((resolve, reject) => {
            try {

                this.ws = new WebSocket(wsUrl, { agent: new HttpsProxyAgent(rotatingProxy), handshakeTimeout: 20_000 });

                this.ws.on("open", async () => {
                    this.setThreadState("mining");
                    try {
                        this.sendPing();
                    } catch (err: any) {
                        logger.debug("Reconnection failed:" + err.message);
                        this.setThreadState("reconnect retry");
                        await delay(1_000);
                        await this.triggerReconnect(false);
                    }
                    this.startPeriodicTasks();
                    logger.debug("WebSocket connection opened.");
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
                                // Пытаемся выполнить запрос ещё раз перед выбросом ошибки.
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
                                    logger.debug("Error during HTTP_REQUEST:" + err);
                                    reject(err);
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
                            // Обработка сообщения о награде за майнинг.
                            const points = message.data?.points || 0;
                        }
                    } catch (err: any) {
                        logger.debug("Error parsing message:" + err);
                        reject(err);
                    }
                });

                this.ws.on("error", (error: Error) => {
                    logger.debug("WebSocket error:" + error);
                });

                this.ws.on("close", (code: number, reason: Buffer) => {
                    logger.debug(`Connection closed: Code ${code}, Reason: ${reason.toString()}`);
                    this.stopPeriodicTasks();
                    if (this.ws) {
                        this.ws.removeAllListeners('open');
                        this.ws.removeAllListeners('message');
                        this.ws.removeAllListeners('close');
                        this.ws.removeAllListeners('error');

                        this.ws = undefined;
                    }
                    reject(new Error(`WebSocket closed: Code ${code}, Reason: ${reason.toString()}`));
                });
            } catch (err: any) {
                reject(err);
            }
        });
    }

    // Отправка PING-сообщения.
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
            this.setThreadState(this.currentThreadState);
            logger.debug(`Sent PING message with id: ${pingId} | Total Pings: ${this.pingCount}`);
        } else {
            logger.debug("WebSocket is not open. Cannot send PING.");
            throw new Error('Can not send message')
        }
    }

    // Отправка произвольного сообщения через WebSocket.
    async sendMessage(message: any): Promise<void> {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(message));
        } else {
            logger.debug("WebSocket is not open. Cannot send message.");
            throw new Error("WebSocket is not open");
        }
    }

    // Выполнение HTTP GET запроса с последующим кодированием тела ответа.
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
            logger.debug("Error performing HTTP request:" + error);
            throw error;
        }
    }

    async updateTotalPoints(): Promise<void> {
        try {
            const userData = await this.getUser();
            this.totalPoints = userData.totalPoints;

            if (process.send) {
                process.send({
                    type: 'updatePoints',
                    workerId: `${process.pid}:${this.index}`,
                    threadId: this.browserId,
                    state: this.currentThreadState,
                    email: this.email,
                    pingCount: this.totalPoints,
                    timestamp: Date.now(),
                });
            }
        } catch (error: any) {
            logger.debug(`Failed to update totalPoints: ${error}`);
            throw new Error('can not receive user data');
        }
    }


    private scheduleTotalPointsUpdate(): void {
        const minMs = 10 * 60_000;
        const maxMs = 40 * 60_000;
        const nextDelay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;

        this.totalPointsTimer = setTimeout(async () => {
            try {
                await this.updateTotalPoints();
            } catch (err) {
                await this.changeProxy();
                await this.updateTotalPoints();
            }
            this.scheduleTotalPointsUpdate();
        }, nextDelay);
    }


    // Остановка всех периодических задач.
    stopPeriodicTasks(): void {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = undefined;
        }
    }

    // Запуск периодических задач.
    startPeriodicTasks(): void {
        this.stopPeriodicTasks();

        this.pingInterval = setInterval(async () => {
            try {
                await randomDelay();
                this.sendPing();
            } catch (err: any) {
                logger.debug("Reconnection failed:" + err.message);
                this.setThreadState("reconnect retry");
                await delay(1_000);
                await this.triggerReconnect(false);
            }
        }, 120_000);
        // setTimeout(async () => {
        //     await randomDelay();
        //     const scoreOk = await this.checkMiningScore();
        //     if (!scoreOk) {
        //         this.stopPeriodicTasks();
        //         if (this.ws) {
        //             this.ws.close();
        //             this.ws.removeAllListeners();
        //         }
        //     }
        // }, 180_000 * 20);
    }
    // Смена прокси.
    async changeProxy(): Promise<void> {
        logger.debug("Changing proxy...");

        if (this.currentProxyUrl) {
            const sidRegex = /sid-[0-9a-f]{12}4(?=-filter)/;
            const newSid = generateRandom12Hex() + '4';

            if (sidRegex.test(this.currentProxyUrl)) {
                this.currentProxyUrl = this.currentProxyUrl.replace(sidRegex, `sid-${newSid}`);
                logger.debug(`Generated new SID: ${newSid}`);
            } else {
                this.currentProxyUrl = ProxyManager.getProxy();
            }
        } else {
            this.currentProxyUrl = ProxyManager.getProxy();
        }

        const account = config.accounts.find((acc: any) => acc.login === this.email);
        if (account) {
            account.stickyProxy = this.currentProxyUrl;
            fs.writeFileSync("data/config.json", JSON.stringify(config, null, 2), "utf8");
            logger.debug(`Updated stickyProxy for ${this.email} in config.json`);
        } else {
            logger.debug(`No matching account found for ${this.email} — skipping config update`);
        }


        this.proxy = new HttpsProxyAgent(this.currentProxyUrl as string);
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
        logger.debug(`Proxy changed to: ${this.currentProxyUrl}`);
    }

    /**
     * Попытка переподключения.
     * Если происходит ошибка при checkIn или connectWebSocket, то ошибка пробрасывается наружу
     * и может быть обработана внешним блоком catch для повторного вызова triggerReconnect.
     */
    async triggerReconnect(needProxyChange: boolean = false): Promise<void> {
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
            logger.debug("Reconnected successfully.");
            this.setThreadState("mining");
        } catch (error: any) {
            logger.debug("Reconnection failed:" + error);
            this.retryCount++;
            if(this.retryCount >= 10) {
                await delay(60_000);
                this.retryCount = 0;
            }
            this.setThreadState("reconnect retry");
            await randomDelay();
            await delay(1_000);
            await this.triggerReconnect(false);
        }
    }

    /**
     * Запуск процесса майнинга.
     * В случае возникновения ошибки, она пробрасывается наружу для дальнейшей обработки (например, вызова triggerReconnect).
     */
    async startMining(email: string, password: string, stickyProxy: string, rotatingProxy: string): Promise<void> {
        this.setThreadState("starting mining");
        this.email = email;

        if(rotatingProxy)
            this.rotatingProxy = rotatingProxy;

        try {
            await this.login(email, password, stickyProxy);
        } catch (err) {
            await this.changeProxy();
            await delay(1_000);
            await this.startMining(email, password, stickyProxy, rotatingProxy);
        }

        try {
            await randomDelay();

            if(this.isPrimary) {
                this.scheduleTotalPointsUpdate();
            }

            const { destinations, token } = await this.checkIn();
            await randomDelay();
            await this.connectWebSocket(destinations[0] as string, token);
            await randomDelay();
        } catch (error: any) {
            this.setThreadState("mining error");
            logger.debug("Error during mining process:" + error);
            await randomDelay();
            await delay(1_000);
            await this.triggerReconnect(false);
        }
    }
}
