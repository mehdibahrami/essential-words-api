# A2 Verleden Tijd — past tense reference sheet

Source material for the published artifact listing every Dutch verb in the **A2 essentials**
set (`word_sets.id = 8`, `nl-NL`) with its simple past (OVT) and past participle, ordered by
the time each word was added to the set.

## Files

| File | Role |
| --- | --- |
| `extract.js` | Pulls verbs + forms out of the live SQLite DB via the server's own `words.serializeWord`. |
| `a2-dutch-verbs.json` | The extracted snapshot (167 verbs). Regenerate; don't hand-edit. |
| `classify.js` | Derives regelmatig / sterk / onregelmatig **from the past participle**. |
| `template.html` | The page. `__DATA__` is the injection point. |
| `build.js` | Applies `classify.js`, inlines the JSON into the template → `a2-dutch-past-tense.html`. |
| `a2-dutch-past-tense.html` | The built page that gets published as the artifact. |

## Regenerating

```sh
# On the Pi, where the live DB is:
node docs/artifacts/a2-dutch-past-tense/extract.js 8 > a2-dutch-verbs.json

# Or locally against a copy:
EW_DB=/path/to/essential-words.sqlite node docs/artifacts/a2-dutch-past-tense/extract.js 8 \
  > docs/artifacts/a2-dutch-past-tense/a2-dutch-verbs.json

node docs/artifacts/a2-dutch-past-tense/build.js
```

`better-sqlite3` is a native module — run it under the same Node major the `node_modules`
tree was built against, or the load fails with a `NODE_MODULE_VERSION` mismatch.

## Decisions worth knowing before editing

- **Forms come from the server, never from a second grammar implementation here.** `extract.js`
  calls `words.serializeWord`, so the sheet shows exactly what the API serves and the app
  renders — including the split between a stored `grammar` object (37 verbs) and one derived
  live by `dutchGrammar.js` (130). A local reimplementation would drift silently.

- **`source` records provenance** — `stored`, `table` (pinned in `IRREGULAR_PAST`), or
  `weak-fallback` (guessed by `computeWeakPast`'s 't kofschip rule). Only 3 of 167 are
  fallback forms, and they are the ones to re-check first when a form looks wrong.

- **`class` describes the VOLTOOID DEELWOORD, not the O.V.T. and not the grammar object's
  `irregular` flag** (that flag is about the *present* tense). The sheet leads on the
  participle, so the tag on a row has to be a claim about the participle. `classify.js`:
  sterk = participle in `-en`/`-aan`; regelmatig = participle is `ge-` + the verb's own
  unchanged stem + `-t/-d`; onregelmatig = participle in `-t/-d` but with a changed stem
  (`kopen → gekocht`), plus the pinned preterite-presents and modals.

  Moving off the OVT rule reclassified 9 of 167, both ways: `zeggen`, `vragen`, `aanvragen`,
  `afzeggen` became **regelmatig** (odd preterite, textbook-regular participle: zei /
  *gezegd*), and `heten`, `hoeven`, `wassen`, `bakken`, `lachen` became **sterk** (weak
  preterite, `-en` participle). Totals went 95/49/23 → 99/54/14. That is the intended
  consequence, not drift: onregelmatig now means the 8 preterite-presents plus the six real
  stem-changers (kopen, zoeken, denken, brengen, terugbrengen, bezoeken).

- **The stem comes from `computeVerbPresent(...).present.ik`, never from `deriveStem`
  directly.** The `ik` form *is* the stem, and going through `computeVerbPresent` applies
  `IRREGULAR_PRESENT` and then `STEM_OVERRIDES` first. Calling `deriveStem` alone was tried
  and is wrong: it doubles the schwa in the `-eren/-enen/-igen` verbs (`openen` → `opeen`),
  which marked nine plainly regular verbs — openen, luisteren, veranderen, regelen,
  betekenen, ondertekenen, uitnodigen, regenen, eindigen — as onregelmatig. It also returns a
  separable's root already split, so `uitgenodigd` compares against `nodig`.

- **Classification is applied by `build.js`, not baked into the snapshot.** It is a rule over
  forms, not something read from the DB, so keeping it in `extract.js` would have meant a run
  against the live Pi database every time the rule changed. `extract.js` no longer emits
  `class`; the JSON holds forms only.

- **Only strong and irregular verbs are tagged in the UI.** Weak is the derivable default and
  the majority (99 of 167); tagging those too printed "Regelmatig" down two thirds of the page
  and buried the 68 that actually have to be memorised.

- **Column order is `#` / Infinitief / Voltooid deelwoord / O.V.T. enk. / O.V.T. mv.** The
  participle sits ahead of both past columns and carries the weight (`--cols`, `.form.vd`);
  the O.V.T. is set in `--ink-muted`. Two diacritic-bearing participles (`geëindigd`,
  `geïnteresseerd`) are why `classify.js` folds combining marks before comparing — a literal
  compare read both as stem changes.

- **The built page is pure ASCII, escaped two different ways.** The published page is wrapped
  in a `<head>` we don't control, so a charset declaration is not guaranteed to reach it — the
  Persian first rendered as mojibake. `build.js` escapes the JSON payload to `\uXXXX` and the
  Persian legend markup to numeric character references, holding back `<script>`/`<style>`
  blocks, where the tokenizer would not resolve an entity. Because that hold-back means a
  stray non-ASCII character inside a script or a comment would ship raw, `build.js` ends with
  a guard that throws on any surviving byte above U+007F -- it caught an em dash in a JS
  comment on its first run.

- **The theme control is a three-state cycle, not a two-state switch.** An artifact renders
  in the viewer's theme, and "system" is a real third state that stamps nothing on the root
  element. The button cycles auto -> light -> dark and only writes `data-theme` once it has
  been clicked, so an untouched page keeps following the device. The choice persists under
  `localStorage["theme-v1"]`, wrapped in try/catch because a private window throws on access
  rather than returning null.

- **The three-class key is in Persian and sits above the table**, since it has to be read
  before the sheet makes sense. It runs RTL; every Dutch fragment inside it is `unicode-bidi:
  isolate`d, without which the bidi algorithm reorders the arrows in `werken → werkte →
  gewerkt`. In an RTL container the cards read right to left — regelmatig first — which is the
  intended order, not a reversed one.

## Verification, 2026-08-30

All 167 past and past-participle forms were reviewed against standard modern Dutch, with
en.wiktionary consulted for every strong, mixed and doubtful entry. **166 were correct.**

One real error, fixed in `src/services/dutchGrammar.js`: `regenen` had its OVT plural written
as the singular (`regende`; correct is `regenden`). Covered now by two tests in
`tests/dutchGrammar.past.test.js` — one for `regenen`, and a structural sweep asserting that no
`IRREGULAR_PAST` entry has a plural that is missing, identical to its singular, or not `-n`
final. That sweep passes across all 231 entries, so `regenen` was the only instance.

Deliberate, not errors: separable verbs split in the OVT (`kwam aan`) and joined with `-ge-`
infixed in the participle (`aangekomen`); `houden van` keeping its fixed preposition; `zullen`
having no participle; and the mixed verbs `heten`, `wassen`, `bakken`, `lachen`, `hoeven`
taking a weak past with a strong participle.
