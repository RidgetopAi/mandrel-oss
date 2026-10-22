/**
 * move-record-cli — run the REAL `project_move_record` service from a shell, no HTTP.
 *
 *   npx tsx scripts/move-record-cli.ts '{"recordType":"task","recordId":"<uuid>","toProject":"<id|name>"}'
 *
 * Prints ONE JSON line (the last line of stdout) in the same shape the MCP tool returns as
 * structuredContent: `{ ok:true, action:'moved'|'already_there', ...result }` or
 * `{ ok:false, error }` (exit 1). Reads DATABASE_* from the environment like the server.
 *
 * WHY IT EXISTS: the Command backend's bulk-move test (bulkByIdWriteScope.db.test.ts)
 * delegates to this instead of an HTTP stub, so "attachments follow a bulk-moved task" is
 * proven against the real reproject code + registry rather than against a fake that agrees
 * with itself. Also a usable operator tool for a one-off move on a box with no bridge.
 */
import { moveRecord } from '../src/services/reproject.js';
import { db } from '../src/config/database.js';

const input = JSON.parse(process.argv[2] ?? '{}');

(async () => {
  try {
    const result = await moveRecord(input);
    process.stdout.write(
      `\n${JSON.stringify({ ok: true, action: result.moved ? 'moved' : 'already_there', ...result })}\n`,
    );
  } catch (e) {
    process.stdout.write(`\n${JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) })}\n`);
    process.exitCode = 1;
  } finally {
    await db.end().catch(() => undefined);
  }
})();
