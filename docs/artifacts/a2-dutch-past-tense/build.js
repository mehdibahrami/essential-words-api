#!/usr/bin/env node
'use strict';

/**
 * Inline `a2-dutch-verbs.json` into `template.html` and write the publishable page.
 *
 * The artifact CSP blocks every external host except Google Fonts, so the data cannot be
 * fetched at runtime — it is embedded in a <script type="application/json"> block instead.
 *
 *   node docs/artifacts/a2-dutch-past-tense/build.js
 */

const fs = require('fs');
const path = require('path');
const { classifyByParticiple } = require('./classify');

const dir = __dirname;
const template = fs.readFileSync(path.join(dir, 'template.html'), 'utf8');
const data = JSON.parse(fs.readFileSync(path.join(dir, 'a2-dutch-verbs.json'), 'utf8'));

// The snapshot holds forms only. weak/strong/irregular is a rule over those forms, applied
// here so that changing the rule is a rebuild rather than a re-extract against the live DB.
data.verbs.forEach((v) => { v.class = classifyByParticiple(v.word, v.pastParticiple); });

const unknown = data.verbs.filter((v) => v.class === 'unknown');
if (unknown.length > 1) {
  // `zullen` genuinely has no participle; anything more means the snapshot lost forms.
  throw new Error(`${unknown.length} verbs have no classifiable participle: ` +
    unknown.map((v) => v.word).join(', '));
}

// `</script>` inside the payload would close the host block early; escaping the slash keeps
// the JSON byte-identical to the parser while making the sequence inert to the HTML tokenizer.
// The published page is wrapped in a <head> we do not control, so we cannot count on a
// charset declaration reaching it — Persian translations arrived as mojibake when the bytes
// were served as UTF-8 but decoded as Latin-1. Escaping every non-ASCII codepoint to \uXXXX
// makes the payload pure ASCII, which decodes identically under either assumption.
// Escaping the slash in `</` additionally keeps a literal `</script>` from closing the block.
const json = JSON.stringify(data)
  .replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
  .replace(/<\//g, '<\\/');

/**
 * Same charset problem, other half of the file: the Persian in the legend is literal markup,
 * not JSON, so \uXXXX does not apply to it. Numeric character references do — but only in
 * markup: inside <script> and <style> the HTML tokenizer does not resolve entities, so those
 * blocks are held back and left byte-for-byte alone (they are already ASCII; the data payload
 * is escaped separately above).
 */
function escapeMarkupOnly(source) {
  return source
    .split(/(<(?:script|style)\b[\s\S]*?<\/(?:script|style)>)/gi)
    .map((chunk, i) => (
      i % 2 === 1 // odd chunks are the captured <script>/<style> blocks
        ? chunk
        : chunk.replace(/[\u0080-\uffff]/g, (c) => '&#' + c.charCodeAt(0) + ';')
    ))
    .join('');
}

if (!template.includes('__DATA__')) {
  throw new Error('template.html no longer contains the __DATA__ placeholder');
}

const html = escapeMarkupOnly(template).replace('__DATA__', json);
// Belt and braces: <script>/<style> are held back from entity-escaping above, so a stray
// non-ASCII character inside either would ship raw and mojibake exactly like the Persian did.
// Fail the build instead of publishing it.
const stray = html.match(/[\u0080-\uffff]/);
if (stray) {
  const at = html.indexOf(stray[0]);
  throw new Error(
    `non-ASCII U+${stray[0].charCodeAt(0).toString(16).toUpperCase()} survived escaping ` +
    `(inside a script/style block?) near: ${JSON.stringify(html.slice(at - 60, at + 40))}`
  );
}

const out = path.join(dir, 'a2-dutch-past-tense.html');
fs.writeFileSync(out, html);

console.log(`wrote ${path.relative(process.cwd(), out)} — ${data.count} verbs, ${(html.length / 1024).toFixed(1)} KB`);
