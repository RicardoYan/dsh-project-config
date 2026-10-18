// File log for diagnostics the desktop UI cannot show. Size-capped with one rotation.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const MAX_BYTES = 1024 * 1024

/** The temp directory with Windows 8.3 short names expanded (TEMP often holds them). */
function tempDir(): string {
  try {
    return fs.realpathSync.native(os.tmpdir())
  } catch {
    return os.tmpdir()
  }
}

export const DEFAULT_LOG_FILE = path.join(tempDir(), 'dsh-project-config.log')

/** The DSH logger surface this log mirrors its messages to. */
export interface LoggerLike {
  info?: (message: string) => void
  warn?: (message: string) => void
  error?: (message: string) => void
}

/** What `createLog` returns: the file it writes and three levels. */
export interface Log {
  file: string
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

export function createLog(file: string = DEFAULT_LOG_FILE, logger?: LoggerLike): Log {
  const write = (level: string, message: string): void => {
    const line = `${new Date().toISOString()} [${level}] ${message}\n`
    try {
      const size = fs.statSync(file).size
      if (size + line.length > MAX_BYTES) fs.renameSync(file, `${file}.1`)
    } catch {
      /* missing file or rename race: write anyway */
    }
    try {
      fs.appendFileSync(file, line, 'utf8')
    } catch {
      /* best effort */
    }
  }
  return {
    file,
    info(message: string) {
      write('INFO', message)
      logger?.info?.(`[project-config] ${message}`)
    },
    warn(message: string) {
      write('WARN', message)
      logger?.warn?.(`[project-config] ${message}`)
    },
    error(message: string) {
      write('ERROR', message)
      logger?.error?.(`[project-config] ${message}`)
    },
  }
}
