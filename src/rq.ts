import { BARK_KEY_DEFAULT } from './constant';
import { doRQGoogleSheets } from './utils/runningquotient';

const axios = require('axios');
const core = require('@actions/core');

const BARK_KEY = process.env.BARK_KEY ?? BARK_KEY_DEFAULT;


const main = async () => {
    try {
        await doRQGoogleSheets();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (BARK_KEY) {
            await axios.get(
                `https://api.day.app/${BARK_KEY}/同步数据运行失败了，快去检查！/${message}`
            );
        }
        core.setFailed(message);
        throw (error instanceof Error ? error : new Error(message));
    }
};

main();




