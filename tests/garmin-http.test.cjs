const assert = require('node:assert/strict');
const { test } = require('node:test');
const { GarminConnect } = require('@gooin/garmin-connect');

test('Garmin transport preserves a network error without an HTTP response', async () => {
    const client = new GarminConnect({ username: 'test', password: 'test' });
    const failure = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    client.client.client.defaults.adapter = async config => {
        failure.config = config;
        throw failure;
    };
    await assert.rejects(client.client.get('https://example.invalid/profile'), error => error === failure);
});

test('a failed OAuth refresh does not block the next refresh', { timeout: 2000 }, async () => {
    const client = new GarminConnect({ username: 'test', password: 'test' });
    const http = client.client;
    http.oauth2Token = { access_token: 'old' };
    let refreshes = 0;
    const failure = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    http.refreshOauth2Token = async () => {
        if (++refreshes === 1) {
            http.oauth2Token = undefined;
            throw failure;
        }
        http.oauth2Token = { access_token: 'new' };
    };
    http.client.defaults.adapter = async config => {
        if (config.headers.Authorization !== 'Bearer new') {
            throw Object.assign(new Error('Unauthorized'), { config, response: { status: 401 } });
        }
        return { data: { userName: 'test' }, status: 200, headers: {}, config };
    };
    await assert.rejects(http.get('https://example.invalid/profile'), error => error === failure);
    assert.deepEqual(await http.get('https://example.invalid/profile'), { userName: 'test' });
    assert.equal(refreshes, 2);
});

test('a 401 without a reusable token rejects instead of returning an empty profile', async () => {
    const client = new GarminConnect({ username: 'test', password: 'test' });
    client.client.client.defaults.adapter = async config => {
        throw Object.assign(new Error('Unauthorized'), {
            config, isAxiosError: true, response: { status: 401, statusText: 'Unauthorized', data: {} },
        });
    };
    await assert.rejects(client.getUserProfile(), /\(401\)/);
});

test('concurrent requests share a failed refresh and both reject', { timeout: 2000 }, async () => {
    const client = new GarminConnect({ username: 'test', password: 'test' });
    const http = client.client;
    http.oauth2Token = { access_token: 'old' };
    const failure = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    let release;
    let refreshes = 0;
    const barrier = new Promise(resolve => { release = resolve; });
    http.refreshOauth2Token = async () => {
        refreshes++;
        http.oauth2Token = undefined;
        await barrier;
        throw failure;
    };
    let requests = 0;
    http.client.defaults.adapter = async config => {
        if (++requests === 2) setImmediate(release);
        throw Object.assign(new Error('Unauthorized'), { config, response: { status: 401 } });
    };
    const results = await Promise.allSettled([
        http.get('https://example.invalid/profile'), http.get('https://example.invalid/profile'),
    ]);
    assert.equal(refreshes, 1);
    for (const result of results) {
        assert.equal(result.status, 'rejected');
        assert.equal(result.reason, failure);
    }
});
