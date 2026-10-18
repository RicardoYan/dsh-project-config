// File log for diagnostics the desktop UI cannot show. Size-capped with one rotation.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const MAX_BYTES = 1024 * 1024;
/** The temp directory with Windows 8.3 short names expanded (TEMP often holds them). */
function tempDir() {
    try {
        return fs.realpathSync.native(os.tmpdir());
    }
    catch {
        return os.tmpdir();
    }
}
export const DEFAULT_LOG_FILE = path.join(tempDir(), 'dsh-project-config.log');
export function createLog(file = DEFAULT_LOG_FILE, logger) {
    const write = (level, message) => {
        const line = `${new Date().toISOString()} [${level}] ${message}\n`;
        try {
            const size = fs.statSync(file).size;
            if (size + line.length > MAX_BYTES)
                fs.renameSync(file, `${file}.1`);
        }
        catch {
            /* missing file or rename race: write anyway */
        }
        try {
            fs.appendFileSync(file, line, 'utf8');
        }
        catch {
            /* best effort */
        }
    };
    return {
        file,
        info(message) {
            write('INFO', message);
            logger?.info?.(`[project-config] ${message}`);
        },
        warn(message) {
            write('WARN', message);
            logger?.warn?.(`[project-config] ${message}`);
        },
        error(message) {
            write('ERROR', message);
            logger?.error?.(`[project-config] ${message}`);
        },
    };
}
