# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in this project, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, please use [GitHub's private vulnerability reporting](../../security/advisories/new) to submit your report. This ensures the issue is handled confidentially.

### What to include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if you have one)

### Response timeline

- **Acknowledgment**: Within 48 hours
- **Assessment**: Within 1 week
- **Fix**: Depends on severity, but we aim for patches within 2 weeks for critical issues

## Supported Versions

Only the latest published version receives security updates.

## Design notes that bear on security

- **`SCAN`, never `KEYS`.** Every key-enumeration path uses cursor-based `SCAN`
  with a bounded `COUNT` and a server-enforced page/iteration cap, never the
  `KEYS` command. `KEYS` is O(N) over the entire keyspace and blocks the
  single-threaded Redis event loop for the full scan -- on a production
  instance with millions of keys that is a self-inflicted denial of service.
  `SCAN` yields the event loop between batches. This is a deliberate,
  load-bearing choice; see the README "Security" section.

- **Read-only by default.** Mutating commands are gated behind `ALLOW_WRITES=1`.
  With writes disabled the server only issues commands on a read-only allowlist;
  any other command is rejected before it reaches Redis.

## Contact

For security matters that can't go through GitHub's reporting: **contact@yaw.sh**
