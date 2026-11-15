/** Express app và HTTP server. Tách riêng để WebSocket (hub.js) và các route dùng chung một server. */
import http from 'node:http';
import express from 'express';

export const app = express();
export const server = http.createServer(app);
