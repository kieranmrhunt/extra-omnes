#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_SEEDS = 80;
const args = new Map(process.argv.slice(2).map((arg) => {
  const m = arg.match(/^--([^=]+)=(.*)$/);
  return m ? [m[1], m[2]] : [arg.replace(/^--/, ""), true];
}));
const seedCount = Number(args.get("seeds") || DEFAULT_SEEDS);
const full = !!args.get("full");

const VARIANTS = [
  { file: "1492.html", label: "1492", players: ["borgia", "dellarovere", "sforza"] },
  { file: "viterbo-1268.html", label: "viterbo-1268", players: ["orsini", "visconti", "annibaldi"] },
  { file: "carafa-winter-1559.html", label: "carafa-winter-1559", players: ["ccarafa", "medici", "morone"] },
  { file: "venice-1800.html", label: "venice-1800", players: ["bellisomi", "mattei", "chiaramonti"] },
  { file: "october-1978.html", label: "october-1978", players: ["siri", "benelli", "wojtyla"] },
];

function fail(message) {
  throw new Error(message);
}

function htmlScripts(html) {
  return [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => m[1])
    .join("\n");
}

function fakeElement() {
  return {
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    style: {},
    dataset: {},
    value: "",
    checked: false,
    disabled: false,
    appendChild() {},
    append() {},
    addEventListener() {},
    setAttribute() {},
    querySelector() { return fakeElement(); },
    querySelectorAll() { return []; },
    remove() {},
    focus() {},
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
  vm.createContext(context);
  const exportProbe = `
;globalThis.__EO_TEST_EXPORTS__ = {
  runHeadless: typeof runHeadless === "function" ? runHeadless : null,
  initState: typeof initState === "function" ? initState : null,
  runBallot: typeof runBallot === "function" ? runBallot : null,
  conductBallot: typeof conductBallot === "function" ? conductBallot : null,
  topPreference: typeof topPreference === "function" ? topPreference : null,
  getState: typeof OCTOBER_1978_ENGINE !== "undefined" ? OCTOBER_1978_ENGINE.getState : (typeof VENICE_1800_ENGINE !== "undefined" ? VENICE_1800_ENGINE.getState : null),
  beginScrutiny: typeof beginScrutiny === "function" ? beginScrutiny : null,
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

function assertUniqueIds(label, cards) {
  if (!cards || !cards.length) return;
  const ids = cards.map((c) => c.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length) fail(`${label}: duplicate cardinal IDs: ${[...new Set(dupes)].join(", ")}`);
}

function normaliseRun(result) {
  return JSON.stringify(result && {
    winner: result.winner || result.electedId || result.ending && result.ending.electedId || null,
    ballots: result.ballots || result.day || result.turn || null,
    history: result.history || result.scrutinies || result.tallies || null,
  });
}

function votesFromHistory(history) {
  const invalid = [];
  for (const h of history || []) {
    const roll = h.roll || h.votes || null;
    if (!roll) continue;
    const entries = Array.isArray(roll) ? roll.map((item) => [item.voter, item.candidate]) : Object.entries(roll);
    for (const [voter, vote] of entries) {
      const picks = Array.isArray(vote) ? vote : [vote];
      for (const cand of picks) {
        if (cand === voter) invalid.push({ ballot: h.ballot, voter, cand, reason: "self-vote" });
      }
    }
  }
  return invalid;
}

function runHeadlessChecks(variant, api) {
  const runner = api.runHeadless || api.windowOm && api.windowOm.runHeadless;
  if (!runner) return { skipped: "no runHeadless export" };
  const cards = api.CARDINALS || api.ELECTORS || api.windowOm && (api.windowOm.CARDINALS || api.windowOm.ELECTORS) || [];
  const players = full ? cards.map((c) => c.id) : variant.players;
  const winners = new Map();
  let maxBallots = 0;
  let medianSource = [];
  let invalidVotes = 0;
  let thresholdIssues = 0;
  let runtimeErrors = 0;

  for (let s = 0; s < seedCount; s++) {
    for (const player of players) {
      if (cards.length && !cards.some((c) => c.id === player)) continue;
      const seed = `${variant.label}-${s}`;
      let a, b;
      try {
        a = runner(seed, player);
        b = runner(seed, player);
      } catch (err) {
        runtimeErrors++;
        continue;
      }
      if (normaliseRun(a) !== normaliseRun(b)) fail(`${variant.label}: non-deterministic run for seed=${seed}, player=${player}`);
      const winner = a.winner || a.electedId || a.ending && a.ending.electedId || "unresolved";
      winners.set(winner, (winners.get(winner) || 0) + 1);
      const ballots = Number(a.ballots || a.day || a.turn || 0);
      maxBallots = Math.max(maxBallots, ballots);
      medianSource.push(ballots);
      invalidVotes += votesFromHistory(a.history || a.scrutinies).length;
      for (const h of a.history || []) {
        if (h.electors && h.threshold !== Math.ceil(h.electors * 2 / 3)) thresholdIssues++;
      }
    }
  }
  medianSource.sort((a, b) => a - b);
  const medianBallots = medianSource.length ? medianSource[Math.floor(medianSource.length / 2)] : null;
  return {
    runs: medianSource.length,
    runtimeErrors,
    invalidVotes,
    thresholdIssues,
    deadlocked: [...winners.entries()].filter(([id]) => id === "unresolved").reduce((a, [, n]) => a + n, 0),
    medianBallots,
    maxBallots,
    winners: Object.fromEntries([...winners.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)),
  };
}

function runOctoberPerturbation(api) {
  if (!api.initState || !api.runBallot || !api.topPreference || !api.getState) return null;
  const run = (perturb) => {
    api.initState("wojtyla", "october-perturb", { headless: true });
    for (let i = 0; i < 8 && !api.getState().over; i++) {
      if (perturb) {
        for (const id of ["siri", "benelli", "wojtyla", "konig", "krol"]) api.topPreference(id);
      }
      api.runBallot(api.topPreference(api.getState().playerId));
    }
    return JSON.stringify(api.getState().history);
  };
  const plain = run(false);
  const perturbed = run(true);
  if (plain !== perturbed) fail("october-1978: rendering/topPreference perturbation changes ballot history");
  return "passed";
}

function checkIndexLinks() {
  const index = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const hrefs = [...index.matchAll(/href="\.\/([^"#?]+\.html)"/g)].map((m) => m[1]);
  const missing = hrefs.filter((href) => !fs.existsSync(path.join(ROOT, href)));
  if (missing.length) fail(`index links missing files: ${missing.join(", ")}`);
  return hrefs;
}

function main() {
  const indexLinks = checkIndexLinks();
  const report = { seedCount, full, indexLinks, variants: {} };
  for (const variant of VARIANTS) {
    const abs = path.join(ROOT, variant.file);
    if (!fs.existsSync(abs)) {
      report.variants[variant.label] = { missing: true };
      continue;
    }
    const api = loadVariant(variant.file);
    const cards = api.CARDINALS || api.ELECTORS || api.windowOm && (api.windowOm.CARDINALS || api.windowOm.ELECTORS);
    assertUniqueIds(variant.label, cards);
    const checks = runHeadlessChecks(variant, api);
    if (variant.label === "october-1978") checks.perturbation = runOctoberPerturbation(api);
    report.variants[variant.label] = checks;
  }
  console.log(JSON.stringify(report, null, 2));
}

try {
  main();
} catch (err) {
  console.error(err && err.stack || err);
  process.exit(1);
}
