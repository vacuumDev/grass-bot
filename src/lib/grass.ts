import {HttpsProxyAgent} from "https-proxy-agent";
import axios, {AxiosInstance, AxiosRequestConfig, AxiosResponse} from "axios";
import ApiResponseDto from "../dto/api-response.dto";
import LoginResponseData from "../dto/login-response.dto";
import UserResponseData from "../dto/user-response.dto";
import { IpResponseData } from "../dto/ip-info.dto";
import ActiveDeviceResponseDto from "../dto/active-device-response.dto";

export default class Grass {
    private accessToken!: string;
    private refreshToken!: string;
    private readonly proxy!: HttpsProxyAgent<string>;
    private grassApi!: AxiosInstance;

    constructor(proxyUrl: string) {
        this.proxy = new HttpsProxyAgent(proxyUrl);
    }

    async login(email: string, password: string): Promise<void> {
        const res: AxiosResponse<ApiResponseDto<LoginResponseData>> = await axios.post('https://api.getgrass.io/login', {
            username: email,
            password,
            v: "5.1.1"
        });

        this.accessToken = res.data.result.data.accessToken;
        this.refreshToken = res.data.result.data.refreshToken;

        const config: AxiosRequestConfig = {
            baseURL: 'https://api.getgrass.io',
            headers: {
                'Authorization': this.accessToken
            },
            httpsAgent: this.proxy,
            httpAgent: this.proxy
        };

        this.grassApi = axios.create(config);
    }

    async getUser(): Promise<UserResponseData> {
        const res: AxiosResponse<ApiResponseDto<UserResponseData>> = await this.grassApi.get('/retrieveUser');

        return res.data.result.data;
    }

    async getIpInfo(): Promise<IpResponseData> {
        const res: AxiosResponse<ApiResponseDto<IpResponseData>> = await this.grassApi.get('/activeIps');

        return res.data.result.data;
    }

    async checkIn(userId: string, browserId: string, userAgent: string) {
        const data = {
            browserId,
            userId,
            "version": "5.1.1",
            "extensionId": "desktop",
            userAgent,
            "deviceType": "desktop"
        };
        return axios.post('https://director.getgrass.io/checkin', data)
    }

    async getDeviceId(): Promise<string | null> {
        const res: AxiosResponse<ApiResponseDto<ActiveDeviceResponseDto[]>> = await this.grassApi.get('/activeDevices');

        const deviceIds = res.data.result.data
            .filter((device: ActiveDeviceResponseDto) => device.multiplier === 2) // multiplier === 2 -> desktop app
            .map((device: ActiveDeviceResponseDto) => device.deviceId);

        if(deviceIds.length === 0)
            return null;

        return deviceIds[0] as string;
    }
}