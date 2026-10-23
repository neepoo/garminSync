const dns = require('dns');
const net = require('net');

const RATE_LIMIT_RETRY_COUNT = 3;
const RATE_LIMIT_BASE_DELAY_MS = 30_000;
const NETWORK_BASE_DELAY_MS = 2_000;
const MIN_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 10_000;

const TRANSIENT_HTTP_STATUSES = new Set([408, 500, 502, 503, 504, 520, 521, 522, 523, 524]);
const TRANSIENT_ERROR_CODES = new Set([
    'ECONNRESET',
    'ECONNABORTED',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'ENOTFOUND',
    'ECONNREFUSED',
    'EPIPE',
    'ERR_NETWORK',
    'ENETUNREACH',
    'EHOSTUNREACH',
    'EADDRNOTAVAIL',
    'ERR_SOCKET_CONNECTION_TIMEOUT',
]);

// Garmin CN resolves to both IPv4 and IPv6 records, while US GitHub Actions runners
// lack IPv6 routing and have ~250-320ms trans-Pacific RTT to China. Node 20/22's
// default 250ms Happy Eyeballs attempt timeout aborts the IPv4 TCP handshake before
// SYN-ACK arrives and then fails on IPv6 with an empty-message AggregateError.
export const configureGarminNetworkDefaults = () => {
    if (typeof dns.setDefaultResultOrder === 'function') {
        dns.setDefaultResultOrder('ipv4first');
    }
    if (
        typeof net.getDefaultAutoSelectFamilyAttemptTimeout === 'function' &&
        typeof net.setDefaultAutoSelectFamilyAttemptTimeout === 'function' &&
        net.getDefaultAutoSelectFamilyAttemptTimeout() < MIN_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS
    ) {
        net.setDefaultAutoSelectFamilyAttemptTimeout(MIN_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS);
    }
};

configureGarminNetworkDefaults();

export const formatGarminError = (error: unknown): string => {
    if (error instanceof Error) {
        const directMessage = error.message?.trim();
        if (directMessage) {
            return directMessage;
        }

        const rawErrors = (error as { errors?: unknown[] }).errors;
        const nested = Array.isArray(rawErrors) ? rawErrors : [];
        if (nested.length > 0) {
            const details = Array.from(new Set(nested.map(item => formatGarminError(item)).filter(Boolean)));
            if (details.length > 0) {
                const code = (error as { code?: string }).code;
                const summary = details.join('; ');
                return code && !summary.includes(code) ? `${code}: ${summary}` : summary;
            }
        }

        const code = (error as { code?: string }).code;
        if (code) {
            return `${error.name || 'Error'}: ${code}`;
        }

        return error.name || 'Unknown Garmin error';
    }

    if (typeof error === 'string') {
        return error.trim() || 'Unknown Garmin error';
    }

    const text = String(error ?? '').trim();
    return text || 'Unknown Garmin error';
};

const getHttpStatus = (error: unknown): number | undefined => {
    if (typeof error === 'object' && error !== null) {
        const status = (error as { response?: { status?: number } }).response?.status;
        if (status) return status;
    }
    const message = formatGarminError(error);
    const match = message.match(/ERROR:\s*\((\d{3})\)/i);
    return match ? Number(match[1]) : undefined;
};

export const isGarminAuthenticationError = (error: unknown): boolean => {
    const status = getHttpStatus(error);
    return status === 401 || status === 403;
};

const isTransientError = (error: unknown): boolean => {
    const status = getHttpStatus(error);
    if (status && TRANSIENT_HTTP_STATUSES.has(status)) return true;
    const code = typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined;
    if (code && TRANSIENT_ERROR_CODES.has(code)) return true;
    const rawErrors = typeof error === 'object' && error !== null ? (error as { errors?: unknown[] }).errors : undefined;
    const nested = Array.isArray(rawErrors) ? rawErrors : [];
    if (nested.length > 0 && nested.some(item => isTransientError(item))) return true;
    return /socket hang up|secure TLS connection|network socket disconnected/i.test(formatGarminError(error));
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const isGarminRateLimitError = (error: unknown): boolean => {
    const message = formatGarminError(error);
    return getHttpStatus(error) === 429 || /\(429\)|too many requests|rate limited/i.test(message);
};

const withGarminRetry = async <T>(
    label: string,
    action: () => Promise<T>,
    retryTransientErrors: boolean,
): Promise<T> => {
    for (let attempt = 0; attempt <= RATE_LIMIT_RETRY_COUNT; attempt++) {
        try {
            return await action();
        } catch (error) {
            const rateLimited = isGarminRateLimitError(error);
            if ((!rateLimited && !(retryTransientErrors && isTransientError(error))) || attempt === RATE_LIMIT_RETRY_COUNT) {
                throw error;
            }

            const delay = rateLimited ? RATE_LIMIT_BASE_DELAY_MS * (attempt + 1) : NETWORK_BASE_DELAY_MS * 2 ** attempt;
            const reason = rateLimited ? 'API rate limited' : 'temporary request failure';
            console.warn(`${label}: Garmin ${reason} (${formatGarminError(error)}), retrying in ${Math.ceil(delay / 1000)}s (${attempt + 1}/${RATE_LIMIT_RETRY_COUNT})...`);
            await sleep(delay);
        }
    }

    throw new Error(`${label}: unexpected retry state`);
};

// Uploads keep rate-limit-only retries: a lost response may already have created an activity.
export const withGarminRateLimitRetry = <T>(label: string, action: () => Promise<T>): Promise<T> =>
    withGarminRetry(label, action, false);

export const withGarminReadRetry = <T>(label: string, action: () => Promise<T>): Promise<T> =>
    withGarminRetry(label, action, true);
