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

// Чтение конфига и получение диапазона задержки.
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

    // Текущее состояние потока
    private currentThreadState: string = "idle";
    private index: number = 0;
    private email: string;

    constructor(i: number) {
        this.browserId = uuidv4();
        this.index = i;
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
                timestamp: Date.now()
            });
        }
    }

    // Логин и настройка экземпляра axios.
    async login(email: string, password: string, proxy: string | undefined): Promise<void> {
        this.setThreadState("logging in");
        this.currentProxyUrl = proxy ? proxy : ProxyManager.getProxy();
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
                userAgent: this.userAgent,
                deviceType: "extension",
            };
            await randomDelay();
            const rotatingProxy = ProxyManager.getProxy(true);
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
        const rotatingProxy = ProxyManager.getProxy(true);

        return new Promise<void>((resolve, reject) => {
            try {
                this.ws = new WebSocket(wsUrl, { agent: new HttpsProxyAgent(rotatingProxy), timeout: 20_000 });

                this.ws.on("open", async () => {
                    this.setThreadState("mining");
                    try {
                        this.sendPing();
                    } catch (err) {
                        logger.error("Reconnection failed:" + err.message);
                        this.setThreadState("reconnect retry");
                        await delay(60000);
                        await this.triggerReconnect(false);
                    }
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
                                    logger.error("Error during HTTP_REQUEST:" + err.message);
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
                        logger.error("Error parsing message:" + err.message);
                        reject(err);
                    }
                });

                this.ws.on("error", (error: Error) => {
                    logger.error("WebSocket error:" + error.message);
                    if (this.ws) {
                        this.ws.close();
                    }
                });

                this.ws.on("close", (code: number, reason: Buffer) => {
                    logger.info(`Connection closed: Code ${code}, Reason: ${reason.toString()}`);
                    this.stopPeriodicTasks();
                    reject(new Error(`WebSocket closed: Code ${code}, Reason: ${reason.toString()}`));
                });
            } catch (err: any) {
                reject(err);
            }
        });
    }

    // Отправка информации о браузере.
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
        } else {
            logger.error("WebSocket is not open. Cannot send browser info.");
        }
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
            logger.debug(`Sent PING message with id: ${pingId} | Total Pings: ${this.pingCount}`);
        } else {
            logger.error("WebSocket is not open. Cannot send PING.");
            throw new Error('Can not send message')
        }
    }

    // Отправка произвольного сообщения через WebSocket.
    async sendMessage(message: any): Promise<void> {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(message));
        } else {
            logger.error("WebSocket is not open. Cannot send message.");
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
            logger.error("Error performing HTTP request:" + error.message);
            throw error;
        }
    }

    // Проверка mining score.
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
                logger.warn(`Score (${currentScore}%) is below threshold (${this.minScoreThreshold}%).`);
                return false;
            }
            return true;
        } catch (error: any) {
            logger.error("Error checking mining score:" + error.message);
            return false;
        }
    }

    // Обновление статистики очков (в дальнейшем).
    async updateTotalPoints(): Promise<void> {
        try {
            logger.debug(`Update points for later statistics`);
        } catch (error: any) {
            logger.error("Error updating total points:" + error.message);
            throw error;
        }
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
            } catch (err) {
                logger.error("Reconnection failed:" + err.message);
                this.setThreadState("reconnect retry");
                await delay(60000);
                await this.triggerReconnect(false);
            }
        }, 60000);
        setTimeout(async () => {
            await randomDelay();
            const scoreOk = await this.checkMiningScore();
            if (!scoreOk) {
                this.stopPeriodicTasks();
                if (this.ws) {
                    this.ws.close();
                }
            }
        }, 180_000 * 20);
    }
    // Смена прокси.
    async changeProxy(): Promise<void> {
        logger.debug("Changing proxy...");
        this.currentProxyUrl = ProxyManager.getProxy();
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

    // Обработка ошибок WebSocket (только закрываем соединение и выставляем флаг).
    handleWebSocketError(): void {
        if (this.ws) {
            this.ws.close();
        }
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
            logger.info("Reconnected successfully.");
            this.setThreadState("mining");
        } catch (error: any) {
            logger.error("Reconnection failed:" + error.message);
            this.setThreadState("reconnect retry");
            await randomDelay();
            await this.triggerReconnect(false);
        }
    }

    /**
     * Запуск процесса майнинга.
     * В случае возникновения ошибки, она пробрасывается наружу для дальнейшей обработки (например, вызова triggerReconnect).
     */
    async startMining(email: string, password: string, proxy: string | undefined): Promise<void> {
        this.setThreadState("starting mining");
        this.email = email;
        try {
            await this.login(email, password, proxy);
            await randomDelay();
            const { destinations, token } = await this.checkIn();
            await randomDelay();
            await this.connectWebSocket(destinations[0] as string, token);
            await randomDelay();
        } catch (error: any) {
            this.setThreadState("mining error");
            logger.error("Error during mining process:" + error.message);
            await randomDelay();
            await this.triggerReconnect(false);
        }
    }
}
