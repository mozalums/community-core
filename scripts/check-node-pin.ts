// Three files name the Node major and no format lets them share one token:
// package.json `engines.node` (pnpm enforces it), `.nvmrc` (the version manager
// reads it), and the Dockerfile's base image. Drift means the gate validates
// against a runtime that is never shipped, so this asserts they agree and fails
// `pnpm check` when they do not. package.json is the source of truth.
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');

const pkg = JSON.parse(read('package.json')) as { engines?: { node?: string } };
const engines = pkg.engines?.node ?? '';
const expected = engines.match(/^(\d+)\.x$/)?.[1];
if (!expected) {
	console.error(`[check-node-pin] package.json engines.node is "${engines}", expected "<major>.x"`);
	process.exit(1);
}

const problems: string[] = [];

const nvmrc = read('.nvmrc').trim();
if (nvmrc !== expected) {
	problems.push(`.nvmrc says "${nvmrc}", engines.node says "${expected}"`);
}

const dockerfile = read('Dockerfile');
const arg = dockerfile.match(/^ARG NODE_VERSION=(\d+)$/m)?.[1];
if (arg !== expected) {
	problems.push(
		`Dockerfile ARG NODE_VERSION is "${arg ?? 'absent'}", engines.node says "${expected}"`
	);
}

// A literal `FROM node:22-slim` would agree today and drift silently tomorrow.
const literal = dockerfile.match(/^FROM node:(?!\$\{NODE_VERSION\})\S+/m)?.[0];
if (literal) {
	problems.push(`Dockerfile pins a base image literally: "${literal}" — use \${NODE_VERSION}`);
}

if (problems.length) {
	console.error(`[check-node-pin] Node version pins disagree:\n  ${problems.join('\n  ')}`);
	process.exit(1);
}

console.log(`node pin: ${expected} (package.json, .nvmrc, Dockerfile)`);
