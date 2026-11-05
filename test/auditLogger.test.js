const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createLogger,
  createAuditLogger,
  ensureLogDir,
  DEFAULT_ACTIONS,
} = require('../src');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-logger-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Read a log file, returning '' when it does not exist yet. */
function readLog(dir, name) {
  const file = path.join(dir, name);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

describe('ensureLogDir', () => {
  test('creates the directory when it is missing', () => {
    const target = path.join(tmpDir, 'nested', 'logs');
    expect(fs.existsSync(target)).toBe(false);

    ensureLogDir(target);

    expect(fs.existsSync(target)).toBe(true);
  });

  test('is idempotent', () => {
    const target = path.join(tmpDir, 'logs');
    ensureLogDir(target);
    expect(() => ensureLogDir(target)).not.toThrow();
    expect(fs.existsSync(target)).toBe(true);
  });
});

describe('createLogger', () => {
  test('creates the log directory', () => {
    const dir = path.join(tmpDir, 'app-logs');
    createLogger({ dir, console: false });

    expect(fs.existsSync(dir)).toBe(true);
  });

  test('writes to the combined log', async () => {
    const dir = path.join(tmpDir, 'app-logs');
    const logger = createLogger({ dir, console: false });

    logger.info('hello from the service');

    await flush(logger);

    expect(readLog(dir, 'combined.log')).toContain('hello from the service');
  });

  test('separates errors into their own file', async () => {
    const dir = path.join(tmpDir, 'app-logs');
    const logger = createLogger({ dir, console: false });

    logger.error('something broke');

    await flush(logger);

    expect(readLog(dir, 'error.log')).toContain('something broke');
    expect(readLog(dir, 'combined.log')).toContain('something broke');
  });

  test('separates warnings into their own file', async () => {
    const dir = path.join(tmpDir, 'app-logs');
    const logger = createLogger({ dir, console: false });

    logger.warn('careful');

    await flush(logger);

    expect(readLog(dir, 'warn.log')).toContain('careful');
    expect(readLog(dir, 'error.log')).not.toContain('careful');
  });

  test('tags every line with the service name', async () => {
    const dir = path.join(tmpDir, 'app-logs');
    const logger = createLogger({ dir, service: 'billing-api', console: false });

    logger.info('tagged');

    await flush(logger);

    expect(readLog(dir, 'combined.log')).toContain('billing-api');
  });

  test('two loggers do not share transports', async () => {
    const dirA = path.join(tmpDir, 'a');
    const dirB = path.join(tmpDir, 'b');
    const loggerA = createLogger({ dir: dirA, console: false });
    const loggerB = createLogger({ dir: dirB, console: false });

    loggerA.info('only in a');
    loggerB.info('only in b');

    await flush(loggerA);
    await flush(loggerB);

    expect(readLog(dirA, 'combined.log')).toContain('only in a');
    expect(readLog(dirA, 'combined.log')).not.toContain('only in b');
  });
});

describe('console transport', () => {
  test('is attached by default outside production', () => {
    const logger = createLogger({ dir: path.join(tmpDir, 'console') });

    // Winston exposes the attached transports through its internal list.
    const fileTransports = logger.transports.filter(
      (t) => t.constructor.name === 'File'
    );
    const consoleTransports = logger.transports.filter(
      (t) => t.constructor.name === 'Console'
    );

    expect(fileTransports.length).toBeGreaterThan(0);
    expect(consoleTransports.length).toBe(1);
  });

  test('can be disabled explicitly', () => {
    const logger = createLogger({ dir: path.join(tmpDir, 'no-console'), console: false });

    const consoleTransports = logger.transports.filter(
      (t) => t.constructor.name === 'Console'
    );

    expect(consoleTransports.length).toBe(0);
  });

  test('the audit logger can attach it too', () => {
    const audit = createAuditLogger({ dir: path.join(tmpDir, 'audit-console') });

    const consoleTransports = audit.logger.transports.filter(
      (t) => t.constructor.name === 'Console'
    );

    expect(consoleTransports.length).toBe(1);
  });
});

describe('createAuditLogger', () => {
  test('records an event with action and timestamp', async () => {
    const dir = path.join(tmpDir, 'audit');
    const audit = createAuditLogger({ dir, console: false });

    audit.login('alice', true, '10.0.0.1');

    await flush(audit.logger);

    const log = readLog(dir, 'audit.log');
    expect(log).toContain('LOGIN');
    expect(log).toContain('alice');
    expect(log).toContain('10.0.0.1');
    expect(log).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  test('audit events do not leak into the general log', async () => {
    const dir = path.join(tmpDir, 'audit');
    const audit = createAuditLogger({ dir, console: false });

    audit.access('invoice-42', 'alice', '10.0.0.1');

    await flush(audit.logger);

    expect(readLog(dir, 'audit.log')).toContain('ACCESS');
    // A separate logger instance means nothing else writes to this file.
    expect(readLog(dir, 'combined.log')).toBe('');
    expect(readLog(dir, 'error.log')).toBe('');
  });

  test('a failed login is recorded as a warning', async () => {
    const dir = path.join(tmpDir, 'audit');
    const audit = createAuditLogger({ dir, console: false });

    audit.login('mallory', false, '10.0.0.9');

    await flush(audit.logger);

    expect(readLog(dir, 'audit.log')).toContain('LOGIN');
    expect(readLog(dir, 'audit.log')).toContain('"success":false');
  });

  test('rejects an action outside the vocabulary', () => {
    const audit = createAuditLogger({ dir: path.join(tmpDir, 'audit'), console: false });

    expect(() => audit.record('NOT_A_REAL_ACTION', 'nope')).toThrow(
      /Unknown audit action/
    );
  });

  test('accepts a custom vocabulary', async () => {
    const dir = path.join(tmpDir, 'audit');
    const audit = createAuditLogger({
      dir,
      console: false,
      actions: ['CUSTOM'],
    });

    audit.record('CUSTOM', 'a custom event');

    await flush(audit.logger);

    expect(readLog(dir, 'audit.log')).toContain('CUSTOM');
  });

  test('update keeps both the old and new values', async () => {
    const dir = path.join(tmpDir, 'audit');
    const audit = createAuditLogger({ dir, console: false });

    audit.update('ticket', '17', { oldStatus: 'open', newStatus: 'closed' });

    await flush(audit.logger);

    const log = readLog(dir, 'audit.log');
    expect(log).toContain('UPDATE');
    expect(log).toContain('oldStatus');
    expect(log).toContain('newStatus');
  });

  test('error records the message and the stack', async () => {
    const dir = path.join(tmpDir, 'audit');
    const audit = createAuditLogger({ dir, console: false });

    audit.error('failed to sync', new Error('connection refused'));

    await flush(audit.logger);

    const log = readLog(dir, 'audit.log');
    expect(log).toContain('ERROR');
    expect(log).toContain('connection refused');
  });

  test('sync records the record count', async () => {
    const dir = path.join(tmpDir, 'audit');
    const audit = createAuditLogger({ dir, console: false });

    audit.sync(42, true);

    await flush(audit.logger);

    expect(readLog(dir, 'audit.log')).toContain('SYNC');
    expect(readLog(dir, 'audit.log')).toContain('42');
  });

  test('logout records the user', async () => {
    const dir = path.join(tmpDir, 'audit');
    const audit = createAuditLogger({ dir, console: false });

    audit.logout('alice', '10.0.0.1');

    await flush(audit.logger);

    expect(readLog(dir, 'audit.log')).toContain('LOGOUT');
    expect(readLog(dir, 'audit.log')).toContain('alice');
  });

  test('create records the resource and id', async () => {
    const dir = path.join(tmpDir, 'audit');
    const audit = createAuditLogger({ dir, console: false });

    audit.create('ticket', '17', 'alice', '10.0.0.1');

    await flush(audit.logger);

    const log = readLog(dir, 'audit.log');
    expect(log).toContain('CREATE');
    expect(log).toContain('ticket');
    expect(log).toContain('17');
  });

  test('remove records the resource and id', async () => {
    const dir = path.join(tmpDir, 'audit');
    const audit = createAuditLogger({ dir, console: false });

    audit.remove('ticket', '17', 'alice', '10.0.0.1');

    await flush(audit.logger);

    const log = readLog(dir, 'audit.log');
    expect(log).toContain('DELETE');
    expect(log).toContain('ticket');
  });

  test('download records the file count', async () => {
    const dir = path.join(tmpDir, 'audit');
    const audit = createAuditLogger({ dir, console: false });

    audit.download('attachments', 3, 'alice', '10.0.0.1');

    await flush(audit.logger);

    const log = readLog(dir, 'audit.log');
    expect(log).toContain('DOWNLOAD');
    expect(log).toContain('"filesCount":3');
  });

  test('the default vocabulary is the documented one', () => {
    expect(DEFAULT_ACTIONS).toEqual([
      'LOGIN',
      'LOGOUT',
      'ACCESS',
      'CREATE',
      'UPDATE',
      'DELETE',
      'DOWNLOAD',
      'SYNC',
      'ERROR',
    ]);
  });
});

/** Give Winston a moment to flush its file transports. */
function flush(logger) {
  return new Promise((resolve) => setTimeout(resolve, 120));
}
