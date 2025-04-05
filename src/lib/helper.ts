import axios from "axios";

export function getRandomNumber(min: number, max: number): number {
  if (min > max) {
    throw new Error("min should be less than or equal to max");
  }
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export const delay = async (ms: number) => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};



function getPlatformFromUserAgent(ua = "") {
  const uaLower = ua.toLowerCase();

  if (uaLower.includes("windows")) {
    return "Windows";
  } else if (uaLower.includes("mac os x") || uaLower.includes("macintosh")) {
    return "macOS";
  } else if (uaLower.includes("android")) {
    return "Android";
  } else if (uaLower.includes("iphone") || uaLower.includes("ipad") || uaLower.includes("ios")) {
    return "iOS";
  } else if (uaLower.includes("linux")) {
    return "Linux";
  }

  // Если не распознали
  return "Windows";
}


export const headersInterceptor = (config) => {
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

    const platform = getPlatformFromUserAgent(config.headers['User-Agent']);

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
            `"Chromium";v="${chromeVersion}", "Not:A-Brand";v="${config.brandVersion}", "Google Chrome";v="${chromeVersion}"`,
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": `"${platform}"`,
      }),
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-site",
      'user-agent': config.headers['User-Agent'],
    };

  }

  delete config.brandVersion;
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


const versions = [99, 8, 110];

export function generateRandom12Hex() {
  let hex = "";
  for (let i = 0; i < 12; i++) {
    hex += Math.floor(Math.random() * 16).toString(16);
  }
  return hex;
}

export const getRandomBrandVersion = () => versions[Math.floor(Math.random() * versions.length)];