import { BARK_KEY_DEFAULT } from './constant';
import { migrateGarminGlobal2GarminCN } from './utils/garmin_global';

const axios = require('axios');
const core = require('@actions/core');
const BARK_KEY = process.env.BARK_KEY ?? BARK_KEY_DEFAULT;

const main = async () => {
    try {
        await migrateGarminGlobal2GarminCN();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (BARK_KEY) {
            await axios.get(
                `https://api.day.app/${BARK_KEY}/Garmin Global -> Garmin CN 同步数据运行失败了，快去检查！/${message}`
            );
        }
        core.setFailed(message);
        throw (error instanceof Error ? error : new Error(message));
    }
};

main();




