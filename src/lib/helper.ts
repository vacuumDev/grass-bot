export function getRandomNumber(min: number, max: number): number {
  if (min > max) {
    throw new Error("min should be less than or equal to max");
  }
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export const delay = async (ms: number) => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};
export const headersInterceptor = (config: any) => {
  if (
      config.baseURL &&
      (config.baseURL.includes("app.getgrass.io") ||
          config.baseURL.includes("api.getgrass.io") ||
          config.baseURL.includes("director.getgrass.io"))
  ) {
    const isChrome =
        typeof config.headers['User-Agent'] === "string" && config.headers['User-Agent'].includes("Chrome/");

    const match = isChrome && config.headers['User-Agent'].match(/Chrome\/(\d+)/);
    let chromeVersion = 0;
    if (match) {
      chromeVersion = match[1];
    }
    config.headers = {
      accept: "application/json, text/plain, */*",
      "accept-encoding": "gzip, deflate, br, zstd",
      "accept-language": "en-US;q=0.8,en;q=0.7",
      'authorization': config.headers['Authorization'],
      origin: "https://app.getgrass.io",
      priority: "u=1, i",
      referer: "https://app.getgrass.io/",
      ...(isChrome && {
        "sec-ch-ua":
            `"Chromium";v="${chromeVersion}", "Not:A-Brand";v="24", "Google Chrome";v="${chromeVersion}"`,
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
      }),
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-site",
      'user-agent': config.headers['User-Agent'],
    };

  }
  return config;
};
export function shuffle(array: any[]) {
  let currentIndex = array.length;

  while (currentIndex != 0) {
    let randomIndex = Math.floor(Math.random() * currentIndex);
    currentIndex--;

    [array[currentIndex], array[randomIndex]] = [
      array[randomIndex],
      array[currentIndex],
    ];
  }
}
