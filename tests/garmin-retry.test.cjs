const assert = require('node:assert/strict');
const { test } = require('node:test');
const retry = require('../src/utils/garmin_rate_limit');

async function withoutWaiting(run) {
    const original = global.setTimeout;
    const delays = [];
    global.setTimeout = (callback, delay) => { delays.push(delay); queueMicrotask(callback); return 0; };
    try { await run(delays); } finally { global.setTimeout = original; }
}

test('read retries recover from HTTP 503', async () => {
    await withoutWaiting(async delays => {
        let attempts = 0;
        const value = await retry.withGarminReadRetry('profile', async () => {
            if (++attempts === 1) throw new Error('ERROR: (503), Service Unavailable');
            return 'profile';
        });
        assert.equal(value, 'profile');
        assert.equal(attempts, 2);
        assert.deepEqual(delays, [2000]);
    });
});

test('read retries stop after three retries and preserve the last error', async () => {
    await withoutWaiting(async delays => {
        const error = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
        let attempts = 0;
        await assert.rejects(retry.withGarminReadRetry('profile', async () => { attempts++; throw error; }), e => e === error);
        assert.equal(attempts, 4);
        assert.deepEqual(delays, [2000, 4000, 8000]);
    });
});

test('upload rate-limit retries do not repeat an ambiguous network failure', async () => {
    await withoutWaiting(async delays => {
        const error = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
        let attempts = 0;
        await assert.rejects(retry.withGarminRateLimitRetry('upload', async () => { attempts++; throw error; }), e => e === error);
        assert.equal(attempts, 1);
        assert.deepEqual(delays, []);
    });
});

test('HTTP 429 still uses the existing longer backoff', async () => {
    await withoutWaiting(async delays => {
        let attempts = 0;
        assert.equal(await retry.withGarminRateLimitRetry('upload', async () => {
            if (++attempts < 4) throw new Error('ERROR: (429), Too Many Requests');
            return 'uploaded';
        }), 'uploaded');
        assert.deepEqual(delays, [30000, 60000, 90000]);
    });
});

test('read retries fail immediately for auth, privacy, and programming errors', async () => {
    await withoutWaiting(async delays => {
        for (const error of [new Error('ERROR: (401), Unauthorized'), new Error('ERROR: (412), Privacy Consent'), new TypeError('bug')]) {
            let attempts = 0;
            await assert.rejects(retry.withGarminReadRetry('profile', async () => { attempts++; throw error; }), e => e === error);
            assert.equal(attempts, 1);
        }
        assert.deepEqual(delays, []);
    });
});
