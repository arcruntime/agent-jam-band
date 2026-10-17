// Checks the Neo4j settings in .env: node test-neo4j.mjs
// It reads NEO4J_URI, NEO4J_USERNAME (falling back to NEO4J_USER), NEO4J_PASSWORD and NEO4J_DATABASE, asks the server for its info, and runs RETURN 1. It never prints the password.
import 'dotenv/config';
import neo4j from 'neo4j-driver';

const clean = (v) => v?.trim() || undefined;
const uri = clean(process.env.NEO4J_URI);
const username = clean(process.env.NEO4J_USERNAME) ?? clean(process.env.NEO4J_USER);
const password = clean(process.env.NEO4J_PASSWORD);
const database = clean(process.env.NEO4J_DATABASE);

const missing = [!uri && 'NEO4J_URI', !username && 'NEO4J_USERNAME', !password && 'NEO4J_PASSWORD'].filter(Boolean);
if (missing.length) {
  console.error(`Missing in .env: ${missing.join(', ')}`);
  process.exit(1);
}

const driver = neo4j.driver(uri, neo4j.auth.basic(username, password), { connectionTimeout: 8000 });
try {
  const info = await driver.getServerInfo({ database });
  console.log(`neo4j connected to ${database ?? 'the default database'} (${info.address}, ${info.agent})`);
  const session = driver.session({ database });
  try {
    const result = await session.run('RETURN 1 AS ok');
    console.log(`RETURN 1 -> ${result.records[0].get('ok')}`);
  } finally {
    await session.close();
  }
} catch (err) {
  console.error(`neo4j failed: ${err.code ?? 'no error code'}: ${err.message}`);
  process.exitCode = 1;
} finally {
  await driver.close();
}
