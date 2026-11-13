import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { startEgressRecorder } from './egress.mjs';
import { buildServerEnv } from './env.mjs';
import { temporaryDirectories } from './test-support';

const temporary = temporaryDirectories();
afterAll(() => temporary.cleanup());

const PLANTED = 'planted-egress-secret';

// Runs in a child Node with exactly the server's environment. Every target is
// an external-looking name under the reserved `.invalid` domain.
const PROBE = `
const http = await import('node:http');
const https = await import('node:https');
const outcome = (promise) => promise.then((status) => status, (error) => 'error ' + (error.cause?.code ?? error.code ?? error.message));
const get = (client, url) => new Promise((resolve, reject) => {
  const request = client.get(url, (response) => { response.resume(); resolve(response.statusCode); });
  request.on('error', reject);
});
const results = {
  fetchHttp: await outcome(fetch('http://registry.example.invalid/pkg', {
    method: 'POST',
    headers: { authorization: 'Bearer ${PLANTED}' },
    body: '${PLANTED}-body',
  }).then((r) => r.status)),
  fetchHttps: await outcome(fetch('https://api.example.invalid/v1/messages').then((r) => r.status)),
  http: await outcome(get(http, 'http://linear.example.invalid:8080/graphql')),
  https: await outcome(get(https, 'https://slack.example.invalid/api')),
};
console.log(JSON.stringify(results));
`;

function runProbe(env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['--input-type=module', '-e', PROBE],
      { env, timeout: 60_000 },
      (error, stdout) => (error ? reject(error) : resolve(stdout))
    );
  });
}

describe('the egress recorder', () => {
  it("refuses and records the server environment's own fetch, http and https requests", async () => {
    const baseDir = temporary.create('ffsb-');
    const logFile = join(baseDir, 'egress-calls.log');
    const recorder = await startEgressRecorder({ logFile });
    try {
      const env = buildServerEnv({
        parentEnv: { PATH: process.env.PATH },
        baseDir,
        scenario: 'echo',
        egressPort: recorder.port,
      });
      const results = z
        .object({
          fetchHttp: z.unknown(),
          fetchHttps: z.unknown(),
          http: z.unknown(),
          https: z.unknown(),
        })
        .parse(JSON.parse(await runProbe(env)));
      // Plain HTTP gets the recorder's 403; HTTPS tunnels are refused at CONNECT.
      expect(results.fetchHttp).toBe(403);
      expect(results.http).toBe(403);
      expect(String(results.fetchHttps)).toMatch(/^error /);
      expect(String(results.https)).toMatch(/^error /);
      const lines = readFileSync(logFile, 'utf8').trim().split('\n');
      expect(lines.map((line) => line.replace(/^\S+ /, '')).sort()).toEqual([
        'CONNECT api.example.invalid:443',
        'CONNECT slack.example.invalid:443',
        'GET linear.example.invalid:8080',
        'POST registry.example.invalid:80',
      ]);
      // Method and target only: no header, path or body is written.
      const log = readFileSync(logFile, 'utf8');
      expect(log).not.toContain(PLANTED);
      expect(log).not.toContain('/pkg');
      expect(log).not.toContain('/graphql');
    } finally {
      await recorder.close();
    }
  }, 90_000);

  it('records a request sent to it directly, as a base URL, by its own address', async () => {
    const logFile = join(temporary.create('ffsb-'), 'egress-calls.log');
    const recorder = await startEgressRecorder({ logFile });
    try {
      const response = await fetch(`http://127.0.0.1:${recorder.port}/v1/messages`, {
        method: 'POST',
        headers: { 'x-api-key': PLANTED },
        body: PLANTED,
      });
      expect(response.status).toBe(403);
      const log = readFileSync(logFile, 'utf8');
      expect(log.trim().replace(/^\S+ /, '')).toBe(`POST 127.0.0.1:${recorder.port}`);
      expect(log).not.toContain(PLANTED);
    } finally {
      await recorder.close();
    }
  });
});
