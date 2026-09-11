// Attribution.
//
// This is the file that earns the site. Freesound's clips are Creative
// Commons, and CC BY (the most common licence there) is a *conditional*
// grant: you may use the sound, provided you credit it. Credit that lives
// only in a database is not credit, so every board renders its own credits,
// and they export in the forms people actually paste — a README, a video
// description, a web page, a JSON manifest for a build step.
//
// The shape follows Creative Commons' own TASL recommendation: Title, Author,
// Source, Licence. Each line here carries all four plus the sound id, which is
// what makes a credit checkable rather than decorative.
//
// CC0 clips impose no condition. They are still listed — dropping them would
// make the credits an incomplete record of where a board came from — but they
// are marked as courtesy rather than obligation.

import { licenseInfo } from './freesound.mjs';

const escHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Markdown link text: `]` and `[` break the link, and a backslash escape is
// the portable fix across renderers.
const escMd = (s) => String(s).replace(/([\\`*_[\]()<>#])/g, '\\$1');

/**
 * Turn a board into its credit list, plus the summary facts a user needs to
 * know before they ship the board anywhere.
 */
export function creditsFor(board) {
  const entries = board.pads.map((pad) => {
    const info = licenseInfo(pad.sound.license);
    return {
      pad: pad.label,
      title: pad.sound.name,
      author: pad.sound.username,
      source: pad.sound.url,
      soundId: pad.sound.id,
      license: pad.sound.license || info.label,
      licenseLabel: info.label,
      licenseKey: info.key,
      attributionRequired: info.attribution,
      commercialUseAllowed: info.commercial,
    };
  });

  // One credit per distinct sound: a board that fires the same clip from three
  // pads owes one attribution, not three.
  const unique = [];
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.soundId)) continue;
    seen.add(entry.soundId);
    unique.push(entry);
  }

  const nonCommercial = unique.filter((e) => !e.commercialUseAllowed);
  return {
    board: { id: board.id, name: board.name, updated: board.updated },
    generated: new Date().toISOString(),
    sounds: unique,
    summary: {
      pads: board.pads.length,
      sounds: unique.length,
      attributionRequired: unique.filter((e) => e.attributionRequired).length,
      nonCommercial: nonCommercial.length,
      // The honest headline: one NC clip makes the whole board unusable in a
      // commercial context, and that is worth saying in one sentence rather
      // than leaving someone to work out from a table.
      commercialUseAllowed: nonCommercial.length === 0,
    },
    source: 'https://freesound.org',
  };
}

function line(entry) {
  return {
    title: entry.title,
    author: entry.author,
    source: entry.source,
    license: entry.licenseLabel,
  };
}

export function creditsMarkdown(credits) {
  const out = [];
  out.push(`# Credits — ${credits.board.name}`);
  out.push('');
  out.push(
    `${credits.summary.sounds} sound${credits.summary.sounds === 1 ? '' : 's'} from ` +
      `[Freesound](https://freesound.org), across ${credits.summary.pads} pad${credits.summary.pads === 1 ? '' : 's'}.`,
  );
  out.push('');
  if (!credits.summary.commercialUseAllowed) {
    const n = credits.summary.nonCommercial;
    out.push(`> **Not cleared for commercial use.** ${n} sound${n === 1 ? '' : 's'} here ${n === 1 ? 'is' : 'are'} licensed NonCommercial.`);
    out.push('');
  }
  for (const e of credits.sounds) {
    const { title, author, source, license } = line(e);
    out.push(`- *${escMd(title)}* by ${escMd(author)} — [freesound.org/s/${e.soundId}](${source}) — ${license}`);
  }
  out.push('');
  return out.join('\n');
}

export function creditsText(credits) {
  const out = [`Credits — ${credits.board.name}`, ''];
  if (!credits.summary.commercialUseAllowed) {
    out.push(`NOT CLEARED FOR COMMERCIAL USE: ${credits.summary.nonCommercial} NonCommercial sound(s).`, '');
  }
  for (const e of credits.sounds) {
    out.push(`"${e.title}" by ${e.author} (${e.licenseLabel}) — ${e.source}`);
  }
  out.push('', 'Sounds from freesound.org.');
  return out.join('\n');
}

export function creditsHtml(credits) {
  const rows = credits.sounds
    .map(
      (e) => `      <li><cite>${escHtml(e.title)}</cite> by ${escHtml(e.author)} —
        <a href="${escHtml(e.source)}" rel="noopener">freesound.org/s/${e.soundId}</a> —
        ${escHtml(e.licenseLabel)}</li>`,
    )
    .join('\n');
  const warning = credits.summary.commercialUseAllowed
    ? ''
    : `    <p class="warn"><strong>Not cleared for commercial use.</strong>
      ${credits.summary.nonCommercial} sound${credits.summary.nonCommercial === 1 ? '' : 's'} here
      ${credits.summary.nonCommercial === 1 ? 'is' : 'are'} licensed NonCommercial.</p>\n`;
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>Credits — ${escHtml(credits.board.name)}</title>
<style>
  body { font: 15px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; max-width: 46rem;
         margin: 3rem auto; padding: 0 1rem; background: #14161a; color: #d8dee9; }
  a { color: #7fb3d5; }
  .warn { border-left: 3px solid #d08770; padding-left: .75rem; color: #e4b48c; }
  li { margin-bottom: .4rem; }
</style>
<body>
  <h1>Credits — ${escHtml(credits.board.name)}</h1>
  <p>${credits.summary.sounds} sound${credits.summary.sounds === 1 ? '' : 's'} from
    <a href="https://freesound.org" rel="noopener">Freesound</a>, across
    ${credits.summary.pads} pad${credits.summary.pads === 1 ? '' : 's'}.</p>
${warning}  <ul>
${rows}
  </ul>
</body>
</html>
`;
}

export const CREDIT_FORMATS = {
  json: { type: 'application/json; charset=utf-8', ext: 'json', render: (c) => JSON.stringify(c, null, 2) },
  md: { type: 'text/markdown; charset=utf-8', ext: 'md', render: creditsMarkdown },
  txt: { type: 'text/plain; charset=utf-8', ext: 'txt', render: creditsText },
  html: { type: 'text/html; charset=utf-8', ext: 'html', render: creditsHtml },
};
