"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const https_proxy_agent_1 = require("https-proxy-agent");
const axios_1 = __importDefault(require("axios"));
class Grass {
    constructor(proxyUrl) {
        this.proxy = new https_proxy_agent_1.HttpsProxyAgent(proxyUrl);
    }
    login(email, password) {
        return __awaiter(this, void 0, void 0, function* () {
            const res = yield axios_1.default.post('https://api.getgrass.io/login', {
                username: email,
                password,
                v: "5.1.1"
            });
            this.accessToken = res.data.result.data.accessToken;
            this.refreshToken = res.data.result.data.refreshToken;
            const config = {
                baseURL: 'https://api.getgrass.io',
                headers: {
                    'Authorization': this.accessToken
                },
                httpsAgent: this.proxy,
                httpAgent: this.proxy
            };
            this.grassApi = axios_1.default.create(config);
        });
    }
    getUser() {
        return __awaiter(this, void 0, void 0, function* () {
            const res = yield this.grassApi.get('/retrieveUser');
            return res.data.result.data;
        });
    }
    getIpInfo() {
        return __awaiter(this, void 0, void 0, function* () {
            const res = yield this.grassApi.get('/activeIps');
            return res.data.result.data;
        });
    }
    checkIn() {
        return __awaiter(this, void 0, void 0, function* () {
            const data = {
                "browserId": "ecf8d67c-d6fd-527a-aa90-56f62d9941d4",
                "userId": "2twokrDE305DJ6WOIhqgyrnF19p",
                "version": "5.1.1",
                "extensionId": "desktop",
                "userAgent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
                "deviceType": "desktop"
            };
            yield axios_1.default.post('https://director.getgrass.io/checkin');
        });
    }
    getDeviceId() {
        return __awaiter(this, void 0, void 0, function* () {
            const res = yield this.grassApi.get('/activeDevices');
            const deviceIds = res.data.result.data
                .filter((device) => device.multiplier === 2) // multiplier === 2 -> desktop app
                .map((device) => device.deviceId);
            if (deviceIds.length === 0)
                return null;
            return deviceIds[0];
        });
    }
}
exports.default = Grass;
