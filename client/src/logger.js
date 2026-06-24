'use strict';

const path = require('path');
const fs = require('fs');
const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');

const os = require('os');
const CONFIG_DIR = process.platform === 'win32'
  ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'simplecloud')
  : path.join(os.homedir(), '.config', 'simplecloud');
const LOG_DIR = path.join(CONFIG_DIR, 'logs');

fs.mkdirSync(LOG_DIR, { recursive: true });

const LOG_FILE = path.join(LOG_DIR, 'sync.log');

const timestampFormat = winston.format.printf(({ level, message, timestamp }) => {
  return `[${timestamp}] [${level.toUpperCase()}] ${message}`;
});

const logger = winston.createLogger({
  transports: [
    new winston.transports.Console({
      level: 'debug',
      format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        timestampFormat
      ),
    }),
    new DailyRotateFile({
      level: 'info',
      filename: path.join(LOG_DIR, 'sync-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxSize: '5m',
      maxFiles: '3',
      format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        timestampFormat
      ),
    }),
  ],
});

module.exports = logger;
module.exports.LOG_FILE = LOG_FILE;
module.exports.LOG_DIR = LOG_DIR;
