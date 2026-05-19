/**
 * fix-db-paths.ts — rewrite absolute hostPath references inside
 * container_configs.config_json from the original root to the new root.
 *
 * Usage:  pnpm exec tsx scripts/migrate/fix-db-paths.ts <old-root> <new-root>
 */
import Database from 'better-sqlite3';
import path from 'node:path';

const [oldRoot, newRoot] = process.argv.slice(2);
if (!oldRoot || !newRoot) {
  console.error('Usage: fix-db-paths.ts <old-root> <new-root>');
  process.exit(64);
}

const dbPath = path.resolve(newRoot, 'data/v2.db');
const db = new Database(dbPath);

const rows = db
  .prepare('SELECT agent_group_id, config_json FROM container_configs')
  .all() as Array<{ agent_group_id: string; config_json: string }>;

let touched = 0;
for (const row of rows) {
  if (!row.config_json.includes(oldRoot)) continue;
  const rewritten = row.config_json.split(oldRoot).join(newRoot);
  db.prepare('UPDATE container_configs SET config_json = ? WHERE agent_group_id = ?')
    .run(rewritten, row.agent_group_id);
  touched++;
  console.log(`  patched ${row.agent_group_id}`);
}
console.log(`Done. ${touched}/${rows.length} container_configs updated.`);
db.close();
