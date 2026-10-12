// Compatibility fix for the locked upstream release. Applied on every install,
// so CI receives the fix too; reject unknown versions rather than patching blindly.
const fs = require('node:fs');
const path = require('node:path');

const packagePath = require.resolve('@gooin/garmin-connect/package.json');
const { version } = require(packagePath);
if (version !== '1.6.1') {
    throw new Error(`Review Garmin HTTP compatibility patch before using @gooin/garmin-connect ${version}`);
}
const filename = path.join(path.dirname(packagePath), 'dist/common/HttpClient.js');
let source = fs.readFileSync(filename, 'utf8');
const marker = '// garminSync: preserve transport errors and isolate token refresh';
if (source.includes(marker)) process.exit(0);

const start = source.indexOf('            if (error.response.status === 401 && !originalRequest._retry) {');
const end = source.indexOf('            if (axios_1.default.isAxiosError(error)) {', start);
if (start < 0 || end < 0) throw new Error('Garmin HTTP interceptor changed; review compatibility patch');
source = source.slice(0, start) + `            ${marker}
            if (!error.response) throw error;
            if (error.response.status === 401 && !originalRequest._retry &&
                (this.oauth2Token || this.refreshPromise)) {
                originalRequest._retry = true;
                if (!this.refreshPromise) {
                    const previousToken = this.oauth2Token;
                    this.refreshPromise = this.refreshOauth2Token().catch(error => {
                        // exchange() clears oauth2Token before sending its request.
                        // Restore it so a temporary failure can be retried safely.
                        this.oauth2Token = previousToken;
                        throw error;
                    }).finally(() => { this.refreshPromise = undefined; });
                }
                await this.refreshPromise;
                originalRequest.headers.Authorization = \`Bearer \${this.oauth2Token.access_token}\`;
                return this.client(originalRequest);
            }
` + source.slice(end);
fs.writeFileSync(filename, source);
console.log('Applied Garmin HTTP compatibility patch');
