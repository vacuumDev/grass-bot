import winston from "winston";
import fs from "fs";
import config from "./config.js";

// Determine the log level based on the debug flag in the config file.
const logLevel = config.debug ? "debug" : "info";

// Create a Winston logger with the configured level and transports.
const logger = winston.createLogger({
  level: logLevel,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(
      (info) => `${info.timestamp} [${info.level}]: ${info.message}`,
    ),
  ),
  transports: [new winston.transports.Console()],
});

export { logger };
