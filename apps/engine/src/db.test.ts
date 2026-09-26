import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Db, kvGet, kvSet } from './db.ts';

function memoryDb(): Db {
  const db = new Db(':memory:');
  db.migrate();
  return db;
}

test('a nested transaction that throws rolls back only its own writes and hooks when the caller catches', () => {
  const db = memoryDb();
  const fired: string[] = [];
  db.transaction(() => {
    kvSet(db, 'outer', 1);
    db.afterCommit(() => fired.push('outer'));
    try {
      db.transaction(() => {
        kvSet(db, 'inner', 2);
        db.afterCommit(() => fired.push('inner'));
        throw new Error('inner failed');
      });
    } catch {
      // The outer caller recovers and commits its own work.
    }
    db.transaction(() => {
      kvSet(db, 'sibling', 3);
      db.afterCommit(() => fired.push('sibling'));
    });
  });
  assert.equal(kvGet(db, 'outer'), 1);
  assert.equal(kvGet(db, 'inner'), null);
  assert.equal(kvGet(db, 'sibling'), 3);
  assert.deepEqual(fired, ['outer', 'sibling']);
});

test('an outer failure rolls back committed inner savepoints too', () => {
  const db = memoryDb();
  const fired: string[] = [];
  assert.throws(() =>
    db.transaction(() => {
      db.transaction(() => {
        kvSet(db, 'inner', 1);
        db.afterCommit(() => fired.push('inner'));
      });
      throw new Error('outer failed');
    }),
  );
  assert.equal(kvGet(db, 'inner'), null);
  assert.deepEqual(fired, []);
});
