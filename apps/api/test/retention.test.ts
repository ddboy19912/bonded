import { afterAll, beforeAll, expect, it } from "vitest";
import type { Database } from "@bonded/db";
import { postgres } from "./postgres.js";

let pg: Awaited<ReturnType<typeof postgres>>;
let db: Database;
beforeAll(async () => {
  pg = await postgres();
  db = pg.db;
}, 120_000);
afterAll(() => pg?.stop());

it("prunes only events older than the cutoff, in batches, oldest first", async () => {
  for (let i = 0; i < 7; i++) await db.publish("rating.episode", { i });
  // Age the first five events to 40 days; the last two stay current.
  await db.pool.query(
    "UPDATE events SET created_at=now() - interval '40 days' WHERE id IN (SELECT id FROM events ORDER BY id LIMIT 5)",
  );
  const kept = (await db.pool.query("SELECT id FROM events ORDER BY id OFFSET 5")).rows;

  // A batch size of two forces three delete rounds for five old rows.
  const deleted = await db.pruneEvents(new Date(Date.now() - 30 * 86_400_000), 2);

  expect(deleted).toBe(5);
  expect((await db.pool.query("SELECT id FROM events ORDER BY id")).rows).toEqual(kept);
  expect(await db.pruneEvents(new Date(Date.now() - 30 * 86_400_000), 2)).toBe(0);
});

it("keeps ratings history when events are pruned", async () => {
  await db.pool.query(
    "INSERT INTO agents(id,chain_id,agent_id,config) VALUES('1:9',1,9,'{}') ON CONFLICT DO NOTHING",
  );
  await db.pool.query(
    "INSERT INTO ratings(id,agent_id,status) VALUES('00000000-0000-0000-0000-000000000009','1:9','done')",
  );
  await db.publish("rating.episode", { runId: "00000000-0000-0000-0000-000000000009" });
  await db.pool.query("UPDATE events SET created_at=now() - interval '40 days'");

  await db.pruneEvents(new Date(Date.now() - 30 * 86_400_000));

  expect((await db.pool.query("SELECT count(*)::int AS n FROM events")).rows[0].n).toBe(0);
  expect((await db.pool.query("SELECT status FROM ratings")).rows).toEqual([{ status: "done" }]);
});

it("prunes connection checks' step logs older than the cutoff, and keeps the checks", async () => {
  const check = "00000000-0000-0000-0000-0000000000c1";
  await db.pool.query(
    `INSERT INTO connection_checks(id,subject,chain_id,owner,mode,connection,status,result)
     VALUES($1,'preview:p1',1,'0xowner','preview','hosted','passed','{"ok":true}')`,
    [check],
  );
  for (let i = 0; i < 5; i++)
    await db.pool.query("INSERT INTO connection_check_events(check_id,event) VALUES($1,$2)", [
      check,
      { step: i },
    ]);
  // The first three steps are 40 days old; the last two are current.
  await db.pool.query(
    `UPDATE connection_check_events SET created_at=now() - interval '40 days'
     WHERE id IN (SELECT id FROM connection_check_events ORDER BY id LIMIT 3)`,
  );

  const deleted = await db.pruneCheckEvents(new Date(Date.now() - 30 * 86_400_000), 2);

  expect(deleted).toBe(3);
  const left = await db.pool.query("SELECT event FROM connection_check_events ORDER BY id");
  expect(left.rows.map((r) => r.event)).toEqual([{ step: 3 }, { step: 4 }]);
  // The check and its result stay.
  expect(
    (await db.pool.query("SELECT status,result FROM connection_checks WHERE id=$1", [check])).rows,
  ).toEqual([{ status: "passed", result: { ok: true } }]);
  await expect(db.pruneCheckEvents(new Date(), 0)).rejects.toThrow(RangeError);
});

it("rejects a batch size that could never finish", async () => {
  const cutoff = new Date(Date.now() - 30 * 86_400_000);
  for (const size of [0, -1, 1.5, Number.NaN])
    await expect(db.pruneEvents(cutoff, size)).rejects.toThrow(RangeError);
});
