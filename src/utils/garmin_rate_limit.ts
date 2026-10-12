const RATE_LIMIT_RETRY_COUNT = 3;
const RATE_LIMIT_BASE_DELAY_MS = 30_000;
const NETWORK_BASE_DELAY_MS = 2_000;

const getHttpStatus = (error: unknown): number | undefined => {
    if (typeof error === 'object' && error !== null) {
        const status = (error as { response?: { status?: number } }).response?.status;
        if (status) return status;
    }
    const message = error instanceof Error ? error.message : String(error);
    const match = message.match(/ERROR:\s*\((\d{3})\)/i);
    return match ? Number(match[1]) : undefined;
};

export const isGarminAuthenticationError = (error: unknown): boolean => {
    const status = getHttpStatus(error);
    return status === 401 || status === 403;
};

const isTransientError = (error: unknown): boolean => {
    const status = getHttpStatus(error);
    if (status === 408 || status === 500 || status === 502 || status === 503 || status === 504) return true;
    const code = typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined;
    return !!code && ['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED', 'EPIPE', 'ERR_NETWORK'].includes(code);
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const isGarminRateLimitError = (error: unknown): boolean => {
    const message = error instanceof Error ? error.message : String(error);
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
            console.warn(`${label}: Garmin ${reason}, retrying in ${Math.ceil(delay / 1000)}s (${attempt + 1}/${RATE_LIMIT_RETRY_COUNT})...`);
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
