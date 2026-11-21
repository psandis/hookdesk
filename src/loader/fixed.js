import { readFileSync } from 'node:fs';

// Fixed values live in JSON, not in code: config/limits.json holds validation bounds,
// config/app.json holds names, routes, status codes, headers, and UI constants,
// config/messages.json holds every text the CLI, API, and dashboard show.
const readJson = name => JSON.parse(readFileSync(new URL(`../../config/${name}`, import.meta.url), 'utf8'));
export const limits = readJson('limits.json');
export const app = readJson('app.json');
export const messages = readJson('messages.json');

export const inRange = (value, { min, max }) => Number.isInteger(value) && value >= min && value <= max;
export const rangeText = ({ min, max }) => `${min}..${max}`;
// IPv6 addresses need brackets inside a URL or Host header.
export const urlHost = host => host.includes(':') ? `[${host}]` : host;
// Fills {name} placeholders in a message or route template.
export const format = (template, values = {}) => template.replace(/\{(\w+)\}/g, (match, key) => key in values ? String(values[key]) : match);
// Error carrying an HTTP status from config/app.json.
export const httpError = (status, message) => Object.assign(new Error(message), { status });
