import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { planRenames } from '../src/plan.js';

const D = new Date(2024, 4, 17, 14, 3, 22);
const T = '2024-05-17_14-03-22.jpg';

describe('planRenames', () => {
  test('planRenames appends _2, _3 to targets that clash with other planned targets or with existingNames, and never plans a rename that would overwrite an existing name.', () => {
    // clash between planned targets
    const planned = planRenames([
      { name: 'b.jpg', date: D },
      { name: 'a.jpg', date: D },
    ]);
    assert.deepStrictEqual(planned.renames, [
      { from: 'a.jpg', to: T },
      { from: 'b.jpg', to: '2024-05-17_14-03-22_2.jpg' },
    ]);
    assert.deepStrictEqual(planned.skipped, []);
  });

  test('planRenames appends _2 when the target clashes with an existing name', () => {
    const out = planRenames([{ name: 'c.jpg', date: D }], ['x.jpg', T]);
    assert.deepStrictEqual(out.renames, [{ from: 'c.jpg', to: '2024-05-17_14-03-22_2.jpg' }]);
  });

  test('planRenames appends _3 when _2 is also taken by an existing name', () => {
    const out = planRenames([{ name: 'a.jpg', date: D }], [T, '2024-05-17_14-03-22_2.jpg']);
    assert.deepStrictEqual(out.renames, [{ from: 'a.jpg', to: '2024-05-17_14-03-22_3.jpg' }]);
  });

  test('planRenames sequence _, _2, _3 for three entries with the same date', () => {
    const out = planRenames([
      { name: 'a.jpg', date: D },
      { name: 'b.jpg', date: D },
      { name: 'c.jpg', date: D },
    ]);
    assert.deepStrictEqual(out.renames, [
      { from: 'a.jpg', to: T },
      { from: 'b.jpg', to: '2024-05-17_14-03-22_2.jpg' },
      { from: 'c.jpg', to: '2024-05-17_14-03-22_3.jpg' },
    ]);
  });

  test('planRenames never plans a rename whose target is an existing name', () => {
    const existing = [T, '2024-05-17_14-03-22_2.jpg', 'zzz.jpg'];
    const out = planRenames(
      [
        { name: 'a.jpg', date: D },
        { name: 'b.jpg', date: D },
        { name: 'c.jpg', date: D },
        { name: 'd.jpg', date: D },
      ],
      existing,
    );
    assert.equal(out.renames.length, 4);
    const targets = out.renames.map((r) => r.to);
    assert.equal(new Set(targets).size, targets.length, 'targets must be distinct');
    for (const to of targets) {
      assert.ok(!existing.includes(to), `${to} must not overwrite an existing name`);
    }
  });
});

describe('planRenames skip and omit rules', () => {
  test('Entries with a null date appear in skipped with reason \'no-date\', and entries whose target already equals their name produce no rename.', () => {
    const out = planRenames([
      { name: 'z.jpg', date: null },
      { name: 'a.jpg', date: D },
    ]);
    assert.deepStrictEqual(out.renames, [{ from: 'a.jpg', to: T }]);
    assert.deepStrictEqual(out.skipped, [{ name: 'z.jpg', reason: 'no-date' }]);
  });

  test('an entry whose target equals its own name produces no rename', () => {
    const withExisting = planRenames([{ name: T, date: D }], [T]);
    assert.deepStrictEqual(withExisting.renames, []);
    assert.deepStrictEqual(withExisting.skipped, []);

    const withoutExisting = planRenames([{ name: T, date: D }]);
    assert.deepStrictEqual(withoutExisting.renames, []);
    assert.deepStrictEqual(withoutExisting.skipped, []);
  });

  test('extension is taken from the source name and lowercased', () => {
    const out = planRenames([{ name: 'IMG_1.JPEG', date: D }]);
    assert.deepStrictEqual(out.renames, [{ from: 'IMG_1.JPEG', to: '2024-05-17_14-03-22.jpeg' }]);
  });
});

describe('planRenames determinism and ordering', () => {
  test('planRenames is deterministic: the same input gives the same output, and renames are ordered by source name.', () => {
    const input = () => [
      { name: 'c.jpg', date: new Date(2024, 0, 3, 1, 1, 1) },
      { name: 'a.jpg', date: new Date(2024, 0, 1, 1, 1, 1) },
      { name: 'b.jpg', date: new Date(2024, 0, 2, 1, 1, 1) },
    ];
    const first = planRenames(input());
    const second = planRenames(input());
    assert.deepStrictEqual(first, second);

    const froms = first.renames.map((r) => r.from);
    assert.deepStrictEqual(froms, ['a.jpg', 'b.jpg', 'c.jpg']);
  });

  test('shuffled input gives the same output as sorted input', () => {
    const a = { name: 'a.jpg', date: D };
    const b = { name: 'b.jpg', date: D };
    const c = { name: 'c.jpg', date: null };
    assert.deepStrictEqual(planRenames([c, b, a]), planRenames([a, b, c]));
  });
});
