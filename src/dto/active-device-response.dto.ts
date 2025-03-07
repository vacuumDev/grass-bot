export default class ActiveDeviceResponseDto {
    deviceId!: string;
    ipAddress!: string;
    lastConnectedAt!: string;
    ipScore!: number;
    multiplier!: number;
    aggUptime!: number;
}