/**
 * Structured audit logging for Node services.
 *
 * The point of an audit log is that it can be read later by someone asking
 * "who did what, when, and from where". That requires two things a general
 * application log does not give you:
 *
 * 1. **A separate stream.** Audit events must not be mixed into the general
 *    log, or they get buried and cannot be trusted as a record. This module
 *    keeps `security.log` (or whatever you name it) strictly for audit
 *    events, in its own logger instance with its own transports.
 * 2. **A stable shape.** Every event carries an `action` from a fixed
 *    vocabulary plus a timestamp and the caller's IP, so the stream can be
 *    queried without parsing prose.
 *
 * Built on Winston. Every logger is produced by a factory, so two services —
 * or two tests — never share a transport or a rotation counter.
 */

const fs = require('fs');
const path = require('path');
const winston = require('winston');

/**
 * The default action vocabulary.
 *
 * Extend it through the `actions` option rather than by editing this list,
 * so that the shape of the stream stays consistent across services.
 */
const DEFAULT_ACTIONS = [
  'LOGIN',
  'LOGOUT',
  'ACCESS',
  'CREATE',
  'UPDATE',
  'DELETE',
  'DOWNLOAD',
  'SYNC',
  'ERROR',
];

/** Default rotation settings: 5 MB per file, keep 10. */
const DEFAULT_ROTATION = { maxsize: 5 * 1024 * 1024, maxFiles: 10 };

/**
 * Ensure the log directory exists.
 *
 * @param {string} dir
 * @returns {string} The same directory, for chaining.
 */
function ensureLogDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Build the human-readable line format.
 *
 * The `timestamp` field keeps the raw ISO-8601 value so that the structured
 * part of the line stays machine-readable, while the printed prefix shows a
 * localised date. (Winston's `timestamp` formatter owns that key, so the
 * ISO value has to survive it rather than be replaced by the display form.)
 *
 * @param {string} timeZone IANA timezone used for the printed timestamp.
 * @returns {import('winston').Logform.Format}
 */
function createFormat(timeZone) {
  return winston.format.combine(
    winston.format.timestamp({ format: () => new Date().toISOString() }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      const readable = new Date(timestamp).toLocaleString('en-GB', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        timeZone,
      });
      // The ISO timestamp stays in the structured part so the line can be
      // parsed by a machine, not only read by a human.
      const payload = { timestamp, ...meta };
      const metaStr = Object.keys(payload).length ? JSON.stringify(payload) : '';
      return `[${readable}] [${level.toUpperCase()}] ${message} ${metaStr}`.trim();
    })
  );
}

/**
 * Create the application logger.
 *
 * Writes to four rotated files — `error`, `warn`, `combined` and `audit` —
 * plus the console outside production.
 *
 * @param {object} [options]
 * @param {string} [options.dir] Directory for the log files.
 * @param {string} [options.service] Value written as the `service` field.
 * @param {string} [options.timeZone] IANA timezone for printed timestamps.
 * @param {string} [options.level] Minimum level for the console transport.
 * @param {object} [options.rotation] `{ maxsize, maxFiles }`.
 * @param {boolean} [options.console] Attach the console transport. Defaults to
 *   `true` outside production.
 * @param {boolean} [options.silent] Suppress **all** output, files included.
 *   Only useful for tests that assert on the logger's API rather than on
 *   what it wrote.
 * @returns {import('winston').Logger}
 */
function createLogger(options = {}) {
  const {
    dir = path.join(process.cwd(), 'logs'),
    service = 'application',
    timeZone = 'UTC',
    level = 'info',
    rotation = DEFAULT_ROTATION,
    console: useConsole = process.env.NODE_ENV !== 'production',
    silent = false,
  } = options;

  ensureLogDir(dir);

  const format = createFormat(timeZone);

  const logger = winston.createLogger({
    level,
    format,
    defaultMeta: { service },
    silent,
    transports: [
      new winston.transports.File({
        filename: path.join(dir, 'error.log'),
        level: 'error',
        ...rotation,
      }),
      new winston.transports.File({
        filename: path.join(dir, 'warn.log'),
        level: 'warn',
        ...rotation,
      }),
      new winston.transports.File({
        filename: path.join(dir, 'combined.log'),
        ...rotation,
      }),
      new winston.transports.File({
        filename: path.join(dir, 'audit.log'),
        level: 'info',
        ...rotation,
      }),
    ],
  });

  if (useConsole && !silent) {
    logger.add(
      new winston.transports.Console({
        format: winston.format.combine(winston.format.colorize(), format),
      })
    );
  }

  return logger;
}

/**
 * Create the audit logger.
 *
 * Deliberately a **separate instance** with a single transport: audit events
 * land in the audit file and nowhere else, so the file is a trustworthy
 * record rather than a filtered view of everything the service did.
 *
 * @param {object} [options] Same shape as {@link createLogger}, plus:
 * @param {string} [options.filename] Name of the audit file.
 * @param {string[]} [options.actions] Allowed action vocabulary.
 * @returns {{
 *   logger: import('winston').Logger,
 *   actions: string[],
 *   record: (action: string, message: string, meta?: object) => void,
 *   login: (username: string, success: boolean, ip?: string) => void,
 *   logout: (username: string, ip?: string) => void,
 *   access: (resource: string, username?: string, ip?: string) => void,
 *   create: (resource: string, id: string, actor?: string, ip?: string) => void,
 *   update: (resource: string, id: string, changes: object, actor?: string, ip?: string) => void,
 *   remove: (resource: string, id: string, actor?: string, ip?: string) => void,
 *   download: (resource: string, count: number, actor?: string, ip?: string) => void,
 *   sync: (count: number, success: boolean) => void,
 *   error: (message: string, error: Error, context?: object) => void,
 * }}
 */
function createAuditLogger(options = {}) {
  const {
    dir = path.join(process.cwd(), 'logs'),
    service = 'application',
    timeZone = 'UTC',
    filename = 'audit.log',
    actions = DEFAULT_ACTIONS,
    rotation = DEFAULT_ROTATION,
    console: useConsole = process.env.NODE_ENV !== 'production',
    silent = false,
  } = options;

  ensureLogDir(dir);

  const format = createFormat(timeZone);

  const logger = winston.createLogger({
    level: 'info',
    format,
    defaultMeta: { service },
    silent,
    transports: [
      new winston.transports.File({
        filename: path.join(dir, filename),
        ...rotation,
      }),
    ],
  });

  if (useConsole && !silent) {
    logger.add(
      new winston.transports.Console({
        format: winston.format.combine(winston.format.colorize(), format),
      })
    );
  }

  /**
   * Record one audit event.
   *
   * @param {string} action One of the configured action vocabulary.
   * @param {string} message Human-readable description.
   * @param {object} [meta] Extra structured fields.
   */
  function record(action, message, meta = {}) {
    if (!actions.includes(action)) {
      throw new Error(
        `Unknown audit action "${action}". Allowed: ${actions.join(', ')}`
      );
    }
    logger.info(message, {
      action,
      ...meta,
    });
  }

  return {
    logger,
    actions,

    record,

    /** A user signed in. A failed attempt is a warning, not an info event. */
    login(username, success, ip) {
      const level = success ? 'info' : 'warn';
      logger.log(level, `Login: ${username}`, {
        action: 'LOGIN',
        success,
        ip,
      });
    },

    /** A user signed out. */
    logout(username, ip) {
      record('LOGOUT', `Logout: ${username}`, { username, ip });
    },

    /** A resource was read. */
    access(resource, username, ip) {
      record('ACCESS', `Access: ${resource}`, { resource, username, ip });
    },

    /** A resource was created. */
    create(resource, id, actor, ip) {
      record('CREATE', `Created ${resource}: ${id}`, {
        resource,
        id,
        actor,
        ip,
      });
    },

    /** A resource was modified. The previous and new values are kept. */
    update(resource, id, changes, actor, ip) {
      record('UPDATE', `Updated ${resource}: ${id}`, {
        resource,
        id,
        changes,
        actor,
        ip,
      });
    },

    /** A resource was deleted. */
    remove(resource, id, actor, ip) {
      record('DELETE', `Deleted ${resource}: ${id}`, {
        resource,
        id,
        actor,
        ip,
      });
    },

    /** Files were downloaded. */
    download(resource, count, actor, ip) {
      record('DOWNLOAD', `Downloaded ${resource}`, {
        resource,
        filesCount: count,
        actor,
        ip,
      });
    },

    /** A synchronisation run finished. */
    sync(count, success) {
      const level = success ? 'info' : 'error';
      logger.log(level, `Sync: ${count} records`, {
        action: 'SYNC',
        recordsCount: count,
        success,
      });
    },

    /** An error was raised, with its stack attached. */
    error(message, error, context) {
      logger.error(message, {
        action: 'ERROR',
        error: error.message,
        stack: error.stack,
        context,
      });
    },
  };
}

module.exports = {
  createLogger,
  createAuditLogger,
  ensureLogDir,
  DEFAULT_ACTIONS,
  DEFAULT_ROTATION,
};
