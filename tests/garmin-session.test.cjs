const assert = require('node:assert/strict');
const { test } = require('node:test');
const { GarminConnect } = require('@gooin/garmin-connect');
const core = require('@actions/core');
const db = require('../src/utils/sqlite');
const { getGaminCNClient } = require('../src/utils/garmin_cn');
const { getGaminGlobalClient } = require('../src/utils/garmin_global');

const savedSession = { oauth1: { oauth_token: 'test' }, oauth2: { access_token: 'saved' } };
const profile = { fullName: 'Test', userName: 'test@example.invalid' };

async function withSessionFixture(run) {
    const originals = {
        initDB: db.initDB, getTokenSessionFromDB: db.getTokenSessionFromDB,
        upsertSessionToDB: db.upsertSessionToDB, setFailed: core.setFailed,
        login: GarminConnect.prototype.login, getUserProfile: GarminConnect.prototype.getUserProfile,
        setTimeout: global.setTimeout,
        consoleError: console.error,
    };
    let logins = 0;
    let persisted = 0;
    const errors = [];
    db.initDB = async () => {};
    db.getTokenSessionFromDB = async () => savedSession;
    db.upsertSessionToDB = async () => { persisted++; };
    core.setFailed = () => {};
    console.error = (...args) => { errors.push(args); };
    GarminConnect.prototype.login = async () => { logins++; throw new Error('Unexpected password login'); };
    global.setTimeout = callback => { queueMicrotask(callback); return 0; };
    try {
        await run({ logins: () => logins, persisted: () => persisted, errors: () => errors });
    } finally {
        Object.assign(db, {
            initDB: originals.initDB, getTokenSessionFromDB: originals.getTokenSessionFromDB,
            upsertSessionToDB: originals.upsertSessionToDB,
        });
        core.setFailed = originals.setFailed;
        GarminConnect.prototype.login = originals.login;
        GarminConnect.prototype.getUserProfile = originals.getUserProfile;
        global.setTimeout = originals.setTimeout;
        console.error = originals.consoleError;
    }
}

for (const [region, factory] of [['CN', getGaminCNClient], ['GLOBAL', getGaminGlobalClient]]) {
    test(`${region} reuses the saved session after a temporary network failure`, async () => {
        await withSessionFixture(async state => {
            let attempts = 0;
            GarminConnect.prototype.getUserProfile = async () => {
                if (++attempts === 1) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
                return profile;
            };
            assert.ok(await factory());
            assert.equal(attempts, 2);
            assert.equal(state.logins(), 0);
            assert.equal(state.persisted(), 1);
        });
    });

    test(`${region} reports exhausted network retries without password fallback`, async () => {
        await withSessionFixture(async state => {
            const failure = Object.assign(new Error('DNS temporarily unavailable'), {
                code: 'EAI_AGAIN', config: { headers: { Authorization: 'Bearer test-private-token' } },
            });
            let attempts = 0;
            GarminConnect.prototype.getUserProfile = async () => { attempts++; throw failure; };
            await assert.rejects(factory(), error => error === failure);
            assert.equal(attempts, 4);
            assert.equal(state.logins(), 0);
            assert.equal(state.persisted(), 0);
            assert.ok(!JSON.stringify(state.errors()).includes('test-private-token'));
        });
    });

    test(`${region} logs non-empty detail when an AggregateError has an empty message`, async () => {
        await withSessionFixture(async state => {
            const failure = Object.assign(
                new AggregateError([
                    Object.assign(new Error('connect ETIMEDOUT 42.202.211.202:443'), { code: 'ETIMEDOUT' }),
                    Object.assign(new Error('connect ENETUNREACH 240e::1:443'), { code: 'ENETUNREACH' }),
                ]),
                { code: 'ETIMEDOUT', config: { headers: { Authorization: 'Bearer test-private-token' } } },
            );
            GarminConnect.prototype.getUserProfile = async () => { throw failure; };
            await assert.rejects(factory(), error => error === failure);
            const logged = JSON.stringify(state.errors());
            assert.match(logged, /connect ETIMEDOUT 42\.202\.211\.202:443/);
            assert.ok(!logged.includes('test-private-token'));
        });
    });

    test(`${region} falls back to the token secret on an authentication failure`, async () => {
        const secretName = region === 'CN' ? 'GARMIN_TOKEN_B64' : 'GARMIN_GLOBAL_TOKEN_B64';
        const previous = process.env[secretName];
        process.env[secretName] = Buffer.from(JSON.stringify({
            oauth1: { oauth_token: 'test' }, oauth2: { access_token: 'secret' },
        })).toString('base64');
        try {
            await withSessionFixture(async state => {
                GarminConnect.prototype.getUserProfile = async function () {
                    if (this.client.oauth2Token.access_token === 'saved') throw new Error('ERROR: (401), Unauthorized');
                    return profile;
                };
                assert.ok(await factory());
                assert.equal(state.logins(), 0);
                assert.equal(state.persisted(), 1);
            });
        } finally {
            if (previous === undefined) delete process.env[secretName];
            else process.env[secretName] = previous;
        }
    });
}
