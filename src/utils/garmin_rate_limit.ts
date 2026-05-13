const RATE_LIMIT_RETRY_COUNT = 3;
const RATE_LIMIT_BASE_DELAY_MS = 30_000;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const isGarminRateLimitError = (error: unknown): boolean => {
    const message = error instanceof Error ? error.message : String(error);
    return /\(429\)|too many requests|rate limited/i.test(message);
};

export const withGarminRateLimitRetry = async <T>(
    label: string,
    action: () => Promise<T>,
): Promise<T> => {
    for (let attempt = 0; attempt <= RATE_LIMIT_RETRY_COUNT; attempt++) {
        try {
            return await action();
        } catch (error) {
            if (!isGarminRateLimitError(error) || attempt === RATE_LIMIT_RETRY_COUNT) {
                throw error;
            }

            const delay = RATE_LIMIT_BASE_DELAY_MS * (attempt + 1);
            console.warn(`${label}: Garmin API rate limited, retrying in ${Math.ceil(delay / 1000)}s...`);
            await sleep(delay);
        }
    }

    throw new Error(`${label}: unexpected retry state`);
};
