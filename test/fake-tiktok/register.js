import { register } from 'node:module';

/** Dùng: node --import ./test/fake-tiktok/register.js server.js */
register('./hooks.js', import.meta.url);
