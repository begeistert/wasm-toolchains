// registry.cjs — single source of truth for the toolchain targets.
//
// Every build-time script (harvest, make-*-dist, make-catalog, and the CI
// matrix) reads its per-target data from `targets/*.json` instead of carrying
// its own copy of the board/bundle tables. Adding a target (a new arch, a new
// board, a wireless overlay) is then a data change, not a script edit.
//
// A descriptor is one shippable bundle. Most are self-contained toolchains
// (avr, pico). An `overlay: true` descriptor (e.g. pico-wireless) ships only
// the delta on top of the bundle it `extends`, and rides the same release
// track — so a host that doesn't target those boards never downloads it.
//
// This module is BUILD-TIME only (Node). The host-side recipe(-pico).js keep
// their own self-contained tables: they ship inside the bundle and run in the
// browser, where this loader and the targets/ tree are not present.
'use strict';
const fs = require('fs');
const path = require('path');

const DIR = path.resolve(__dirname, '..', '..', 'targets');

function loadAll() {
  const out = {};
  for (const f of fs.readdirSync(DIR).sort()) {
    if (!f.endsWith('.json')) continue;
    const t = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
    if (out[t.id]) throw new Error(`registry: duplicate target id ${t.id}`);
    out[t.id] = t;
  }
  return out;
}

function target(id) {
  const t = loadAll()[id];
  if (!t) throw new Error(`registry: unknown target ${id}`);
  return t;
}

// Bundles on a release track, base first then overlays — the order CI builds
// and the catalog lists them.
function bundlesForTrack(track) {
  return Object.values(loadAll())
    .filter((t) => t.track === track)
    .sort((a, b) => (a.overlay ? 1 : 0) - (b.overlay ? 1 : 0) || a.id.localeCompare(b.id));
}

// The base (non-overlay) bundle of a track.
function baseBundle(track) {
  return bundlesForTrack(track).find((t) => !t.overlay) || null;
}

// Every board a track can produce — base bundle plus its overlays. The harvest
// step captures all of them in one container run; which ones a given bundle
// actually ships is decided downstream (make-*-dist).
function boardsForTrack(track) {
  return bundlesForTrack(track).flatMap((t) => t.boards || []);
}

// Map of board key -> board, across the whole track.
function boardMapForTrack(track) {
  return Object.fromEntries(boardsForTrack(track).map((b) => [b.key, b]));
}

module.exports = {
  loadAll, target, bundlesForTrack, baseBundle, boardsForTrack, boardMapForTrack,
};
