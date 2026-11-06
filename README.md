# winston-audit-logger

[![CI](https://github.com/klimenkod406/winston-audit-logger/actions/workflows/ci.yml/badge.svg)](https://github.com/klimenkod406/winston-audit-logger/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

Structured **audit logging** for Node services — a log you can actually answer
questions from six months later: *who did what, when, and from where.*

Built on Winston. One runtime dependency.

```text
  application logger                          audit logger
  ┌───────────────────────────┐              ┌──────────────────────┐
  │ error.log   (level=error)│              │                      │
  │ warn.log    (level=warn) │              │  audit.log           │
  │ combined.log             │              │  (audit events only) │
  │ audit.log   (level=info)│              │                      │
  └───────────────────────────┘              └──────────────────────┘
```

Open-source reference implementation extracted from a client project — an internal
ticketing system for a manufacturing enterprise (client code and business logic removed).

## Why a separate audit stream

An audit log is only useful if it is a **trustworthy record**. Mixing audit
events into the general application log breaks that in two ways:

- they get buried under debug noise, and
- the file contains everything, so "was this user logged in?" becomes a
  question you answer by grepping prose.

This module keeps the audit stream in its **own logger instance with its own
transport**. `audit.log` contains audit events and nothing else — that is
assertable, and the test suite asserts it.

## Install

```bash
npm install winston-audit-logger
```

## The application logger

```js
const { createLogger } = require('winston-audit-logger');

const logger = createLogger({
  dir: './logs',
  service: 'billing-api',
  timeZone: 'Europe/Berlin',
});

logger.info('service started');
logger.warn('cache miss rate above threshold');
logger.error('upstream timeout');
```

Four rotated files are written: `error.log`, `warn.log`, `combined.log` and
`audit.log`. Rotation defaults to 5 MB per file with 10 files kept.

## The audit logger

```js
const { createAuditLogger } = require('winston-audit-logger');

const audit = createAuditLogger({
  dir: './logs',
  service: 'billing-api',
});

audit.login('alice', true, '10.0.0.1');
audit.access('invoice-42', 'alice', '10.0.0.1');
audit.update('invoice-42', '42', { oldStatus: 'open', newStatus: 'paid' });
audit.download('attachments', 3, 'alice', '10.0.0.1');
audit.error('payment failed', new Error('gateway timeout'));
```

Each event carries a stable shape:

```text
[05/11/2026, 14:42:54] [INFO] Login: alice {"timestamp":"2026-11-05T06:42:54.123Z","service":"billing-api","action":"LOGIN","success":true,"ip":"10.0.0.1"}
```

- a human-readable prefix, and
- a JSON tail with an **ISO-8601 `timestamp`**, the `service`, the `action`
  and the event's own fields.

The ISO value is what makes the stream queryable; the prefix is what makes it
readable. Keeping both is deliberate — a localised date alone is not
parseable by a machine.

### Action vocabulary

Actions come from a fixed list, so the stream can be queried without parsing
prose:

```text
LOGIN  LOGOUT  ACCESS  CREATE  UPDATE  DELETE  DOWNLOAD  SYNC  ERROR
```

An unknown action throws rather than silently landing in the log:

```js
audit.record('MADE_UP', 'nope');
// Error: Unknown audit action "MADE_UP". Allowed: LOGIN, LOGOUT, ...
```

Extend the vocabulary per service:

```js
const audit = createAuditLogger({ actions: ['CUSTOM'] });
```

### Severity

A failed login is a `warn`, not an `info` — brute-force attempts should be
visible at a glance. A failed sync is an `error`.

## Design notes

- **Factory-based.** Every logger is created by a function, so two services
  (or two tests) never share a transport or a rotation counter. Module-level
  singletons silently couple them.
- **The audit logger is a separate instance.** Not a filtered view of the
  general log — a different logger with its own single transport. That is what
  makes `audit.log` trustworthy.
- **No hardcoded service name, directory or timezone.** All three are
  options. The original hardcoded `ticket-system`, `../logs` and
  `Europe/Moscow`, which made the module unusable outside its own service.
- **The ISO timestamp survives Winston.** Winston's `timestamp` formatter owns
  that key, so the raw value is kept in the structured part rather than being
  replaced by the display form.
- **Rotation on every file.** 5 MB × 10 files by default; an audit log that
  fills the disk is not an audit log.

## Testing

```bash
npm test
npm test -- --coverage
```

24 tests cover: directory creation, each transport's routing, the service
tag, isolation between two loggers, the console transport on and off, every
audit event type, the action vocabulary guard, and the guarantee that audit
events never reach the general log.

Coverage is 100% of statements and functions.

## License

MIT
