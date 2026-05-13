import {
    AESKEY_DEFAULT,
    DB_FILE_PATH,
    GARMIN_GLOBAL_USERNAME_DEFAULT,
    GARMIN_USERNAME_DEFAULT
} from '../constant';
import sqlite3 from 'sqlite3';
import { Database, open } from 'sqlite';

const CryptoJS = require('crypto-js');

const GARMIN_USERNAME = process.env.GARMIN_USERNAME ?? GARMIN_USERNAME_DEFAULT;
const GARMIN_GLOBAL_USERNAME = process.env.GARMIN_GLOBAL_USERNAME ?? GARMIN_GLOBAL_USERNAME_DEFAULT;
const AESKEY = process.env.AESKEY ?? AESKEY_DEFAULT;
export type GarminRegion = 'CN' | 'GLOBAL';
export interface GarminTokenSession {
    oauth1: Record<string, any>;
    oauth2: Record<string, any>;
}
const TOKEN_SECRET_BY_REGION: Record<GarminRegion, string> = {
    CN: 'GARMIN_TOKEN_B64',
    GLOBAL: 'GARMIN_GLOBAL_TOKEN_B64',
};

const isRecord = (value: unknown): value is Record<string, any> =>
    typeof value === 'object' && value !== null;

const getSessionUser = (type: GarminRegion) =>
    type === 'GLOBAL' ? GARMIN_GLOBAL_USERNAME : GARMIN_USERNAME;

export const normalizeTokenSession = (session: unknown): GarminTokenSession | undefined => {
    if (!isRecord(session)) {
        return undefined;
    }

    if (isRecord(session.oauth1) && isRecord(session.oauth2)) {
        return {
            oauth1: session.oauth1,
            oauth2: session.oauth2,
        };
    }

    if (isRecord(session.oauth1Token) && isRecord(session.oauth2Token)) {
        return {
            oauth1: session.oauth1Token,
            oauth2: session.oauth2Token,
        };
    }

    if (!isRecord(session.client)) {
        return undefined;
    }

    if (isRecord(session.client.oauth1Token) && isRecord(session.client.oauth2Token)) {
        return {
            oauth1: session.client.oauth1Token,
            oauth2: session.client.oauth2Token,
        };
    }

    if (isRecord(session.client.oauth1) && isRecord(session.client.oauth2)) {
        return {
            oauth1: session.client.oauth1,
            oauth2: session.client.oauth2,
        };
    }

    return undefined;
};

export const getTokenSecretName = (type: GarminRegion) => TOKEN_SECRET_BY_REGION[type];

const parseTokenSession = (raw: string, type: GarminRegion): GarminTokenSession => {
    const normalizedRaw = raw.trim();
    const decoded = normalizedRaw.startsWith('{')
        ? normalizedRaw
        : Buffer.from(normalizedRaw, 'base64').toString('utf8');
    const parsed = JSON.parse(decoded);
    const tokenSession = normalizeTokenSession(parsed);

    if (!tokenSession) {
        throw new Error(`环境变量 ${getTokenSecretName(type)} 不是合法的 Garmin token bundle`);
    }

    return tokenSession;
};

export const initDB = async () => {
    const db = await getDB();
    await db.exec(`CREATE TABLE IF NOT EXISTS garmin_session (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user VARCHAR(20),
            region VARCHAR(20),
            session  TEXT
        )`);
};

export const getDB = async () => {
    return await open({
        filename: DB_FILE_PATH,
        driver: sqlite3.Database,
    });
};

export const saveSessionToDB = async (type: GarminRegion, session: Record<string, any>) => {
    const db = await getDB();
    const encryptedSessionStr = encryptSession(session);
    await db.run(
        `INSERT INTO garmin_session (user,region,session) VALUES (?,?,?)`,
        getSessionUser(type), type, encryptedSessionStr,
    );
};

export const updateSessionToDB = async (type: GarminRegion, session: Record<string, any>) => {
    const db = await getDB();
    const encryptedSessionStr = encryptSession(session);
    await db.run(
        'UPDATE garmin_session SET session = ? WHERE user = ? AND region = ?',
        encryptedSessionStr,
        getSessionUser(type),
        type,
    );
};

export const upsertSessionToDB = async (type: GarminRegion, session: Record<string, any>) => {
    const db = await getDB();
    const encryptedSessionStr = encryptSession(session);
    const result = await db.run(
        'UPDATE garmin_session SET session = ? WHERE user = ? AND region = ?',
        encryptedSessionStr,
        getSessionUser(type),
        type,
    );

    if (result.changes === 0) {
        await db.run(
            `INSERT INTO garmin_session (user,region,session) VALUES (?,?,?)`,
            getSessionUser(type),
            type,
            encryptedSessionStr,
        );
    }
};

export const getSessionFromDB = async (type: GarminRegion): Promise<Record<string, any> | undefined> => {
    const db = await getDB();
    const queryResult = await db.get(
        'SELECT session FROM garmin_session WHERE user = ? AND region = ? ',
        getSessionUser(type), type,
    );
    if (!queryResult) {
        return undefined;
    }
    const encryptedSessionStr = queryResult?.session;
    try {
        return decryptSession(encryptedSessionStr);
    } catch (error) {
        console.warn(`Warn: failed to read ${type} Garmin session from DB, will re-login.`);
        return undefined;
    }
};

export const getTokenSessionFromDB = async (type: GarminRegion): Promise<GarminTokenSession | undefined> => {
    const session = await getSessionFromDB(type);
    if (!session) {
        return undefined;
    }

    const tokenSession = normalizeTokenSession(session);
    if (!tokenSession) {
        console.warn(`Warn: invalid ${type} Garmin session schema in DB, will re-login.`);
        return undefined;
    }

    return tokenSession;
};

export const getTokenSessionFromEnv = (type: GarminRegion): GarminTokenSession | undefined => {
    const rawToken = process.env[getTokenSecretName(type)];
    if (!rawToken?.trim()) {
        return undefined;
    }

    try {
        return parseTokenSession(rawToken, type);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`读取 ${getTokenSecretName(type)} 失败：${message}`);
    }
};

export const encryptSession = (session: Record<string, any>): string => {
    const sessionStr = JSON.stringify(session);
    return CryptoJS.AES.encrypt(sessionStr, AESKEY).toString();
};
export const decryptSession = (sessionStr: string): Record<string, any> => {
    const bytes = CryptoJS.AES.decrypt(sessionStr, AESKEY);
    const session = bytes.toString(CryptoJS.enc.Utf8);
    return JSON.parse(session);
};
