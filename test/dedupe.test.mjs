import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { clusterSimilarPads, groupNearDuplicates, nameStem, similarPadsOnBoard } from '../lib/dedupe.mjs';

const sound = (id, over = {}) => ({
  id,
  name: `Sound ${id}`,
  username: 'uploader',
  pack: '',
  ...over,
});

describe('nameStem', () => {
  it('strips the parts that differ between takes of one recording', () => {
    assert.equal(nameStem('footstep_01.wav'), 'footstep');
    assert.equal(nameStem('Footstep 02'), 'footstep');
    assert.equal(nameStem('footstep-03-final'), 'footstep');
    assert.equal(nameStem('footstep take 4'), 'footstep');
  });

  it('keeps the parts that are the actual name', () => {
    assert.equal(nameStem('rain on a window'), 'rain on a window');
    assert.equal(nameStem('808 kick'), 'kick', 'a leading number is a take marker as often as not');
  });

  it('reduces an opaque title to nothing rather than to a shared bucket', () => {
    assert.equal(nameStem('A02'), 'a');
    assert.equal(nameStem('001'), '');
    assert.equal(nameStem('___'), '');
  });
});

describe('groupNearDuplicates', () => {
  it("folds one pack's numbered takes into a single row", () => {
    const results = [
      sound(1, { name: 'footstep_01', pack: '99' }),
      sound(2, { name: 'footstep_02', pack: '99' }),
      sound(3, { name: 'footstep_03', pack: '99' }),
      sound(4, { name: 'door creak', pack: '99' }),
    ];
    const grouped = groupNearDuplicates(results);
    assert.equal(grouped.length, 2);
    assert.equal(grouped[0].id, 1, 'the first-ranked member represents the group');
    assert.equal(grouped[0].variantCount, 2);
    assert.deepEqual(grouped[0].variants.map((v) => v.id), [2, 3]);
    assert.deepEqual(grouped[1].variants, []);
  });

  it('never merges the same word from different people', () => {
    // This is the failure that would make search useless: four uploaders'
    // takes on "rain" are four real choices, not one clip listed four times.
    const results = [
      sound(1, { name: 'rain', username: 'ann' }),
      sound(2, { name: 'rain', username: 'bob' }),
      sound(3, { name: 'rain', username: 'cyd' }),
    ];
    const grouped = groupNearDuplicates(results);
    assert.equal(grouped.length, 3);
    assert.ok(grouped.every((g) => g.variants.length === 0));
  });

  it('groups one uploader’s takes even when they are not in a pack', () => {
    const results = [
      sound(1, { name: 'clap 1', username: 'ann' }),
      sound(2, { name: 'clap 2', username: 'ann' }),
    ];
    const grouped = groupNearDuplicates(results);
    assert.equal(grouped.length, 1);
    assert.equal(grouped[0].variantCount, 1);
  });

  it('does not heap every opaque title into one cluster', () => {
    const results = [
      sound(1, { name: '001', username: 'ann' }),
      sound(2, { name: '002', username: 'ann' }),
      sound(3, { name: '###', username: 'ann' }),
    ];
    const grouped = groupNearDuplicates(results);
    assert.equal(grouped.length, 3, 'a stem of nothing is not evidence of sameness');
  });

  it('groups on the translated name when there is one', () => {
    // The user reads the translation, so that is what "looks like a duplicate"
    // has to mean.
    const results = [
      sound(1, { name: 'paso_01', nameEn: 'footstep 01', pack: '7' }),
      sound(2, { name: 'paso_02', nameEn: 'footstep 02', pack: '7' }),
    ];
    const grouped = groupNearDuplicates(results);
    assert.equal(grouped.length, 1);
    assert.equal(grouped[0].variantCount, 1);
  });

  it('preserves relevance order of the representatives', () => {
    const results = [
      sound(10, { name: 'thunder', username: 'ann' }),
      sound(11, { name: 'clap 1', username: 'bob' }),
      sound(12, { name: 'clap 2', username: 'bob' }),
      sound(13, { name: 'wind', username: 'cyd' }),
    ];
    assert.deepEqual(groupNearDuplicates(results).map((g) => g.id), [10, 11, 13]);
  });
});

describe('similarPadsOnBoard', () => {
  const board = {
    pads: [
      { id: 'p1', label: 'Rain A', sound: sound(1) },
      { id: 'p2', label: 'Rain B', sound: sound(2) },
      { id: 'p3', label: 'Horn', sound: sound(3) },
    ],
  };

  it('reports the pads that appear in the similarity list', () => {
    const hits = similarPadsOnBoard(board, new Set([2, 3, 99]));
    assert.deepEqual(hits.map((h) => h.label), ['Rain B', 'Horn']);
    assert.equal(hits[0].padId, 'p2');
  });

  it('excludes the clip being checked, so nothing matches itself', () => {
    const hits = similarPadsOnBoard(board, new Set([1, 2]), { excludeSoundId: 1 });
    assert.deepEqual(hits.map((h) => h.soundId), [2]);
  });

  it('returns nothing when the board shares no sounds with the list', () => {
    assert.deepEqual(similarPadsOnBoard(board, new Set([77, 88])), []);
  });
});

describe('clusterSimilarPads', () => {
  const board = {
    pads: [
      { id: 'p1', label: 'A', sound: sound(1) },
      { id: 'p2', label: 'B', sound: sound(2) },
      { id: 'p3', label: 'C', sound: sound(3) },
      { id: 'p4', label: 'D', sound: sound(4) },
    ],
  };

  it('clusters pads that point at each other', () => {
    const neighbours = new Map([
      [1, new Set([2])],
      [2, new Set([1])],
      [3, new Set([])],
      [4, new Set([])],
    ]);
    const clusters = clusterSimilarPads(board, neighbours);
    assert.equal(clusters.length, 1);
    assert.deepEqual(clusters[0].map((h) => h.label).sort(), ['A', 'B']);
  });

  it('treats similarity as undirected — Freesound’s lists are not symmetric', () => {
    // B is in A's similar list but A is absent from B's. Requiring both
    // directions would report nothing, which is the common case in practice.
    const neighbours = new Map([
      [1, new Set([2])],
      [2, new Set([])],
      [3, new Set([])],
      [4, new Set([])],
    ]);
    const clusters = clusterSimilarPads(board, neighbours);
    assert.equal(clusters.length, 1);
    assert.deepEqual(clusters[0].map((h) => h.label).sort(), ['A', 'B']);
  });

  it('does not report a pad on its own', () => {
    const neighbours = new Map([[1, new Set([999])]]);
    assert.deepEqual(clusterSimilarPads(board, neighbours), []);
  });

  it('joins a chain into one cluster and leaves unrelated pads out', () => {
    const neighbours = new Map([
      [1, new Set([2])],
      [2, new Set([3])],
      [3, new Set([])],
      [4, new Set([])],
    ]);
    const clusters = clusterSimilarPads(board, neighbours);
    assert.equal(clusters.length, 1);
    assert.deepEqual(clusters[0].map((h) => h.label).sort(), ['A', 'B', 'C']);
  });

  it('handles a pad with no similarity data at all', () => {
    assert.deepEqual(clusterSimilarPads(board, new Map()), []);
  });
});
