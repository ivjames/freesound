// Deduplication, in three separate senses that people call by one name.
//
//   1. EXACT — the same Freesound sound already on this board. Handled in
//      lib/store.mjs, because it is a constraint on the board rather than a
//      judgement call, and it costs nothing to enforce.
//   2. NEAR — a results page flooded by one pack's twenty takes of the same
//      footstep. Handled here, from data already in the search response, so it
//      costs no extra API calls.
//   3. ACOUSTIC — "do I already have something that sounds like this?", which
//      no amount of string comparison answers. Handled here too, but from
//      Freesound's own similarity index, which means one API request per clip
//      checked.
//
// Only the first is allowed to block anything. The other two inform: a pack of
// near-identical takes is often exactly what someone wants (twenty footsteps
// IS the point), and two clips being acoustically similar is a reason to look,
// not a reason to refuse.

/**
 * Reduce a clip title to the stem it shares with its siblings.
 *
 * "footstep_01.wav", "Footstep 02", "footstep-03-final" all reduce to
 * "footstep". The trailing-number strip is the load-bearing part: numbered
 * takes are how uploaders name a pack, and the number is the only thing that
 * differs.
 */
export function nameStem(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/\.(wav|mp3|aiff?|flac|ogg|m4a)$/i, '')
    .replace(/[_\-.]+/g, ' ')
    // Trailing take/variant markers: "03", "take 2", "v4", "final", "edit".
    .replace(/\b(take|ver|version|v|no|nr|num|pt|part)\s*\d+\b/g, ' ')
    .replace(/\b(final|edit|edited|new|old|copy|mix|master)\b/g, ' ')
    .replace(/\d+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Group a page of search results into near-duplicate clusters.
 *
 * Two clips cluster when they share a stem AND come from the same pack, or
 * share a stem AND the same uploader. Requiring more than the stem matters:
 * "rain" from four unrelated people is four genuinely different clips and
 * collapsing them would hide the choice that search exists to offer.
 *
 * Returns a list of `{...representative, variants: [...]}`, in the order the
 * representatives appeared, so relevance ranking survives the grouping.
 */
export function groupNearDuplicates(results, { minGroup = 2 } = {}) {
  const clusters = new Map();
  const order = [];

  for (const sound of results) {
    const stem = nameStem(sound.nameEn || sound.name);
    // A stem that reduces to nothing ("A02", "###") is not evidence of
    // anything — give those clips their own cluster rather than heaping every
    // opaque title together.
    const scope = sound.pack ? `pack:${sound.pack}` : `user:${sound.username}`;
    const key = stem ? `${scope}|${stem}` : `id:${sound.id}`;

    if (!clusters.has(key)) {
      clusters.set(key, []);
      order.push(key);
    }
    clusters.get(key).push(sound);
  }

  return order.map((key) => {
    const members = clusters.get(key);
    const [head, ...rest] = members;
    // A "cluster" of one is just a result; only report variants once there are
    // enough of them to be worth collapsing.
    if (members.length < minGroup) return { ...head, variants: [] };
    return { ...head, variants: rest, variantCount: rest.length };
  });
}

/**
 * Which pads on a board are acoustically similar to `soundId`, given the list
 * Freesound returned for it.
 *
 * `similarIds` is the set of sound ids from /apiv2/sounds/<id>/similar/. The
 * intersection with the board is the useful part: "you already have three
 * clips like this one, here they are" — by pad label, because that is what the
 * person is looking at.
 */
export function similarPadsOnBoard(board, similarIds, { excludeSoundId = null } = {}) {
  const ids = similarIds instanceof Set ? similarIds : new Set(similarIds);
  const seen = new Set();
  const hits = [];
  for (const pad of board.pads ?? []) {
    const id = pad.sound?.id;
    if (!ids.has(id) || id === excludeSoundId || seen.has(id)) continue;
    seen.add(id);
    hits.push({ padId: pad.id, label: pad.label, soundId: id, name: pad.sound.name });
  }
  return hits;
}

/**
 * Turn a board-wide similarity scan into clusters of pads that sound alike.
 *
 * `neighbours` maps each pad's sound id to the set of ids Freesound considers
 * similar to it. Similarity is not symmetric or transitive — B can be in A's
 * list while A is absent from B's — so this builds an undirected graph (an
 * edge if EITHER direction claims similarity) and returns its connected
 * components. Treating it as transitive would eventually merge the whole board
 * into one cluster, which is the failure mode that makes these tools useless.
 */
export function clusterSimilarPads(board, neighbours) {
  const pads = (board.pads ?? []).filter((p) => p.sound?.id);
  const byId = new Map(pads.map((p) => [p.sound.id, p]));
  const ids = [...byId.keys()];

  const adjacent = (a, b) => Boolean(neighbours.get(a)?.has(b)) || Boolean(neighbours.get(b)?.has(a));

  const seen = new Set();
  const clusters = [];
  for (const start of ids) {
    if (seen.has(start)) continue;
    const component = [];
    const queue = [start];
    seen.add(start);
    while (queue.length) {
      const current = queue.shift();
      component.push(current);
      for (const other of ids) {
        if (seen.has(other) || !adjacent(current, other)) continue;
        seen.add(other);
        queue.push(other);
      }
    }
    if (component.length > 1) {
      clusters.push(
        component.map((id) => {
          const pad = byId.get(id);
          return { padId: pad.id, label: pad.label, soundId: id, name: pad.sound.name };
        }),
      );
    }
  }
  return clusters;
}
