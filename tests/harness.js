#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const args = new Map(process.argv.slice(2).map((arg) => {
  const m = arg.match(/^--([^=]+)=(.*)$/);
  return m ? [m[1], m[2]] : [arg.replace(/^--/, ""), true];
}));
const profile = String(args.get("profile") || (args.get("soak") ? "soak" : "quick"));
const DEFAULT_SEEDS = profile === "soak" ? 80 : 3;
const seedCount = Number(args.get("seeds") || DEFAULT_SEEDS);
const full = !!args.get("full");
const allowMissingHeadless = !!args.get("allow-missing-headless");
const perRunBudgetMs = Number(args.get("timeout-ms") || (profile === "soak" ? 5000 : 2500));

const VARIANTS = [
  { file: "1492.html", label: "1492", players: ["borgia", "giuliano", "sforza"], approval: true },
  { file: "viterbo-1268.html", label: "viterbo-1268", players: ["orsini", "annibale", "guy"], approval: true },
  { file: "carafa-winter-1559.html", label: "carafa-winter-1559", players: ["ccarafa", "medici", "morone"], approval: true },
  { file: "venice-1800.html", label: "venice-1800", players: ["bellisomi", "mattei", "chiaramonti"], approval: false },
  { file: "october-1978.html", label: "october-1978", players: ["siri", "benelli", "wojtyla"], approval: false },
];

function htmlScripts(html) {
  return [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => m[1])
    .join("\n");
}

function fakeElement() {
  return {
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    style: { setProperty() {} },
    dataset: {},
    value: "",
    checked: false,
    disabled: false,
    parentNode: null,
    appendChild() {},
    append() {},
    addEventListener() {},
    setAttribute() {},
    getAttribute() { return null; },
    querySelector() { return fakeElement(); },
    querySelectorAll() { return []; },
    remove() {},
    focus() {},
    click() {},
    get textContent() { return ""; },
    set textContent(_) {},
    get innerHTML() { return ""; },
    set innerHTML(_) {},
  };
}

function loadVariant(file) {
  const abs = path.join(ROOT, file);
  const html = fs.readFileSync(abs, "utf8");
  const script = htmlScripts(html);
  const context = {
    console,
    window: {},
    location: { search: "", reload() {} },
    document: {
      readyState: "loading",
      body: fakeElement(),
      addEventListener() {},
      querySelector() { return fakeElement(); },
      querySelectorAll() { return []; },
      createElement() { return fakeElement(); },
      createTextNode(text) { return { nodeType: 3, textContent: String(text) }; },
    },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    setTimeout,
    clearTimeout,
    URL: { createObjectURL() { return "blob:test"; }, revokeObjectURL() {} },
    Blob: function Blob() {},
  };
  context.window.document = context.document;
  context.window.localStorage = context.localStorage;
  vm.createContext(context);
  const exportProbe = `
;globalThis.__EO_TEST_EXPORTS__ = {
  runHeadless: typeof runHeadless === "function" ? runHeadless : null,
  initState: typeof initState === "function" ? initState : null,
  runBallot: typeof runBallot === "function" ? runBallot : null,
  conductBallot: typeof conductBallot === "function" ? conductBallot : null,
  topPreference: typeof topPreference === "function" ? topPreference : null,
  beginScrutiny: typeof beginScrutiny === "function" ? beginScrutiny : null,
  playerAccede: typeof playerAccede === "function" ? playerAccede : null,
  getState: typeof OCTOBER_1978_ENGINE !== "undefined" ? OCTOBER_1978_ENGINE.getState : (typeof VENICE_1800_ENGINE !== "undefined" ? VENICE_1800_ENGINE.getState : null),
  ELECTORS: typeof ELECTORS !== "undefined" ? ELECTORS : null,
  CARDINALS: typeof CARDINALS !== "undefined" ? CARDINALS : null,
  IDS: typeof IDS !== "undefined" ? IDS : null,
  ID: typeof ID !== "undefined" ? ID : null,
  byId: typeof byId !== "undefined" ? byId : null,
  threshold: typeof threshold === "function" ? threshold : null,
  windowOm: typeof window !== "undefined" ? window.__om : null
};`;
  vm.runInContext(script + exportProbe, context, { filename: file, timeout: 5000 });
  return context.__EO_TEST_EXPORTS__;
}

function stable(value, seen = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "function") return value.state === undefined ? undefined : { __functionState: value.state };
  if (typeof value !== "object") return undefined;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => stable(v, seen));
  const out = {};
  for (const key of Object.keys(value).sort()) {
    const v = stable(value[key], seen);
    if (v !== undefined) out[key] = v;
  }
  seen.delete(value);
  return out;
}

function winnerOf(result) {
  return result && (result.winner || result.electedId || (result.ending && result.ending.electedId) || null);
}

function ballotNumber(record, fallback) {
  return record.ballot || record.n || record.turn || fallback;
}

function recordsOf(result) {
  return (result && (result.history || result.scrutinies || result.tallies)) || [];
}

function expectedThreshold(label, electors) {
  if (!electors) return null;
  if (label === "october-1978") return Math.floor((2 * electors) / 3) + 1;
  return Math.ceil((2 * electors) / 3);
}

function normaliseEntries(record) {
  const roll = record.roll || record.votes || null;
  if (!roll) return [];
  const raw = Array.isArray(roll) ? roll.map((item) => [item.voter, item.candidate]) : Object.entries(roll);
  return raw.map(([voter, vote]) => ({
    voter,
    picks: Array.isArray(vote) ? vote.slice() : (vote ? [vote] : []),
  }));
}

function countPicks(entries) {
  const counts = {};
  for (const { picks } of entries) {
    for (const cand of picks) counts[cand] = (counts[cand] || 0) + 1;
  }
  return counts;
}

function addAccessions(counts, accessions) {
  const out = { ...counts };
  for (const a of accessions || []) out[a.to] = (out[a.to] || 0) + 1;
  return out;
}

function compareCounts(actual, expected, context, failures) {
  if (!actual) return;
  const keys = new Set([...Object.keys(actual), ...Object.keys(expected)]);
  for (const key of keys) {
    if ((actual[key] || 0) !== (expected[key] || 0)) {
      failures.push(`${context}: count mismatch for ${key}: recorded ${actual[key] || 0}, recomputed ${expected[key] || 0}`);
    }
  }
}

function validateBallotRecords(variant, result, knownIds) {
  const failures = [];
  const records = recordsOf(result);
  records.forEach((record, index) => {
    const context = `${variant.label} seed=${result.seed || "?"} player=${result.playerId || "?"} ballot=${ballotNumber(record, index + 1)}`;
    const entries = normaliseEntries(record);
    if (!entries.length) return;
    const voters = new Set();
    for (const entry of entries) {
      if (!knownIds.has(entry.voter)) failures.push(`${context}: unknown voter ${entry.voter}`);
      if (voters.has(entry.voter)) failures.push(`${context}: duplicate voter ${entry.voter}`);
      voters.add(entry.voter);
      if (!variant.approval && entry.picks.length > 1) failures.push(`${context}: one-name ballot has ${entry.picks.length} selections for ${entry.voter}`);
      if (variant.approval && entry.picks.length > 3) failures.push(`${context}: approval ballot has ${entry.picks.length} selections for ${entry.voter}`);
      const seenPicks = new Set();
      for (const cand of entry.picks) {
        if (seenPicks.has(cand)) failures.push(`${context}: duplicate candidate ${cand} on ${entry.voter}'s ballot`);
        seenPicks.add(cand);
        if (!knownIds.has(cand)) failures.push(`${context}: unknown candidate ${cand} on ${entry.voter}'s ballot`);
        if (cand === entry.voter) failures.push(`${context}: self-vote ${entry.voter}`);
      }
    }
    const electorCount = record.electors || entries.length;
    if (record.electors && record.electors !== voters.size) failures.push(`${context}: electors=${record.electors} but roll has ${voters.size} unique voters`);
    const expected = expectedThreshold(variant.label, electorCount);
    if (record.threshold !== undefined && expected !== null && record.threshold !== expected) failures.push(`${context}: threshold ${record.threshold}, expected ${expected}`);
    const rawCounts = countPicks(entries);
    compareCounts(record.tally, rawCounts, `${context} raw tally`, failures);
    const finalCounts = addAccessions(rawCounts, record.accessions || []);
    compareCounts(record.counts, finalCounts, `${context} counts`, failures);
    compareCounts(record.final, finalCounts, `${context} final`, failures);
    compareCounts(record.running && record.elected !== undefined ? record.running : null, finalCounts, `${context} running`, failures);
    for (const a of record.accessions || []) {
      if (!knownIds.has(a.from)) failures.push(`${context}: accessus from unknown voter ${a.from}`);
      if (!knownIds.has(a.to)) failures.push(`${context}: accessus to unknown candidate ${a.to}`);
      if (a.from === a.to) failures.push(`${context}: self-accessus ${a.from}`);
      const original = entries.find((entry) => entry.voter === a.from);
      if (original && original.picks.includes(a.to)) failures.push(`${context}: accessus repeats ${a.from}'s written ballot`);
    }
  });
  return failures;
}

function assertUniqueIds(label, cards) {
  if (!cards || !cards.length) return [];
  const ids = cards.map((c) => c.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  return dupes.length ? [`${label}: duplicate cardinal IDs: ${[...new Set(dupes)].join(", ")}`] : [];
}

function boundedMetricFailures(label, result) {
  const failures = [];
  const bounded = new Set(["security", "heat", "integrity", "peril", "carafaperil", "taint", "fatigue", "exposure", "trust", "stature", "worldchurch", "nonitalian", "curiaconfidence"]);
  function walk(value, pathName, seen = new WeakSet()) {
    if (!value || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      const lower = key.toLowerCase();
      if (bounded.has(lower) && typeof child === "number" && (child < 0 || child > 100)) failures.push(`${label}: metric ${pathName}${key} out of range: ${child}`);
      if (child && typeof child === "object") walk(child, `${pathName}${key}.`, seen);
    }
  }
  walk(result, "");
  return failures;
}

function validateConfiguredPlayers(variant, cards) {
  if (!cards || !cards.length) return [`${variant.label}: no CARDINALS/ELECTORS export available for player validation`];
  const ids = new Set(cards.map((c) => c.id));
  return variant.players.filter((id) => !ids.has(id)).map((id) => `${variant.label}: configured player '${id}' is not in the roster`);
}

function runOne(runner, seed, player, variant) {
  const started = Date.now();
  const result = runner(seed, player);
  const elapsed = Date.now() - started;
  if (elapsed > perRunBudgetMs) throw new Error(`${variant.label}: seed=${seed}, player=${player} exceeded ${perRunBudgetMs} ms (${elapsed} ms)`);
  return result;
}

function runHeadlessChecks(variant, api) {
  const runner = api.runHeadless || (api.windowOm && api.windowOm.runHeadless);
  if (!runner) {
    const message = `${variant.label}: no runHeadless export`;
    return allowMissingHeadless ? { skipped: message } : { failures: [message] };
  }
  const cards = api.CARDINALS || api.ELECTORS || (api.windowOm && (api.windowOm.CARDINALS || api.windowOm.ELECTORS)) || [];
  const knownIds = new Set(cards.map((c) => c.id));
  const failures = [];
  failures.push(...validateConfiguredPlayers(variant, cards));
  if (failures.length) return { failures };

  const players = full ? cards.map((c) => c.id) : variant.players;
  const winners = new Map();
  const ballotCounts = [];

  for (let s = 0; s < seedCount; s++) {
    for (const player of players) {
      const seed = `${variant.label}-${s}`;
      let a;
      let b;
      try {
        a = runOne(runner, seed, player, variant);
        b = runOne(runner, seed, player, variant);
      } catch (err) {
        failures.push(`${variant.label}: runtime error seed=${seed} player=${player}: ${err && err.stack || err}`);
        continue;
      }
      const digestA = JSON.stringify(stable(a));
      const digestB = JSON.stringify(stable(b));
      if (digestA !== digestB) failures.push(`${variant.label}: non-deterministic run seed=${seed} player=${player}`);
      failures.push(...validateBallotRecords(variant, a, knownIds));
      failures.push(...boundedMetricFailures(`${variant.label} seed=${seed} player=${player}`, a));
      const winner = winnerOf(a) || "unresolved";
      winners.set(winner, (winners.get(winner) || 0) + 1);
      ballotCounts.push(recordsOf(a).length || Number(a.ballots || a.day || a.turn || 0));
      if (!winnerOf(a)) failures.push(`${variant.label}: unresolved run seed=${seed} player=${player}`);
    }
  }
  ballotCounts.sort((a, b) => a - b);
  const medianBallots = ballotCounts.length ? ballotCounts[Math.floor(ballotCounts.length / 2)] : null;
  return {
    runs: ballotCounts.length,
    medianBallots,
    maxBallots: ballotCounts.length ? ballotCounts[ballotCounts.length - 1] : null,
    winners: Object.fromEntries([...winners.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)),
    failures,
  };
}

function runOctoberPerturbation(api) {
  if (!api.initState || !api.runBallot || !api.topPreference || !api.getState) return ["october-1978: perturbation hooks unavailable"];
  const run = (perturb) => {
    api.initState("wojtyla", "october-perturb", { headless: true });
    for (let i = 0; i < 8 && !api.getState().over; i++) {
      if (perturb) {
        for (const id of ["siri", "benelli", "wojtyla", "konig", "krol"]) api.topPreference(id);
      }
      api.runBallot(api.topPreference(api.getState().playerId));
    }
    return JSON.stringify(stable(api.getState().history));
  };
  return run(false) === run(true) ? [] : ["october-1978: rendering/topPreference perturbation changes ballot history"];
}

function runPlayerBallotPreservation(api, label) {
  const failures = [];
  if (label === "october-1978" && api.initState && api.runBallot && api.topPreference && api.getState) {
    api.initState("villot", "october-player-ballot", { headless: true });
    for (let i = 0; i < 6 && !api.getState().over; i++) api.runBallot(api.topPreference(api.getState().playerId));
    if (!api.getState().over) {
      api.runBallot("wojtyla");
      const last = api.getState().history[api.getState().history.length - 1];
      if (!last || last.roll.villot !== "wojtyla") failures.push("october-1978: player vote for Wojtyla was not preserved");
    }
  }
  if (label === "venice-1800" && api.initState && api.conductBallot && api.getState) {
    api.initState("mattei", "venice-player-ballot", { headless: true });
    api.getState().metrics.austrianGrip = 100;
    api.conductBallot("bellisomi");
    const row = api.getState().lastRoll && api.getState().lastRoll.find((item) => item.voter === "mattei");
    if (!row || row.candidate !== "bellisomi") failures.push("venice-1800: player ballot was not preserved through veto pressure");
  }
  return failures;
}

function runViterboApiValidation(api) {
  const failures = [];
  if (!api.initState || !api.beginScrutiny || !api.playerAccede) return ["viterbo-1268: API validation hooks unavailable"];
  const S = api.initState("orsini", "viterbo-api-validation");
  const invalidBallots = [
    ["orsini", "orsini", "bogus"],
    ["bogus"],
    ["annibale", "annibale"],
    ["annibale", "guy", "odo", "fieschi"],
  ];
  for (const ballot of invalidBallots) {
    let threw = false;
    try { api.beginScrutiny(S, ballot); } catch (_) { threw = true; }
    if (!threw) failures.push(`viterbo-1268: invalid ballot accepted: ${JSON.stringify(ballot)}`);
    S.pendingScrutiny = null;
  }
  const blank = api.beginScrutiny(S, []);
  if (!blank || !blank.votes || !Array.isArray(blank.votes.orsini) || blank.votes.orsini.length !== 0) failures.push("viterbo-1268: blank player ballot was not preserved as blank");
  let accedeThrew = false;
  try { api.playerAccede(S, "bogus"); } catch (_) { accedeThrew = true; }
  if (!accedeThrew) failures.push("viterbo-1268: bogus player accessus target accepted");
  return failures;
}

function checkIndexLinks() {
  const index = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const hrefs = [...index.matchAll(/href="\.\/([^"#?]+\.html)"/g)].map((m) => m[1]);
  const missing = hrefs.filter((href) => !fs.existsSync(path.join(ROOT, href)));
  return { hrefs, failures: missing.map((href) => `index link missing file: ${href}`) };
}

function main() {
  const index = checkIndexLinks();
  const report = { profile, seedCount, full, indexLinks: index.hrefs, variants: {} };
  const allFailures = [...index.failures];
  for (const variant of VARIANTS) {
    const abs = path.join(ROOT, variant.file);
    if (!fs.existsSync(abs)) {
      const failure = `${variant.label}: missing file ${variant.file}`;
      report.variants[variant.label] = { failures: [failure] };
      allFailures.push(failure);
      continue;
    }
    let api;
    try {
      api = loadVariant(variant.file);
    } catch (err) {
      const failure = `${variant.label}: load failure: ${err && err.stack || err}`;
      report.variants[variant.label] = { failures: [failure] };
      allFailures.push(failure);
      continue;
    }
    const cards = api.CARDINALS || api.ELECTORS || (api.windowOm && (api.windowOm.CARDINALS || api.windowOm.ELECTORS)) || [];
    const checks = runHeadlessChecks(variant, api);
    const localFailures = [
      ...assertUniqueIds(variant.label, cards),
      ...(checks.failures || []),
    ];
    if (variant.label === "october-1978") localFailures.push(...runOctoberPerturbation(api));
    if (variant.label === "october-1978" || variant.label === "venice-1800") localFailures.push(...runPlayerBallotPreservation(api, variant.label));
    if (variant.label === "viterbo-1268") localFailures.push(...runViterboApiValidation(api));
    checks.failures = localFailures;
    report.variants[variant.label] = checks;
    allFailures.push(...localFailures);
  }
  console.log(JSON.stringify(report, null, 2));
  if (allFailures.length) {
    console.error(`\nHarness failed with ${allFailures.length} issue(s):`);
    allFailures.slice(0, 80).forEach((failure) => console.error(`- ${failure}`));
    process.exit(1);
  }
}

main();
