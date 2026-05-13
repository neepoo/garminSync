import qs from 'qs';

const axios = require('axios');
const OAuth = require('oauth-1.0a');
const crypto = require('crypto');
const { chromium } = require('playwright');

const OAUTH_CONSUMER_URL = 'https://thegarth.s3.amazonaws.com/oauth_consumer.json';
const SOCIAL_PROFILE_URL = 'https://connectapi.garmin.com/userprofile-service/socialProfile';
const ANDROID_UA = 'com.garmin.android.apps.connectmobile';
const IOS_UA = 'GCM-iOS-5.7.2.1';
const MAX_WAIT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 500;
const TICKET_PATTERN = /ticket=(ST-[A-Za-z0-9-]+)/;

interface OAuthConsumer {
    consumer_key: string;
    consumer_secret: string;
}

interface GarminTokenBundle {
    oauth1: Record<string, any>;
    oauth2: Record<string, any>;
}

const getOauthClient = (consumer: OAuthConsumer) => OAuth({
    consumer: {
        key: consumer.consumer_key,
        secret: consumer.consumer_secret,
    },
    signature_method: 'HMAC-SHA1',
    hash_function(baseString: string, key: string) {
        return crypto.createHmac('sha1', key).update(baseString).digest('base64');
    },
});

const getSsoUrl = () => [
    'https://sso.garmin.com/sso/embed',
    '?id=gauth-widget',
    '&embedWidget=true',
    '&gauthHost=https://sso.garmin.com/sso',
    '&clientId=GarminConnect',
    '&locale=en_US',
    '&redirectAfterAccountLoginUrl=https://sso.garmin.com/sso/embed',
    '&service=https://sso.garmin.com/sso/embed',
].join('');

const extractTicket = (value: string) => value.match(TICKET_PATTERN)?.[1];

const readPageContentSafely = async (page: any): Promise<string | undefined> => {
    try {
        return await page.content();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/page is navigating/i.test(message)) {
            return undefined;
        }

        throw error;
    }
};

const getOauthConsumer = async (): Promise<OAuthConsumer> => {
    const response = await axios.get(OAUTH_CONSUMER_URL, { timeout: 15000 });
    return response.data;
};

const browserLogin = async (): Promise<string> => {
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
        await page.goto(getSsoUrl(), { waitUntil: 'load' });
        console.log('已打开 Garmin 登录窗口，请在浏览器中完成 Garmin Global 登录。');

        const startedAt = Date.now();
        while (Date.now() - startedAt < MAX_WAIT_MS) {
            const ticketFromUrl = extractTicket(page.url());
            if (ticketFromUrl) {
                return ticketFromUrl;
            }

            const content = await readPageContentSafely(page);
            if (content) {
                const ticketFromPage = extractTicket(content);
                if (ticketFromPage) {
                    return ticketFromPage;
                }
            }

            await page.waitForTimeout(POLL_INTERVAL_MS);
        }
    } finally {
        await browser.close();
    }

    throw new Error('等待 Garmin 浏览器登录超时，请重新运行脚本后在 5 分钟内完成登录。');
};

const getOauth1Token = async (ticket: string, consumer: OAuthConsumer) => {
    const url =
        `https://connectapi.garmin.com/oauth-service/oauth/preauthorized?ticket=${ticket}` +
        '&login-url=https://sso.garmin.com/sso/embed&accepts-mfa-tokens=true';
    const oauth = getOauthClient(consumer);
    const authHeader = oauth.toHeader(oauth.authorize({ url, method: 'GET' }));
    const response = await axios.get(url, {
        headers: {
            ...authHeader,
            'User-Agent': ANDROID_UA,
        },
        timeout: 15000,
        responseType: 'text',
    });
    const parsed = qs.parse(response.data);
    return {
        ...parsed,
        domain: 'garmin.com',
    };
};

const getOauth2Token = async (oauth1: Record<string, any>, consumer: OAuthConsumer) => {
    const url = 'https://connectapi.garmin.com/oauth-service/oauth/exchange/user/2.0';
    const payload = oauth1.mfa_token ? { mfa_token: oauth1.mfa_token } : {};
    const oauth = getOauthClient(consumer);
    const authHeader = oauth.toHeader(oauth.authorize(
        { url, method: 'POST', data: payload },
        {
            key: oauth1.oauth_token,
            secret: oauth1.oauth_token_secret,
        },
    ));
    const response = await axios.post(url, qs.stringify(payload), {
        headers: {
            ...authHeader,
            'User-Agent': ANDROID_UA,
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 15000,
    });
    return response.data;
};

const verifyToken = async (oauth2: Record<string, any>) => {
    const response = await axios.get(SOCIAL_PROFILE_URL, {
        headers: {
            'User-Agent': IOS_UA,
            Authorization: `Bearer ${oauth2.access_token}`,
        },
        timeout: 15000,
    });
    return response.data;
};

const main = async () => {
    console.log('Garmin Global token 引导开始');
    console.log('1. 拉起真实浏览器登录 Garmin');
    console.log('2. 交换出 oauth1/oauth2 token');
    console.log('3. 输出 GARMIN_GLOBAL_TOKEN_B64，保存到 GitHub Secret');
    console.log('');

    const consumer = await getOauthConsumer();
    const ticket = await browserLogin();
    const oauth1 = await getOauth1Token(ticket, consumer);
    const oauth2 = await getOauth2Token(oauth1, consumer);
    const profile = await verifyToken(oauth2);
    const bundle: GarminTokenBundle = { oauth1, oauth2 };
    const encoded = Buffer.from(JSON.stringify(bundle), 'utf8').toString('base64');

    console.log(`验证成功，当前账号：${profile?.displayName ?? profile?.fullName ?? profile?.userName ?? 'unknown'}`);
    console.log('');
    console.log('请把下面整段内容保存到 GitHub Secret: GARMIN_GLOBAL_TOKEN_B64');
    console.log(encoded);
};

main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
});
