import { redactRecord } from './redact';

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const minLevel = LEVELS[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? LEVELS.info;

function flatten(ctx?: Record<string, unknown>): Record<string, unknown> {
	return ctx ? redactRecord(ctx) : {};
}

function emit(level: Level, msg: string, ctx?: Record<string, unknown>): void {
	if (LEVELS[level] < minLevel) return;
	const entry = { ts: new Date().toISOString(), level, msg, ...flatten(ctx) };
	const line = JSON.stringify(entry);
	if (level === 'error' || level === 'warn') console.error(line);
	else console.log(line);
}

export const log = {
	debug: (msg: string, ctx?: Record<string, unknown>) => emit('debug', msg, ctx),
	info: (msg: string, ctx?: Record<string, unknown>) => emit('info', msg, ctx),
	warn: (msg: string, ctx?: Record<string, unknown>) => emit('warn', msg, ctx),
	error: (msg: string, ctx?: Record<string, unknown>) => emit('error', msg, ctx)
};

export default log;
