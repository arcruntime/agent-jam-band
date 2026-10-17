import neo4j, { type Driver, type Record as Neo4jRecord } from 'neo4j-driver';

/**
 * Thin Neo4j layer for the band's memory. The music never depends on it: every call resolves to null instead of throwing when the database is unconfigured, unreachable or slow, and problems are logged to the server console only (once per outage, not once per call).
 */

const OP_TIMEOUT_MS = 3000;
const RETRY_AFTER_MS = 15000;

let driver: Driver | null | undefined;
let healthy = false;
let reportedDown = false;
let downUntil = 0;
let onConnect: (() => void) | undefined;

/** Registers what to run each time the database goes from unreachable to reachable (schema setup). */
export function onNeo4jConnected(fn: () => void) {
  onConnect = fn;
}

const clean = (v: string | undefined) => v?.trim() || undefined;

/** Connection settings from .env, using the names of Aura's credential file. NEO4J_USER still works when NEO4J_USERNAME is missing. All values are trimmed. */
function neo4jConfig() {
  return {
    uri: clean(process.env.NEO4J_URI),
    username: clean(process.env.NEO4J_USERNAME) ?? clean(process.env.NEO4J_USER),
    password: clean(process.env.NEO4J_PASSWORD),
    /** Undefined (the server's default database) when NEO4J_DATABASE is blank */
    database: clean(process.env.NEO4J_DATABASE),
  };
}

/** `code: message` for the console. Neo4j errors never carry the password, and the config is never logged. */
const describeError = (err: unknown) => {
  const e = err as { code?: string; message?: string };
  return `${e.code ?? 'no error code'}: ${e.message ?? String(err)}`;
};

function getDriver(): Driver | null {
  if (driver !== undefined) return driver;
  const { uri, username, password } = neo4jConfig();
  if (!uri || !username || !password) {
    console.warn('[neo4j] NEO4J_URI, NEO4J_USERNAME (or NEO4J_USER) or NEO4J_PASSWORD is empty in .env, so band memory is off. The band keeps playing.');
    return (driver = null);
  }
  try {
    driver = neo4j.driver(uri, neo4j.auth.basic(username, password), {
      connectionTimeout: 4000,
      connectionAcquisitionTimeout: 4000,
      maxTransactionRetryTime: 2000,
    });
  } catch (err) {
    console.error(`[neo4j] cannot create the driver for NEO4J_URI (${describeError(err)}), so band memory is off. The band keeps playing.`);
    driver = null;
  }
  return driver;
}

const isConnectivityError = (err: unknown) => {
  const e = err as { code?: string; message?: string };
  return (
    e.code === 'ServiceUnavailable' ||
    e.code === 'SessionExpired' ||
    e.code?.startsWith('Neo.ClientError.Security') === true ||
    /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|timed out|not reachable|Could not perform discovery/i.test(e.message ?? '')
  );
};

function markUp() {
  if (healthy) return;
  healthy = true;
  downUntil = 0;
  if (reportedDown) {
    console.log('neo4j connected (recovered)');
    reportedDown = false;
  }
  onConnect?.();
}

function markDown(err: unknown) {
  downUntil = Date.now() + RETRY_AFTER_MS;
  healthy = false;
  if (reportedDown) return;
  reportedDown = true;
  console.error(`[neo4j] unreachable (${describeError(err)}); band memory is paused and the music keeps playing. Retrying every ${RETRY_AFTER_MS / 1000}s.`);
}

/** Called once from the server start: getServerInfo() proves the server answers and the credentials work. Logs "neo4j connected to <database>", or the error code and message. */
export async function initNeo4j(): Promise<boolean> {
  const d = getDriver();
  if (!d) return false;
  const { database } = neo4jConfig();
  try {
    await d.getServerInfo({ database });
    markUp();
    console.log(`neo4j connected to ${database ?? 'the default database'}`);
    return true;
  } catch (err) {
    markDown(err);
    return false;
  }
}

export async function closeNeo4j() {
  await driver?.close().catch(() => undefined);
}

type QueryRunner = (mode: 'read' | 'write', cypher: string, params?: object) => Promise<Neo4jRecord[] | null>;
let override: QueryRunner | undefined;

/** Test seam: replaces the database round trip, so the memory logic can be exercised without a Neo4j server. Not used by the app. */
export function setQueryRunnerForTests(fn: QueryRunner | undefined) {
  override = fn;
}

/** Runs one Cypher statement. Resolves to the records, or null if Neo4j is off, down (cooling down) or the statement failed. Never throws. */
export async function query(mode: 'read' | 'write', cypher: string, params: object = {}): Promise<Neo4jRecord[] | null> {
  if (override) return override(mode, cypher, params);
  return run(mode, cypher, params);
}

async function run(mode: 'read' | 'write', cypher: string, params: object): Promise<Neo4jRecord[] | null> {
  const d = getDriver();
  if (!d || Date.now() < downUntil) return null;
  const session = d.session({ database: neo4jConfig().database, defaultAccessMode: mode === 'read' ? neo4j.session.READ : neo4j.session.WRITE });
  try {
    const work = (tx: { run: (c: string, p?: object) => Promise<{ records: Neo4jRecord[] }> }) => tx.run(cypher, params).then((r) => r.records);
    const records = mode === 'read' ? await session.executeRead(work, { timeout: OP_TIMEOUT_MS }) : await session.executeWrite(work, { timeout: OP_TIMEOUT_MS });
    markUp();
    return records;
  } catch (err) {
    if (isConnectivityError(err)) markDown(err);
    else console.error(`[neo4j] statement failed (${describeError(err)})`);
    return null;
  } finally {
    await session.close().catch(() => undefined);
  }
}

/** Neo4j integers come back as objects; this gives a plain number. */
export const toNum = (v: unknown): number => (neo4j.isInt(v) ? v.toNumber() : Number(v));
