/**
 * Pure parsers for Redis INFO and SLOWLOG output. No I/O -- unit-testable
 * without a live Redis.
 */

/**
 * Parse the raw INFO text block into a flat key->value map. INFO is grouped
 * into `# Section` blocks of `field:value` lines separated by CRLFs; we flatten
 * across sections (field names are globally unique in INFO). Blank lines and
 * `#` headers are skipped. Values are kept as strings -- the caller coerces the
 * specific fields it cares about, since INFO mixes ints, floats, and compound
 * strings (e.g. `db0:keys=5,expires=2,avg_ttl=0`).
 */
export function parseInfo(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf(":");
    if (idx <= 0) continue;
    const field = trimmed.slice(0, idx);
    const value = trimmed.slice(idx + 1);
    out[field] = value;
  }
  return out;
}

/**
 * Parse the per-database keyspace lines from a parsed INFO map. INFO's
 * `Keyspace` section has lines like `db0:keys=120,expires=8,avg_ttl=0`. Returns
 * one entry per non-empty db with keys/expires/avg_ttl coerced to numbers, plus
 * the derived count of keys WITHOUT an expiry (keys - expires) -- the headline
 * number for the "missing TTL" advisor check.
 */
export interface KeyspaceDb {
  db: number;
  keys: number;
  expires: number;
  keys_without_ttl: number;
  avg_ttl: number;
}

export function parseKeyspace(info: Record<string, string>): KeyspaceDb[] {
  const dbs: KeyspaceDb[] = [];
  for (const [field, value] of Object.entries(info)) {
    const m = field.match(/^db(\d+)$/);
    if (!m) continue;
    const db = Number.parseInt(m[1] as string, 10);
    const parts = parseCsvKv(value);
    const keys = numOr(parts.keys, 0);
    const expires = numOr(parts.expires, 0);
    dbs.push({
      db,
      keys,
      expires,
      keys_without_ttl: Math.max(0, keys - expires),
      avg_ttl: numOr(parts.avg_ttl, 0),
    });
  }
  dbs.sort((a, b) => a.db - b.db);
  return dbs;
}

/** Parse `a=1,b=2,c=3` into `{a: "1", b: "2", c: "3"}`. */
function parseCsvKv(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of value.split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

function numOr(v: string | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Coerce a single INFO field to a number, returning null when the field is
 * missing or its value is not a finite number. Shared by the health and
 * advisor tools so they surface `number | null` (never NaN) for every numeric
 * INFO field.
 */
export function infoNum(info: Record<string, string>, field: string): number | null {
  const v = info[field];
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * The raw SLOWLOG GET reply is an array of entries, each:
 *   [id, timestamp_unix, micros, [arg, arg, ...], client_addr?, client_name?]
 * (the last two fields exist on Redis 4.0+). Normalize into a readable object.
 * Defensive about shape -- a malformed entry is skipped rather than throwing.
 */
export interface SlowlogEntry {
  id: number;
  timestamp: number;
  micros: number;
  command: string;
  client_addr: string | null;
  client_name: string | null;
}

export function parseSlowlog(raw: unknown): SlowlogEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: SlowlogEntry[] = [];
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length < 4) continue;
    const [id, timestamp, micros, argv, clientAddr, clientName] = entry as unknown[];
    const command = Array.isArray(argv) ? argv.map((a) => String(a)).join(" ") : "";
    out.push({
      id: Number(id),
      timestamp: Number(timestamp),
      micros: Number(micros),
      command,
      client_addr: clientAddr != null ? String(clientAddr) : null,
      client_name: clientName != null ? String(clientName) : null,
    });
  }
  return out;
}
