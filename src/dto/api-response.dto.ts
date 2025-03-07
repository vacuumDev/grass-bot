export default class ApiResponseDto<T> {
    result!: {
        data: T
    }
}