#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const BOOLEAN_ARGS = new Set(["full", "quick"]);
const VALUE_ARGS = new Set(["seeds", "timeout-ms", "worker"]);
const args = new Map();
for (const raw of process.argv.slice(2)) {
	const match = raw.match(/^--([^=]+)(?:=(.*))?$/);
	if (!match) throw new Error(`Invalid argument syntax: ${raw}`);
	const [, name, value] = match;
	if (!BOOLEAN_ARGS.has(name) && !VALUE_ARGS.has(name)) throw new Error(`Unknown option: --${name}`);
	if (args.has(name)) throw new Error(`Duplicate option: --${name}`);
	if (BOOLEAN_ARGS.has(name) && value !== undefined) throw new Error(`--${name} is a flag and does not take a value`);
	if (VALUE_ARGS.has(name) && (value === undefined || value === "")) throw new Error(`--${name} requires a value`);
	args.set(name, BOOLEAN_ARGS.has(name) ? true : value);
}
const full = args.has("full");
const quick = args.has("quick") || (!args.has("seeds") && !full);
if (full && args.has("quick")) throw new Error("--full and --quick cannot be combined");
if (args.has("seeds") && !/^\d+$/.test(args.get("seeds"))) throw new Error("--seeds must be a positive integer");
const seedCount = Number(args.get("seeds") || 1);
if (!Number.isSafeInteger(seedCount) || seedCount < 1) throw new Error("--seeds must be a positive integer");
if (args.has("timeout-ms") && !/^\d+$/.test(args.get("timeout-ms"))) throw new Error("--timeout-ms must be a positive integer");
const requestedTimeoutMs = Number(args.get("timeout-ms") || 0);
if (args.has("timeout-ms") && (!Number.isSafeInteger(requestedTimeoutMs) || requestedTimeoutMs < 1)) throw new Error("--timeout-ms must be a positive integer");
const BLANK_PICK_IDS = new Set(["_blank", "blank"]);

const VARIANTS = [
	{ file: "1492.html", label: "1492", modeLabel: "open simulation", players: ["borgia", "giuliano", "sforza"], quickPlayer: "borgia", maxPicks: () => 3, threshold: (n) => Math.ceil(n * 2 / 3) },
	{ file: "viterbo-1268.html", label: "viterbo-1268", modeLabel: "counterfactual with historical gravity", players: ["orsini", "annibale", "paltanieri"], quickPlayer: "orsini", maxPicks: (ballot) => ballot.turn <= 3 ? 3 : 2, threshold: (n) => Math.ceil(n * 2 / 3) },
	{ file: "carafa-winter-1559.html", label: "carafa-winter-1559", modeLabel: "historical-pressure simulation", players: ["ccarafa", "medici", "morone"], quickPlayer: "medici", maxPicks: () => 3, threshold: (n) => Math.ceil(n * 2 / 3) },
	{ file: "venice-1800.html", label: "venice-1800", modeLabel: "historical-pressure simulation", players: ["bellisomi", "mattei", "chiaramonti"], quickPlayer: "chiaramonti", maxPicks: () => 1, threshold: (n) => Math.ceil(n * 2 / 3) },
	{ file: "1903.html", label: "1903", modeLabel: "historical", players: ["rampolla", "sarto", "gibbons"], quickPlayer: "sarto", maxPicks: () => 1, threshold: (n) => Math.ceil(n * 2 / 3) },
	{ file: "october-1978.html", label: "october-1978", modeLabel: "historical pressure with active player", players: ["siri", "benelli", "wojtyla"], quickPlayer: "wojtyla", maxPicks: () => 1, threshold: (n) => Math.floor(n * 2 / 3) + 1 },
	{ file: "may-2025.html", label: "may-2025", modeLabel: "historical reconstruction with open counterfactual play", players: ["parolin", "prevost", "tagle"], quickPlayer: "prevost", maxPicks: () => 1, threshold: (n) => Math.ceil(n * 2 / 3) },
	{ file: "constance-1417.html", label: "constance-1417", modeLabel: "historical", players: ["colonna", "dailly", "polton"], quickPlayer: "colonna", maxPicks: () => 3, threshold: (n) => Math.ceil(n * 2 / 3) },
	{ file: "accession-1458.html", label: "accession-1458", modeLabel: "open simulation", players: ["piccolomini", "estouteville", "borgia"], quickPlayer: "piccolomini", maxPicks: () => 1, threshold: (n) => Math.ceil(n * 2 / 3) },
	{ file: "april-1378.html", label: "april-1378", modeLabel: "open simulation", players: ["deluna", "orsini", "geneva"], quickPlayer: "deluna", maxPicks: () => 1, threshold: (n) => Math.ceil(n * 2 / 3) },
];

function fail(message) {
	throw new Error(message);
}

function assert(condition, message) {
	if (!condition) fail(message);
}

function htmlScripts(html) {
	return [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
		.map((match) => match[1])
		.join("\n");
}

function fakeElement() {
	const attributes = new Map();
	let textValue = "";
	let htmlValue = "";
	const element = {
		nodeType: 1,
		className: "",
		children: [],
		parentNode: null,
		classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
		style: { setProperty(name, value) { this[name] = String(value); } },
		dataset: {},
		value: "",
		checked: false,
		disabled: false,
		tabIndex: 0,
		offsetParent: {},
		appendChild(child) { if (child) { child.parentNode = this; this.children.push(child); } return child; },
		append(...children) { children.forEach((child) => this.appendChild(child)); },
		prepend(...children) { children.reverse().forEach((child) => { if (child) { child.parentNode = this; this.children.unshift(child); } }); },
		addEventListener() {},
		removeEventListener() {},
		setAttribute(name, value) { attributes.set(name, String(value)); },
		getAttribute(name) { return attributes.get(name) || null; },
		querySelector() { return fakeElement(); },
		querySelectorAll() { return []; },
		remove() { this.parentNode = null; },
		focus() {},
		click() {},
		get textContent() { return textValue; },
		set textContent(value) { textValue = String(value); this.children = []; },
		get innerHTML() { return htmlValue; },
		set innerHTML(value) { htmlValue = String(value); this.children = []; },
	};
	return element;
}

function loadVariant(file) {
	const abs = path.join(ROOT, file);
	const html = fs.readFileSync(abs, "utf8");
	const script = htmlScripts(html);
	const moduleObject = { exports: {} };
	const readyCallbacks = [];
	const elements = new Map();
	const elementFor = (selector) => {
		if (!elements.has(selector)) elements.set(selector, fakeElement());
		return elements.get(selector);
	};
	const context = {
		console,
		module: moduleObject,
		exports: moduleObject.exports,
		window: {},
		location: { search: "", href: `https://example.invalid/${file}`, reload() {} },
		document: {
			readyState: "loading",
			body: elementFor("body"),
			activeElement: null,
			addEventListener(event, callback) { if (event === "DOMContentLoaded" && typeof callback === "function") readyCallbacks.push(callback); },
			removeEventListener() {},
			contains() { return true; },
			getElementById(id) { return elementFor(`#${id}`); },
			querySelector(selector) { return elementFor(selector); },
			querySelectorAll() { return []; },
			createElement() { return fakeElement(); },
			createTextNode(text) { return { nodeType: 3, textContent: String(text), parentNode: null }; },
		},
		localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
		setTimeout,
		clearTimeout,
		requestAnimationFrame(callback) { return setTimeout(callback, 0); },
		cancelAnimationFrame: clearTimeout,
		URL,
		URLSearchParams,
		Blob: function Blob() {},
		btoa(value) { return Buffer.from(String(value), "binary").toString("base64"); },
		atob(value) { return Buffer.from(String(value), "base64").toString("binary"); },
		escape,
		unescape,
	};
	vm.createContext(context);
	const exportProbe = `
;globalThis.__EO_TEST_EXPORTS__ = {
	runHeadless: typeof runHeadless === "function" ? runHeadless : null,
	initState: typeof initState === "function" ? initState : null,
	beginScrutiny: typeof beginScrutiny === "function" ? beginScrutiny : null,
	playerAccede: typeof playerAccede === "function" ? playerAccede : null,
	runBallot: typeof runBallot === "function" ? runBallot : null,
	conductBallot: typeof conductBallot === "function" ? conductBallot : null,
	simulateBallot: typeof simulateBallot === "function" ? simulateBallot : null,
	makeSounding: typeof makeSounding === "function" ? makeSounding : null,
	playerNetworks: typeof playerNetworks === "function" ? playerNetworks : null,
	networkAccess: typeof networkAccess === "function" ? networkAccess : null,
	portraitFor: typeof portraitFor === "function" ? portraitFor : null,
	resolveNetworkAction: typeof resolveNetworkAction === "function" ? resolveNetworkAction : null,
	actionRouteCopy: typeof actionRouteCopy === "function" ? actionRouteCopy : null,
	axisPosition: typeof axisPosition === "function" ? axisPosition : null,
	scoreGame: typeof scoreGame === "function" ? scoreGame : null,
	topPreference: typeof topPreference === "function" ? topPreference : null,
	getState: typeof OCTOBER_1978_ENGINE !== "undefined" ? OCTOBER_1978_ENGINE.getState : (typeof VENICE_1800_ENGINE !== "undefined" ? VENICE_1800_ENGINE.getState : (typeof CARAFA_1559_ENGINE !== "undefined" ? CARAFA_1559_ENGINE.getState : null)),
	activeElectors: typeof activeElectors === "function" ? activeElectors : null,
	threshold: typeof threshold === "function" ? threshold : null,
	THRESHOLD: typeof THRESHOLD !== "undefined" ? THRESHOLD : null,
	legalCandidateFor: typeof legalCandidateFor === "function" ? legalCandidateFor : null,
	ELECTORS: typeof ELECTORS !== "undefined" ? ELECTORS : null,
	CARDINALS: typeof CARDINALS !== "undefined" ? CARDINALS : null,
	ID: typeof ID !== "undefined" ? ID : null,
	byId: typeof byId !== "undefined" ? byId : null,
	OUTSIDERS: typeof OUTSIDERS !== "undefined" ? OUTSIDERS : null,
	windowOm: typeof window !== "undefined" ? window.__om : null
	};`;
	vm.runInContext(script + exportProbe, context, { filename: file, timeout: 10000 });
	for (const callback of readyCallbacks) callback();
	const selectionGrid = elements.get("#selgrid") || elements.get("#pickgrid");
	const renderedCards = selectionGrid ? Math.max(selectionGrid.children.length, (selectionGrid.innerHTML.match(/<(?:button|article|div)\b/gi) || []).length) : 0;
	if (!renderedCards) throw new Error(`${file}: UI bootstrap rendered no selection cards`);
	return Object.assign({ __uiBooted: true, __uiCardsRendered: renderedCards }, context.__EO_TEST_EXPORTS__, moduleObject.exports || {}, context.__om1903 || {}, context.window.__om || {});
}

function loadEngineWithoutDom(file) {
	const html = fs.readFileSync(path.join(ROOT, file), "utf8");
	const moduleObject = { exports: {} };
	const context = { console, module: moduleObject, exports: moduleObject.exports, setTimeout, clearTimeout, URL, URLSearchParams };
	vm.createContext(context);
	vm.runInContext(htmlScripts(html), context, { filename: file, timeout: 10000 });
	return moduleObject.exports;
}

function cardList(api) {
	return api.CARDINALS || api.ELECTORS || api.windowOm && (api.windowOm.CARDINALS || api.windowOm.ELECTORS) || [];
}

function knownCandidateIds(api) {
	const ids = new Set(cardList(api).map((card) => card.id));
	Object.keys(api.OUTSIDERS || {}).forEach((id) => ids.add(id));
	return ids;
}

function electorIds(api) {
	return new Set(cardList(api).map((card) => card.id));
}

function assertUniqueIds(label, cards) {
	assert(cards && cards.length, `${label}: no cardinal roster was exported`);
	const ids = cards.map((card) => card.id);
	const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
	assert(!duplicates.length, `${label}: duplicate cardinal IDs: ${[...new Set(duplicates)].join(", ")}`);
}

function historyOf(result) {
	return result && (result.history || result.scrutinies || result.tallies) || [];
}

function voteEntries(ballot) {
	const roll = ballot && (ballot.roll || ballot.votes);
	if (!roll) return [];
	if (Array.isArray(roll)) {
		return roll.map((entry) => [entry.voter, Array.isArray(entry.candidate) ? entry.candidate : [entry.candidate]]);
	}
	return Object.entries(roll).map(([voter, picks]) => [voter, Array.isArray(picks) ? picks : [picks]]);
}

function assertBallotIntegrity(variant, api, ballot) {
	const known = electorIds(api);
	const eligible = knownCandidateIds(api);
	const entries = voteEntries(ballot);
	assert(entries.length, `${variant.label}: ballot ${ballot.ballot || ballot.number || "?"} has no vote roll`);
	const voters = new Set();
	const directVotes = new Map();
	const calculated = {};
	const maxPicks = variant.maxPicks(ballot);
	for (const [voter, picks] of entries) {
		assert(known.has(voter), `${variant.label}: unknown voter ${voter} in ballot ${ballot.ballot || ballot.number || "?"}`);
		assert(!voters.has(voter), `${variant.label}: duplicate voter ${voter}`);
		voters.add(voter);
		assert(picks.length <= maxPicks, `${variant.label}: ${voter} supplied ${picks.length} names; maximum is ${maxPicks}`);
		assert(new Set(picks).size === picks.length, `${variant.label}: duplicate approval name from ${voter}`);
		directVotes.set(voter, picks);
		for (const candidate of picks) {
			assert(eligible.has(candidate) || BLANK_PICK_IDS.has(candidate), `${variant.label}: unknown candidate ${candidate}`);
			assert(candidate !== voter || BLANK_PICK_IDS.has(candidate), `${variant.label}: self-vote by ${voter}`);
			calculated[candidate] = (calculated[candidate] || 0) + 1;
		}
	}
	const accessionSenders = new Set();
	for (const accession of ballot.accessions || []) {
		assert(known.has(accession.from) && eligible.has(accession.to), `${variant.label}: invalid accession target`);
		assert(voters.has(accession.from), `${variant.label}: accession by an elector absent from the scrutiny roll`);
		assert(!accessionSenders.has(accession.from), `${variant.label}: multiple accessions by ${accession.from}`);
		assert(accession.from !== accession.to, `${variant.label}: self-accession by ${accession.from}`);
		assert(!directVotes.get(accession.from).includes(accession.to), `${variant.label}: ${accession.from} acceded to a name already on his ballot`);
		accessionSenders.add(accession.from);
		calculated[accession.to] = (calculated[accession.to] || 0) + 1;
	}
	if (Number.isInteger(ballot.electors)) {
		assert(entries.length === ballot.electors, `${variant.label}: ${entries.length} recorded voters but electorate is ${ballot.electors}`);
	}
	if (Number.isInteger(ballot.electors) && Number.isInteger(ballot.threshold)) {
		assert(ballot.threshold === variant.threshold(ballot.electors), `${variant.label}: threshold ${ballot.threshold} is wrong for ${ballot.electors} electors`);
	}
	const recorded = ballot.counts || ballot.final || ballot.running;
	assert(recorded && typeof recorded === "object" && !Array.isArray(recorded), `${variant.label}: ballot has no recorded tally`);
	for (const [id, count] of Object.entries(recorded)) {
		assert((eligible.has(id) || BLANK_PICK_IDS.has(id)) && Number.isInteger(count) && count >= 0, `${variant.label}: invalid recorded tally for ${id}`);
	}
	for (const id of new Set([...Object.keys(recorded), ...Object.keys(calculated)])) {
		assert(Number(recorded[id] || 0) === Number(calculated[id] || 0), `${variant.label}: tally mismatch for ${id}`);
	}
}

function winnerOf(result) {
	return result && (result.winner || result.electedId || result.ending && result.ending.electedId) || null;
}

function expectRejected(label, fn) {
	let rejected = false;
	try {
		const result = fn();
		rejected = result === false || result && (result.ok === false || result.error);
	} catch (_) {
		rejected = true;
	}
	assert(rejected, label);
}

function runTargetedChecks(variant, api) {
	if (variant.label === "1492") {
		assert(typeof api.initState === "function" && typeof api.beginScrutiny === "function", "1492: validation API is not exported");
		const nodeEngine = loadEngineWithoutDom("1492.html");
		assert(nodeEngine && typeof nodeEngine.runHeadless === "function" && Array.isArray(nodeEngine.CARDINALS), "1492: the Node module boundary still requires DOM shims");
		const saveState = nodeEngine.initState("borgia", "1492-save", "open", []);
		nodeEngine.beginScrutiny(saveState, ["carafa"]);
		nodeEngine.finalizeScrutiny(saveState);
		const validSave = JSON.parse(JSON.stringify(Object.assign({}, saveState, { saveVersion: 2, rngState: saveState.rng.state, rng: undefined, queue: [] })));
		assert(typeof nodeEngine.validateSavedState === "function" && nodeEngine.validateSavedState(validSave), "1492: a valid saved conclave cannot be restored");
		const invalidSave = JSON.parse(JSON.stringify(validSave));
		invalidSave.cards.borgia.intel = 99;
		assert(!nodeEngine.validateSavedState(invalidSave), "1492: a corrupt cardinal record was accepted from a save");
		const state = api.initState("borgia", "1492-validation", "open", []);
		const ballot = api.beginScrutiny(state, ["carafa", "carafa", "borgia", "not-a-cardinal"]);
		assert(JSON.stringify(ballot.votes.borgia) === JSON.stringify(["carafa"]), "1492: player approvals were not deduplicated and validated");
		const presentationState = api.initState("borgia", "1492-presentation", "open", []);
		const rngBefore = presentationState.rng.state;
		const oddsFirst = JSON.stringify(api.marketOdds(presentationState));
		const oddsSecond = JSON.stringify(api.marketOdds(presentationState));
		assert(oddsFirst === oddsSecond && presentationState.rng.state === rngBefore, "1492: opening the market changed the simulation RNG");
		const compromiseState = api.initState("borgia", "1492-compromissum", "open", []);
		const compromiseWinner = api.compromissum(compromiseState);
		const procedure = compromiseState.terminalProcedure;
		assert(compromiseState.over && compromiseWinner === compromiseState.electedId && procedure && procedure.type === "compromissum", "1492: compromissum did not create a terminal procedure record");
		assert(procedure.committee.length === 3 && procedure.votes.length === 3 && procedure.unanimous && procedure.votes.every((vote) => procedure.committee.includes(vote.voter) && vote.candidate === compromiseWinner), "1492: compromissum is not auditable to a unanimous three-cardinal committee");
		const seriesScore = api.seriesScoreForVerdict(api.roleVerdict(350, "pope"));
		assert(Number.isInteger(seriesScore) && seriesScore >= 0 && seriesScore <= 100, "1492: comparable series score is invalid");
		return ["node-module-boundary", "strict-save", "approval-validation", "presentation-rng", "auditable-compromissum", "series-score"];
	}
	if (variant.label === "viterbo-1268") {
		assert(typeof api.initState === "function" && typeof api.beginScrutiny === "function" && typeof api.playerAccede === "function" && typeof api.canVote === "function" && typeof api.canBeElected === "function", "Viterbo: validation API is not exported");
		let state = api.initState("orsini", "viterbo-blank", []);
		let ballot = api.beginScrutiny(state, []);
		assert(Array.isArray(ballot.votes.orsini) && ballot.votes.orsini.length === 0, "Viterbo: an explicit blank ballot became an AI ballot");
		state = api.initState("orsini", "viterbo-invalid", []);
		expectRejected("Viterbo: invalid/duplicate/self ballot was accepted", () => api.beginScrutiny(state, ["orsini", "orsini", "bogus"]));
		state = api.initState("orsini", "viterbo-accessus", []);
		api.beginScrutiny(state, []);
		expectRejected("Viterbo: bogus accession was accepted", () => api.playerAccede(state, "bogus"));
		state = api.initState("orsini", "viterbo-illness", []);
		state.cards.paltanieri.ill = true;
		assert(!api.canVote(state, "paltanieri") && api.canBeElected(state, "paltanieri"), "Viterbo: illness did not remove the vote while preserving canonical eligibility");
		assert(api.REGNAL_HINT && api.REGNAL_NUM && api.REGNAL_HINT.guy === "Eugene" && api.REGNAL_NUM.Eugene === "IV" && api.REGNAL_HINT.goffredo === "Callistus" && api.REGNAL_NUM.Callistus === "III", "Viterbo: corrected regnal names are not exported or do not agree");
		const openWinners = new Set(Array.from({ length: 20 }, (_, index) => api.runHeadless(`viterbo-open-balance-${index}`, "orsini", [], {}).electedId));
		assert(openWinners.size >= 2 && [...openWinners].some((winner) => winner !== "visconti"), "Viterbo: counterfactual mode has reverted to a compulsory Visconti victory");
		const chronicleWinners = Array.from({ length: 3 }, (_, index) => api.runHeadless(`viterbo-chronicle-${index}`, "orsini", [], { historicalMode: true }).electedId);
		assert(chronicleWinners.every((winner) => winner === "visconti"), "Viterbo: strict chronicle mode no longer preserves the historical committee choice");
		const seriesScore = api.seriesScoreForVerdict(api.roleVerdict(300, "pope"));
		assert(Number.isInteger(seriesScore) && seriesScore >= 0 && seriesScore <= 100, "Viterbo: comparable series score is invalid");
		return ["blank-ballot", "approval-validation", "accessus-validation", "illness-eligibility", "regnal-names", "counterfactual-variety", "strict-chronicle-anchor", "series-score"];
	}
	if (variant.label === "carafa-winter-1559") {
		assert(typeof api.initState === "function" && typeof api.beginScrutiny === "function" && typeof api.playerAccede === "function" && typeof api.getState === "function" && typeof api.makeSounding1559 === "function" && typeof api.refineSounding1559 === "function" && typeof api.moroneVindication1559 === "function" && typeof api.resolveCaucus1559 === "function" && typeof api.resolveSupportDirection1559 === "function" && typeof api.acclamationReadiness1559 === "function" && typeof api.ceremonyOrder1559 === "function" && typeof api.regnalOptions1559 === "function" && typeof api.portraitFor1559 === "function", "Carafa Winter: targeted-test API is not exported");
		const portraitIds = ["medici", "tournon", "carpi", "morone", "gonzaga", "pacheco", "afarnese", "deste", "madruzzo", "ghislieri", "sforza"];
		const portraitAttribution = JSON.parse(fs.readFileSync(path.join(ROOT, "assets", "portraits", "attribution.json"), "utf8")).portraits;
		const portraitAudit = portraitIds.map((id) => {
			const portrait = api.portraitFor1559(id);
			const localPath = portrait && path.join(ROOT, portrait.src);
			return { id, portrait, localPath, attribution: portraitAttribution[`1559/${id}.webp`], bytes: localPath && fs.existsSync(localPath) ? fs.statSync(localPath).size : 0 };
		});
		const invalidPortraits = portraitAudit.filter(({ portrait, localPath, attribution, bytes }) => !portrait || !/assets\/portraits\/1559\/[a-z]+\.webp$/.test(portrait.src) || !/en\.wikipedia\.org/.test(portrait.wikipedia || "") || "source" in portrait || !fs.existsSync(localPath) || bytes <= 0 || bytes > 60000 || !attribution?.commons_file || !/^https:\/\/commons\.wikimedia\.org\//.test(attribution.source || "") || !attribution.license);
		assert(invalidPortraits.length === 0 && portraitAudit.reduce((sum, portrait) => sum + portrait.bytes, 0) < 260000 && api.portraitFor1559("cesi") === null, `Carafa Winter: missing, oversized, unattributed, or invalid portraits for ${invalidPortraits.map(({ id }) => id).join(", ")}`);
		let state = api.initState("medici", "carafa-opening", { headless: true });
		assert(api.present().length === 40 && api.voters().length === 40 && api.threshold() === 27, "Carafa Winter: opening attendance or threshold is wrong");
		const metricKeys = ["heat", "taint", "integrity", "security", "carafaPeril"];
		assert(metricKeys.every((key) => { const detail = api.metricDetail1559(key); return detail && detail.key === key && Number.isFinite(detail.value) && detail.direction && detail.effect; }), "Carafa Winter: a political-risk meter lacks a usable explanation");
		const factions = ["carafa", "france", "spain", "farnese", "italian", "reform"].map((bloc) => api.factionSnapshot1559(bloc));
		assert(factions.reduce((sum, faction) => sum + faction.members.length, 0) === api.voters().length && factions.every((faction) => !faction.leader || api.ELECTORS.some((cardinal) => cardinal.id === faction.leader)), "Carafa Winter: faction pulse does not cover the active electorate");
		const soundingRng = state.rng.state;
		const soundingA = api.makeSounding1559();
		assert(state.rng.state === soundingRng && soundingA.rows.length && soundingA.rows.every((row) => row.low >= 0 && row.high >= row.low && row.high <= api.ELECTORS.length), "Carafa Winter: opening soundings consume ballot randomness or contain invalid ranges");
		const soundingStateB = api.initState("medici", "carafa-opening", { headless: true });
		const soundingB = api.makeSounding1559();
		assert(JSON.stringify(soundingA) === JSON.stringify(soundingB) && soundingStateB.rng.state === soundingRng, "Carafa Winter: soundings are not seed-deterministic");
		soundingStateB.lastSounding = soundingB;
		soundingStateB.cards.tournon.intel = 1;
		const refinementRng = soundingStateB.rng.state;
		const refined = api.refineSounding1559("tournon", "carpi"), refinedRow = refined.rows.find((row) => row.id === "carpi");
		assert(refined === soundingStateB.lastSounding && refinedRow?.refined && refinedRow.refinedBy.includes("tournon") && refinedRow.high - refinedRow.low <= 4 && refined.refinedBy.includes("tournon") && !refined.stale && soundingStateB.rng.state === refinementRng, "Carafa Winter: a colloquy does not narrow the standing sounding deterministically");
		const readinessRng = soundingStateB.rng.state;
		const readiness = api.acclamationReadiness1559("medici");
		assert(readiness.low <= readiness.high && readiness.high < api.voters().length && readiness.need === api.threshold() && soundingStateB.rng.state === readinessRng, "Carafa Winter: acclamation readiness is invalid or consumes election randomness");
		let ballot = api.beginScrutiny([]);
		assert(Array.isArray(ballot.votes.medici) && ballot.votes.medici.length === 0, "Carafa Winter: an explicit blank ballot became an AI ballot");
		assert(Object.entries(ballot.votes).filter(([voter]) => voter !== "medici").every(([, picks]) => picks.length > 0), "Carafa Winter: an ordinary AI elector submitted a blank cedula");
		const presentationRng = soundingStateB.rng.state;
		const ceremonyA = api.ceremonyOrder1559(ballot), ceremonyB = api.ceremonyOrder1559(ballot), rollVoters = Object.keys(ballot.votes);
		assert(JSON.stringify(ceremonyA) === JSON.stringify(ceremonyB) && soundingStateB.rng.state === presentationRng && ceremonyA.length === rollVoters.length && new Set(ceremonyA.map((entry) => entry.voter)).size === rollVoters.length && JSON.stringify(ceremonyA.map((entry) => entry.voter)) !== JSON.stringify(rollVoters), "Carafa Winter: scrutiny presentation is ranked, incomplete, non-deterministic, or consumes election randomness");
		expectRejected("Carafa Winter: a duplicate ballot was accepted", () => api.beginScrutiny(["cesi", "cesi"]));
		expectRejected("Carafa Winter: a self-vote was accepted", () => api.beginScrutiny(["medici"]));
		expectRejected("Carafa Winter: an unknown candidate was accepted", () => api.beginScrutiny(["bogus"]));
		expectRejected("Carafa Winter: an unknown accessus target was accepted", () => api.playerAccede(ballot, "bogus"));

		state = api.initState("medici", "carafa-illness", { headless: true });
		state.cards.medici.ill = true;
		assert(!api.canVote("medici") && api.canBeElected("medici"), "Carafa Winter: illness did not remove the vote while preserving canonical eligibility");
		state.heat = Infinity;
		state.integrity = -10;
		state.taint = NaN;
		state.security = 140;
		state.carafaPeril = -1;
		state.cash = -500;
		api.normaliseState();
		assert(["heat", "integrity", "taint", "security", "carafaPeril"].every((key) => Number.isFinite(state[key]) && state[key] >= 0 && state[key] <= 100) && state.cash === 0, "Carafa Winter: state normalisation left an invalid metric");

		state = api.initState("medici", "carafa-attendance", { headless: true });
		for (let stage = 1; stage <= 9; stage++) {
			state.stage = stage;
			api.applyHistoricalAttendance();
		}
		assert(api.present().length === 44 && api.voters().length === 44 && api.threshold() === 30, "Carafa Winter: final attendance or threshold is wrong");
		assert(state.cards.capodiferro.dead && !api.canBeElected("capodiferro"), "Carafa Winter: Capodiferro remains eligible after death");
		assert(!api.canVote("dubellay") && api.canBeElected("dubellay"), "Carafa Winter: du Bellay's departure was not represented correctly");
		const bishops = api.ELECTORS.filter((cardinal) => cardinal.order === "B");
		assert(bishops.map((cardinal) => cardinal.id).join(",") === "dubellay,tournon,carpi,pisani,cesi,pacheco", `Carafa Winter: cardinal-bishop roster is ${bishops.map((cardinal) => cardinal.id).join(",")}`);
		assert(bishops.every((cardinal) => /Ostia e Velletri|Sabina|Porto e Santa Rufina|Frascati|Palestrina|Albano/.test(cardinal.title)) && api.ELECTORS.find((cardinal) => cardinal.id === "gonzaga").order === "P" && api.ELECTORS.find((cardinal) => cardinal.id === "caetani").order === "P", "Carafa Winter: corrected suburbicarian titles or priestly orders are missing");
		const caucusA = api.initState("medici", "carafa-caucus", { headless: true });
		const caucusResultA = api.resolveCaucus1559("italian", "medici");
		const caucusStateA = JSON.stringify(caucusA), caucusRngA = caucusA.rng.state;
		const caucusB = api.initState("medici", "carafa-caucus", { headless: true });
		const caucusResultB = api.resolveCaucus1559("italian", "medici");
		assert(JSON.stringify(caucusResultA) === JSON.stringify(caucusResultB) && JSON.stringify(caucusB) === caucusStateA && caucusB.rng.state === caucusRngA && caucusResultA.moved.length > 0, "Carafa Winter: faction caucus is ineffective or non-deterministic");
		state = api.initState("medici", "carafa-release", { headless: true });
		state.scrutinies.push({ votes: { ccarafa: ["medici"], afarnese: ["medici"], sforza: ["medici"] } });
		state.lastFinal = { medici: 3 };
		assert(api.supportersForPlayer1559().length === 3, "Carafa Winter: latest adherents cannot be identified for a public direction");
		const direction = api.resolveSupportDirection1559("afarnese");
		assert(direction.supporters === 3 && direction.accepted + direction.rejected === 3 && direction.rejected >= 1 && state.cards.afarnese.playerDirection === null, "Carafa Winter: released support is forced, incomplete, or permits a self-vote instruction");
		state = api.initState("medici", "carafa-save", { headless: true });
		const saved = JSON.parse(JSON.stringify(api.serialiseState()));
		assert(api.validateSavedState(saved), "Carafa Winter: a valid versioned save cannot be restored");
		const corrupt = JSON.parse(JSON.stringify(saved));
		corrupt.cards.medici.dead = "certainly";
		assert(!api.validateSavedState(corrupt), "Carafa Winter: a corrupt save was accepted");
		const corruptDirection = JSON.parse(JSON.stringify(saved));
		corruptDirection.cards.medici.playerDirection = "medici";
		corruptDirection.cards.medici.playerDirectionBallot = 1;
		assert(!api.validateSavedState(corruptDirection), "Carafa Winter: a corrupt supporter direction was accepted");
		state = api.initState("tournon", "carafa-christmas-name", { headless: true });
		state.stage = 9;
		assert(api.feastDay1559() && api.regnalOptions1559("tournon").includes("Emmanuel I"), "Carafa Winter: a Tournon victory during the Christmas settlement has no feast-day regnal option");
		state.stage = 8;
		assert(!api.feastDay1559() && !api.regnalOptions1559("tournon").includes("Emmanuel I"), "Carafa Winter: the Christmas regnal option is available before the Christmas settlement");
		state = api.initState("morone", "carafa-vindication", { headless: true });
		state.taint = 12; state.lastFinal = { morone: 6 }; state.scrutinies = [{ threshold: 30 }]; state.electedId = "medici";
		assert(api.moroneVindication1559().done, "Carafa Winter: Morone cannot fulfil the documented public-vindication route");
		state.lastFinal.morone = 5;
		assert(!api.moroneVindication1559().done, "Carafa Winter: Morone is vindicated without the stated public support");
		state.lastFinal.morone = 6; state.electedId = "ghislieri";
		assert(!api.moroneVindication1559().done, "Carafa Winter: a Holy Office settlement incorrectly vindicates Morone");
		assert([api.seriesScore1559("pope", 250), api.seriesScore1559("kingmaker", 150), api.seriesScore1559("survivor", 50)].every((score) => Number.isInteger(score) && score >= 0 && score <= 100), "Carafa Winter: comparable series score is invalid");
		return ["attendance-40-to-44", "approval-validation", "accessus-validation", "illness-eligibility", "metric-bounds", "risk-explanations", "faction-pulse", "uncertain-soundings", "colloquy-refines-soundings", "ordinary-cedula-participation", "acclamation-readiness", "deterministic-caucus", "consent-based-support-direction", "procedural-cedula-order", "Morone-vindication-route", "winner-portrait-coverage", "Christmas-regnal-choice", "six-cardinal-bishops", "versioned-save", "series-score"];
	}
	if (variant.label === "1903") {
		assert(typeof api.initState === "function" && typeof api.makeSounding === "function" && typeof api.playerNetworks === "function" && typeof api.networkAccess === "function" && typeof api.resolveNetworkAction === "function" && typeof api.actionRouteCopy === "function" && typeof api.portraitFor === "function" && typeof api.alignmentWithPlayer === "function" && typeof api.currentProgrammeFit === "function" && typeof api.pressureMetricDetail === "function" && typeof api.metricLogAdjustment === "function" && typeof api.resolveColloquyReading === "function" && typeof api.resolveColloquyPressure === "function" && typeof api.resolveSupportDirective === "function" && typeof api.scoreGame === "function", "1903: revised information/network/portrait/pressure/colloquy/score API is not exported");
		const portrait = api.portraitFor("gibbons");
		assert(portrait && /assets\/portraits\/1903\/gibbons\.webp$/.test(portrait.src) && /en\.wikipedia\.org/.test(portrait.wikipedia) && !("source" in portrait) && api.portraitFor("sanminiatelli") === null, "1903: portrait link or fallback is invalid");
		let state = api.initState("gibbons", "1903-soundings", "historical");
		const alignment = api.alignmentWithPlayer(state, "sarto");
		assert(alignment && Number.isInteger(alignment.score) && alignment.score >= 0 && alignment.score <= 100 && Number.isInteger(alignment.currentScore) && alignment.label && Array.isArray(alignment.shared), "1903: cardinal alignment detail is invalid");
		const affinityState = api.initState("oreglia", "1903-stable-affinity", "historical");
		const affinityBefore = api.alignmentWithPlayer(affinityState, "gotti");
		affinityState.profileMods.gotti = { continuity: 1.2, government: -1.2, freedom: 1.1, programme: 1.2 };
		const affinityAfter = api.alignmentWithPlayer(affinityState, "gotti");
		assert(affinityAfter.score === affinityBefore.score && affinityAfter.currentScore !== affinityBefore.currentScore, "1903: baseline affinity moves with a candidate's programme or current programme fit is not exposed separately");
		const pressureKeys = ["freedom", "courtPressure", "pastoralAppetite", "continuity", "curialConfidence"];
		assert(pressureKeys.every((key) => {
			const detail = api.pressureMetricDetail(key, state);
			return detail && detail.label && Number.isInteger(detail.value) && detail.level && detail.definition && detail.direction && detail.opening && detail.effect && Array.isArray(detail.changes);
		}), "1903: pressure explanations are incomplete");
		const pressureState = api.initState("gibbons", "1903-pressure-ledger", "historical");
		api.resolveVeto(pressureState, "deliver");
		assert(api.pressureMetricDetail("freedom", pressureState).changes.some((change) => /Puzyna/.test(change.reason)), "1903: pressure ledger does not explain the current value");
		const historicalPressure = api.initState("gibbons", "1903-pressure-effect", "historical");
		const openPressure = api.initState("gibbons", "1903-pressure-effect", "open");
		historicalPressure.metrics.freedom = openPressure.metrics.freedom = 100;
		const historicalAdjustment = api.metricLogAdjustment(historicalPressure, "rampolla");
		const openAdjustment = api.metricLogAdjustment(openPressure, "rampolla");
		assert(Math.abs(historicalAdjustment) > 0 && Math.abs(openAdjustment) > Math.abs(historicalAdjustment) && Math.abs(historicalAdjustment / openAdjustment - 0.35) < 0.001, "1903: College pressures do not bend historical mode at the documented reduced strength");
		const before = JSON.stringify(state);
		const soundingA = api.makeSounding(state);
		const soundingB = api.makeSounding(state);
		assert(JSON.stringify(soundingA) === JSON.stringify(soundingB) && JSON.stringify(state) === before, "1903: soundings are non-deterministic or mutate simulation state");
		assert(soundingA.rows.length > 0 && soundingA.rows.every((row) => Number.isInteger(row.low) && Number.isInteger(row.high) && row.low < row.high && !("count" in row)), "1903: soundings expose exact counts or invalid ranges");
		const routeState = api.initState("gibbons", "1903-route-copy", "open");
		assert(api.actionRouteCopy(routeState).label === "Broker a compromise" && /more trust/.test(api.actionRouteCopy(routeState).subtitle), "1903: opening promotion/compromise distinction is missing");
		routeState.ballotNo = 2;
		assert(api.actionRouteCopy(routeState).label === "Work the transfer", "1903: transfer-phase action copy is incorrect");
		routeState.flags.sartoCrisis = true;
		routeState.flags.sartoConsent = false;
		assert(api.actionRouteCopy(routeState).label === "Seek Sarto’s consent", "1903: Sarto-consent action copy is incorrect");
		const networks = api.playerNetworks(state);
		assert(networks.includes("Diocesan") && networks.includes("Independent"), "1903: the player's modelled networks are incomplete");
		assert(api.networkAccess(state, "Diocesan") > api.networkAccess(state, "Curia"), "1903: membership does not improve network access");
		const firstNetworkState = api.initState("gibbons", "1903-network", "open");
		const secondNetworkState = api.initState("gibbons", "1903-network", "open");
		const firstOutcome = api.resolveNetworkAction(firstNetworkState, "Diocesan", "sarto");
		const secondOutcome = api.resolveNetworkAction(secondNetworkState, "Diocesan", "sarto");
		assert(JSON.stringify(firstOutcome) === JSON.stringify(secondOutcome) && JSON.stringify(firstNetworkState) === JSON.stringify(secondNetworkState), "1903: network action is not seed-deterministic");
		const firstColloquyState = api.initState("gibbons", "1903-colloquy", "open");
		const secondColloquyState = api.initState("gibbons", "1903-colloquy", "open");
		const firstReading = api.resolveColloquyReading(firstColloquyState, "gotti");
		const secondReading = api.resolveColloquyReading(secondColloquyState, "gotti");
		assert(JSON.stringify(firstReading) === JSON.stringify(secondReading) && JSON.stringify(firstColloquyState) === JSON.stringify(secondColloquyState) && firstReading.cluster.every((id) => api.ELECTORS.some((cardinal) => cardinal.id === id) && id !== "gotti"), "1903: private colloquy reading is invalid or non-deterministic");
		const firstPressure = api.resolveColloquyPressure(firstColloquyState, "gotti", "sarto");
		const secondPressure = api.resolveColloquyPressure(secondColloquyState, "gotti", "sarto");
		assert(JSON.stringify(firstPressure) === JSON.stringify(secondPressure) && JSON.stringify(firstColloquyState) === JSON.stringify(secondColloquyState), "1903: personal persuasion is non-deterministic");
		const firstDirectiveState = api.initState("gibbons", "1903-support-directive", "open");
		const secondDirectiveState = api.initState("gibbons", "1903-support-directive", "open");
		[firstDirectiveState, secondDirectiveState].forEach((directiveState) => {
			directiveState.lastVotes = ["oreglia", "gotti", "sarto"].map((voter) => ({ voter, candidate: "gibbons" }));
		});
		const firstDirective = api.resolveSupportDirective(firstDirectiveState, "sarto");
		const secondDirective = api.resolveSupportDirective(secondDirectiveState, "sarto");
		assert(JSON.stringify(firstDirective) === JSON.stringify(secondDirective) && JSON.stringify(firstDirectiveState) === JSON.stringify(secondDirectiveState), "1903: released-support responses are non-deterministic");
		assert(firstDirective.accepted.concat(firstDirective.rejected).length === 3 && firstDirective.rejected.includes("sarto") && !firstDirective.accepted.includes("sarto"), "1903: released support is forced, incomplete, or permits a self-vote promise");
		state = api.initState("gibbons", "1903-player-ballot", "historical");
		const record = api.simulateBallot(state, "rampolla");
		assert(record.votes.find((vote) => vote.voter === "gibbons").candidate === "rampolla", "1903: submitted player ballot was overwritten");
		const completed = api.runHeadless("1903-score", "gibbons", "historical");
		const score = api.scoreGame(completed);
		assert(Number.isFinite(score.total) && score.parts.reduce((sum, part) => sum + part.points, 0) === score.total && score.verdict && score.verdict.grade && Number.isInteger(score.seriesScore) && score.seriesScore >= 0 && score.seriesScore <= 100, "1903: end score is invalid");
		const validSave = JSON.parse(JSON.stringify(api.initState("gibbons", "1903-save", "open")));
		assert(typeof api.validateSavedState === "function" && api.validateSavedState(validSave), "1903: a valid saved conclave cannot be restored");
		const invalidSave = JSON.parse(JSON.stringify(validSave));
		invalidSave.history = [{ votes: [{ voter: "gibbons", candidate: "gibbons" }] }];
		invalidSave.ballotNo = 1;
		assert(!api.validateSavedState(invalidSave), "1903: an invalid saved ballot was accepted");
		const viablePlayers = api.ELECTORS.filter((cardinal) => {
			const candidacy = api.initState(cardinal.id, `1903-viability-${cardinal.id}`, "historical");
			candidacy.ballotNo = 7;
			candidacy.momentum[cardinal.id] = 65;
			candidacy.metrics.stature = 82;
			candidacy.metrics.trust = 78;
			candidacy.metrics.exposure = 18;
			candidacy.metrics.fatigue = 28;
			return (api.forecastCounts(candidacy)[cardinal.id] || 0) >= api.THRESHOLD;
		});
		assert(viablePlayers.length === api.ELECTORS.length, `1903: only ${viablePlayers.length}/${api.ELECTORS.length} active player candidacies can theoretically reach the threshold`);
		return ["portrait-lookup", "stable-baseline-affinity", "current-programme-fit", "pressure-explanations", "historical-pressure-effect", "pressure-ledger", "uncertain-soundings", "action-route-copy", "network-membership", "network-determinism", "individual-colloquy", "personal-persuasion", "consent-based-support-redirection", "player-ballot-preserved", "player-candidacy-viability", "end-score", "strict-save"];
	}
	if (variant.label === "october-1978") {
		assert(typeof api.initState === "function" && typeof api.runBallot === "function" && typeof api.getState === "function" && typeof api.makeSounding === "function" && typeof api.networkAccess === "function" && typeof api.workNetwork === "function" && typeof api.sortedCountEntries === "function" && typeof api.portraitFor === "function" && typeof api.scoreGame === "function", "October 1978: targeted-test API is not exported");
		assert(cardList(api).length === 111 && api.THRESHOLD === 75, "October 1978: electorate or two-thirds-plus-one threshold is wrong");
		const portraits = api.ELECTORS.map((cardinal) => ({ cardinal, portrait: api.portraitFor(cardinal.id) }));
		const missingPortraits = portraits.filter(({ cardinal, portrait }) => !portrait || portrait.src !== `assets/portraits/1978/${cardinal.id}.webp` || !/en\.wikipedia\.org/.test(portrait.wikipedia || "") || !fs.existsSync(path.join(ROOT, portrait.src)));
		assert(missingPortraits.length === 0, `October 1978: missing or invalid portraits for ${missingPortraits.map(({ cardinal }) => cardinal.id).join(", ")}`);
		assert(portraits.every(({ portrait }) => !("source" in portrait)), "October 1978: visible portrait source labels have returned");
		const octoberSource = fs.readFileSync(path.join(ROOT, variant.file), "utf8");
		const startbarRule = octoberSource.match(/\.startbar\{([^}]*)\}/);
		assert(startbarRule && /position:sticky/.test(startbarRule[1]) && /z-index:35/.test(startbarRule[1]) && /isolation:isolate/.test(startbarRule[1]), "October 1978: portrait cards can overlap the sticky chooser");
		assert(!/id="actAssure"/.test(octoberSource) && /Work for whose cause\?/.test(octoberSource), "October 1978: network work and candidacy shaping have not been merged");
		assert(/Filter cardinals by faction or network/.test(octoberSource), "October 1978: cardinal pickers have no faction/network filter");
		assert(!/No king sends a veto/.test(octoberSource), "October 1978: obsolete veto copy remains in the world-outside panel");
		const completeTally = api.sortedCountEntries({ siri: 20, benelli: 12, ciappi: 1 });
		assert(completeTally.length === 3 && completeTally.at(-1)[0] === "ciappi" && completeTally.at(-1)[1] === 1 && !/entries\.slice\(0,14\)/.test(octoberSource), "October 1978: one-vote candidates can disappear from the scrutiny tally");
		api.initState("villot", "october-soundings", { headless: true });
		const soundingState = JSON.stringify(api.getState());
		const soundingA = api.makeSounding("siri", 1);
		const soundingB = api.makeSounding("siri", 1);
		assert(JSON.stringify(soundingA) === JSON.stringify(soundingB) && JSON.stringify(api.getState()) === soundingState, "October 1978: sounding generation is non-deterministic or mutates state");
		assert(soundingA.candidates.length === 3 && soundingA.candidates.every((id) => api.ID[id] && id !== "siri") && !Object.hasOwn(soundingA, "score"), "October 1978: sounding is exact, invalid, or includes a self-candidate");
		assert(api.playerNetworks().includes("Curia") && api.playerNetworks().includes("Montinian"), "October 1978: Villot's modelled networks are not exposed");
		assert(api.networkAccess("Curia") > api.networkAccess("Africa"), "October 1978: membership does not improve network access");
		api.initState("villot", "october-network", { headless: true });
		const targetBefore = api.getState().visibility.benelli;
		const playerBefore = api.getState().visibility.villot;
		const networkA = api.workNetwork("Curia", "curia", "benelli");
		assert(networkA.candidateId === "benelli" && api.getState().visibility.benelli > targetBefore && api.getState().visibility.villot === playerBefore, "October 1978: network work cannot promote another cardinal without promoting the player");
		const networkStateA = JSON.stringify(api.getState());
		api.initState("villot", "october-network", { headless: true });
		const networkB = api.workNetwork("Curia", "curia", "benelli");
		assert(JSON.stringify(networkA) === JSON.stringify(networkB) && networkStateA === JSON.stringify(api.getState()), "October 1978: network action is not seed-deterministic");
		api.initState("villot", "october-player-ballot", { headless: true });
		let submitted = null;
		while (!api.getState().over && api.getState().ballotNo < 12) {
			submitted = "wojtyla";
			api.runBallot(submitted);
			const latest = api.getState().history.at(-1);
			assert(latest.roll.villot === submitted, `October 1978: submitted ballot ${submitted} was recorded as ${latest.roll.villot}`);
		}
		assert(api.getState().over, "October 1978: targeted run did not terminate");
		const before = JSON.stringify(api.getState().history);
		api.runBallot("wojtyla");
		assert(JSON.stringify(api.getState().history) === before, "October 1978: a ballot was accepted after election");
		const nameA = api.papalNameForState("october-papal-name", "siri");
		const nameB = api.papalNameForState("october-papal-name", "siri");
		assert(typeof nameA === "string" && nameA === nameB && / [IVXLCDM]+$/.test(nameA), "October 1978: alternate papal name is invalid or non-deterministic");
		const score = api.scoreGame(api.getState());
		assert(Number.isFinite(score.total) && score.parts.reduce((sum, part) => sum + part.points, 0) === score.total && score.verdict && score.verdict.grade && Number.isInteger(score.seriesScore) && score.seriesScore >= 0 && score.seriesScore <= 100, "October 1978: end score is invalid");
		assert(/conciliar/.test(api.axisPosition("vatican2", 1.8)) && !/high|middle/.test(api.axisPosition("vatican2", 1.8)), "October 1978: dossier axes still use ambiguous magnitude labels");
		const liveCandidates = api.ELECTORS.filter((cardinal) => {
			api.initState(cardinal.id, `october-live-field-${cardinal.id}`, { headless: true });
			return api.activeCandidatePool1978().includes(cardinal.id);
		});
		assert(liveCandidates.length === api.ELECTORS.length, `October 1978: ${api.ELECTORS.length - liveCandidates.length} player candidacies are pruned from their own ballot field`);
		api.initState("villot", "october-save", { headless: true });
		const saveState = api.getState();
		const validSave = JSON.parse(JSON.stringify(Object.assign({}, saveState, { rng: undefined, rngState: saveState.rng.state })));
		assert(api.validateSavedState(validSave), "October 1978: a valid saved conclave cannot be restored");
		const invalidSave = JSON.parse(JSON.stringify(validSave));
		invalidSave.metrics.stature = 101;
		assert(!api.validateSavedState(invalidSave), "October 1978: an out-of-range saved metric was accepted");
		const neutralA = api.runNeutralHeadless("october-neutral");
		const neutralB = api.runNeutralHeadless("october-neutral");
		assert(JSON.stringify(neutralA) === JSON.stringify(neutralB) && neutralA.over && neutralA.winner, "October 1978: neutral calibration mode is non-deterministic or unresolved");
		return ["full-portrait-coverage", "portrait-links", "chooser-stacking", "merged-network-action", "faction-picker-filter", "world-copy", "complete-tally", "uncertain-soundings", "network-membership", "third-party-network-cause", "network-determinism", "player-ballot-preserved", "terminal-guard", "papal-name", "end-score", "directional-profile", "all-player-live-field", "strict-save", "neutral-calibration"];
	}
	if (variant.label === "constance-1417") {
		assert(typeof api.initState === "function" && typeof api.beginScrutiny === "function" && typeof api.playerAccede === "function" && typeof api.makeSounding === "function" && typeof api.actionColloquy === "function" && typeof api.colloquySnapshot === "function" && typeof api.thresholds === "function" && typeof api.electedNow === "function" && typeof api.validateData === "function" && typeof api.scoreGame === "function" && typeof api.papalNameForState === "function", "Constance: targeted-test API is not exported");
		const audit = api.validateData();
		assert(audit && audit.ok, `Constance: data audit failed: ${audit && (audit.problems || []).join("; ")}`);
		const roster = cardList(api);
		assert(roster.length === 53, "Constance: electorate is not fifty-three");
		const bySize = {};
		roster.forEach((card) => { bySize[card.college] = (bySize[card.college] || 0) + 1; });
		assert(bySize.cardinals === 23 && ["italia", "gallia", "germania", "anglia", "hispania"].every((key) => bySize[key] === 6), "Constance: college sizes are wrong");
		let state = api.initState("dailly", "constance-thresholds", "open");
		const needs = api.thresholds(state);
		assert(needs.cardinals === 16 && ["italia", "gallia", "germania", "anglia", "hispania"].every((key) => needs[key] === 4), "Constance: six-lock thresholds are wrong");
		const settle = (st) => { while (st.pending) api.resolveDecision(st, api.autoChoiceFor(st)); return st; };
		const composite = { cardinals: { colonna: 23 }, italia: { colonna: 6 }, gallia: { colonna: 3 }, germania: { colonna: 6 }, anglia: { colonna: 6 }, hispania: { colonna: 6 } };
		assert(api.electedNow(state, composite) === null, "Constance: a candidate below two-thirds of one nation was elected despite an overall supermajority");
		composite.gallia.colonna = 4;
		assert(api.electedNow(state, composite) === "colonna", "Constance: all six locks turned but no election was recognised");
		state = settle(api.initState("dailly", "constance-blank", "open"));
		const blank = api.beginScrutiny(state, []);
		const blankRow = blank.votes.find((entry) => entry.voter === "dailly");
		assert(blankRow && blankRow.candidate.length === 0, "Constance: an explicit blank cedula became an AI ballot");
		state = settle(api.initState("dailly", "constance-dedupe", "open"));
		const deduped = api.beginScrutiny(state, ["colonna", "colonna"]);
		assert(JSON.stringify(deduped.votes.find((entry) => entry.voter === "dailly").candidate) === JSON.stringify(["colonna"]), "Constance: duplicate names on the cedula were not deduplicated");
		state = settle(api.initState("dailly", "constance-invalid", "open"));
		expectRejected("Constance: a self-vote was accepted", () => api.beginScrutiny(state, ["dailly"]));
		expectRejected("Constance: a non-elector was accepted on a cedula", () => api.beginScrutiny(state, ["beaufort"]));
		expectRejected("Constance: four names were accepted", () => api.beginScrutiny(state, ["colonna", "brogny", "saluzzo", "correr"]));
		expectRejected("Constance: an accession was accepted with no scrutiny open", () => api.playerAccede(state, "colonna"));
		state = settle(api.initState("dailly", "constance-player-ballot", "open"));
		const first = api.beginScrutiny(state, ["colonna", "brogny"]);
		const mine = first.votes.find((entry) => entry.voter === "dailly");
		assert(JSON.stringify(mine.candidate) === JSON.stringify(["colonna", "brogny"]), "Constance: the submitted cedula was overwritten");
		assert((first.accessions || []).length === 0 && !state.pendingBallot, "Constance: an accession was permitted at the first scrutiny");
		state = api.initState("polton", "constance-sound", "open");
		const snapshot = JSON.stringify(state);
		const soundingA = api.makeSounding(state);
		const soundingB = api.makeSounding(state);
		assert(JSON.stringify(soundingA) === JSON.stringify(soundingB) && JSON.stringify(state) === snapshot, "Constance: soundings are non-deterministic or mutate simulation state");
		assert(soundingA.rows.length > 0 && soundingA.rows.every((row) => Number.isInteger(row.low) && Number.isInteger(row.high) && row.low < row.high && !("count" in row) && !("total" in row)), "Constance: soundings expose exact counts or invalid ranges");
		assert(soundingA.rows.every((row) => ["cardinals", "italia", "gallia", "germania", "anglia", "hispania"].every((key) => row.colleges[key] && row.colleges[key].low <= row.colleges[key].high && Number.isInteger(row.colleges[key].need))), "Constance: per-college soundings are malformed");
		state = settle(api.initState("dailly", "constance-colloquy", "open"));
		state.lastSounding = api.makeSounding(state);
		const soundingConfidenceBefore = state.lastSounding.confidence;
		const soundingWidthsBefore = Object.fromEntries(state.lastSounding.rows.map((row) => [row.id, row.high - row.low]));
		const apBeforeColloquy = state.ap;
		const colloquy = api.actionColloquy(state, "colonna", "sound");
		assert(colloquy && colloquy.ok && state.ap === apBeforeColloquy - 1 && state.intel.colonna === 1 && state.intelLedger.some((entry) => entry.kind === "colloquy" && entry.voterId === "colonna"), "Constance: colloquy did not spend one action and retain its reading in the ledger");
		assert(state.lastSounding.confidence === soundingConfidenceBefore + 2 && state.lastSounding.refinedVoters.includes("colonna") && state.lastSounding.rows.every((row) => row.high - row.low <= soundingWidthsBefore[row.id]), "Constance: a private colloquy did not narrow the overall sounding");
		const anchored = api.runHeadless("anchor", "polton", "historical");
		assert(anchored.winner === "colonna" && anchored.ballots <= 3, "Constance: the historical anchor did not elect Colonna by St Martin's morning");
		const finalRecord = anchored.history[anchored.history.length - 1];
		assert(Array.isArray(finalRecord.locks && finalRecord.locks.colonna) && finalRecord.locks.colonna.length === 6, "Constance: the anchor election did not turn all six locks");
		const anchorNeeds = api.thresholds(anchored);
		assert(Object.keys(anchorNeeds).every((key) => (finalRecord.colleges[key].colonna || 0) >= anchorNeeds[key]), "Constance: anchor tallies fall below a college threshold");
		const alternateHistoricalWinners = ["balance-4", "balance-7", "balance-17"].map((seed) => api.runHeadless(seed, "dailly", "historical").winner);
		assert(alternateHistoricalWinners.includes("brogny") && alternateHistoricalWinners.includes("saluzzo") && alternateHistoricalWinners.includes("correr"), "Constance: historical pressure has reverted to a compulsory Colonna victory");
		const openA = api.runHeadless("constance-open", "dailly", "open");
		const openB = api.runHeadless("constance-open", "dailly", "open");
		assert(JSON.stringify(openA) === JSON.stringify(openB) && openA.winner && openA.ballots <= 12, "Constance: open-mode run is non-deterministic or fails to resolve within twelve scrutinies");
		for (const ballot of historyOf(openA)) assertBallotIntegrity(variant, api, ballot);
		const nameA = api.papalNameForState("constance-name", "saluzzo");
		const nameB = api.papalNameForState("constance-name", "saluzzo");
		assert(typeof nameA === "string" && nameA === nameB && / [IVXLCDM]+$/.test(nameA), "Constance: papal name is invalid or non-deterministic");
		assert(api.papalNameForState("constance-history", "colonna", 2) === "Martin V", "Constance: Colonna does not take the historically correct name Martin V on St Martin's morning");
		assert(api.papalNameForState("constance-counterfactual", "colonna", 1) === "Leo X" && api.papalNameForState("constance-counterfactual", "colonna", 6) === "Brice I" && api.papalNameForState("constance-counterfactual", "colonna", 11) === "Hugh I", "Constance: a counterfactual Colonna election does not follow the actual feast date");
		assert(api.regnalOptionsFor("colonna", 6)[0] === "Brice I" && !api.regnalOptionsFor("colonna", 6).includes("Martin V"), "Constance: a player Colonna can still take Martin away from St Martin's day");
		assert(api.regnalOptionsFor("condulmer")[0] === "Eugene IV", "Constance: Condulmer's first regnal choice is not Eugene IV");
		const constanceSource = fs.readFileSync(path.join(ROOT, variant.file), "utf8");
		assert(/for\(let i=0;i<5;i\+\+\)/.test(constanceSource), "Constance: selection difficulty is still compressed to a three-star scale");
		assert(/What the affinity labels mean/.test(constanceSource) && /Doctors[\s\S]*Diplomats[\s\S]*Religious/.test(constanceSource), "Constance: cross-cutting affinity labels are not explained");
		assert(/id="intelLedger"/.test(constanceSource) && /function renderIntelLedger/.test(constanceSource), "Constance: soundings have no persistent intelligence ledger");
		assert(/function appendFilterableChooser/.test(constanceSource) && /Filter electors by college/.test(constanceSource) && /Filter electors by affinity/.test(constanceSource), "Constance: action target lists are not filterable");
		assert(/function openScrutinyRecord/.test(constanceSource) && /View final scrutiny &amp; accessus/.test(constanceSource) && /function doScrutiny\(\)[\s\S]*openModal\("Write your cedula/.test(constanceSource), "Constance: cedulae and scrutiny records are not presented in dialogs");
		assert(/Choose up to three/.test(constanceSource) && /0 of 3 names selected/.test(constanceSource), "Constance: the cedula chooser does not make its three-name limit prominent");
		assert(/queueModalStep\(revealNext/.test(constanceSource) && /Show full count/.test(constanceSource) && /prefers-reduced-motion: reduce/.test(constanceSource), "Constance: scrutiny votes are not serially revealed with a reduced-motion escape hatch");
		assert(/Public cedula roll/.test(constanceSource) && /read both the vote and the name of its elector aloud/.test(constanceSource), "Constance: the in-game public cedula roll is not historically explained");
		assert(/onDossier:function\(id\)\{openDossier\(id,showChooser\)\}/.test(constanceSource) && /closeLabel:onReturn \? "Back"/.test(constanceSource), "Constance: dossiers opened from action choosers do not return to the chooser");
		assert(/#screen-game header\{order:-3\}/.test(constanceSource) && /#rightcol\{order:-1\}/.test(constanceSource) && /#leftcol\{order:0\}/.test(constanceSource), "Constance: mobile header, intelligence and roster order is wrong");
		assert(/Word through the wall[\s\S]*It does not directly change a vote/.test(constanceSource), "Constance: word-through-the-wall consequences are not explained");
		assert(/scrollbar-color/.test(constanceSource) && /::-webkit-scrollbar-corner/.test(constanceSource), "Constance: native scrollbars remain visually unintegrated");
		const score = api.scoreGame(openA);
		assert(Number.isFinite(score.total) && score.parts.reduce((sum, part) => sum + part.points, 0) === score.total && score.verdict && score.verdict.grade && Number.isInteger(score.seriesScore) && score.seriesScore >= 0 && score.seriesScore <= 100, "Constance: end score is invalid");
		const validSave = JSON.parse(JSON.stringify(api.initState("dailly", "constance-save", "open")));
		assert(typeof api.validateSavedState === "function" && api.validateSavedState(validSave), "Constance: a valid saved conclave cannot be restored");
		const invalidSave = JSON.parse(JSON.stringify(validSave));
		invalidSave.rng.state = -1;
		assert(!api.validateSavedState(invalidSave), "Constance: an invalid RNG state was accepted from a save");
		return ["data-audit", "six-college-rule", "blank-ballot", "approval-validation", "accession-validation", "no-first-scrutiny-accession", "player-ballot-preserved", "uncertain-soundings", "colloquy-ledger", "colloquy-refines-soundings", "historical-anchor", "historical-alternates", "open-termination", "papal-name", "dated-colonna-name", "five-star-difficulty", "affinity-guidance", "persistent-ledger", "filterable-choosers", "chooser-return", "three-name-guidance", "serial-scrutiny", "public-cedula-roll", "mobile-order", "scrutiny-dialogs", "wall-guidance", "styled-scrollbars", "end-score", "strict-save"];
	}
	if (variant.label === "april-1378") {
		assert(typeof api.initState === "function" && typeof api.beginScrutiny === "function" && typeof api.makeSounding === "function" && typeof api.runHeadless === "function" && typeof api.validateData === "function" && typeof api.scoreGame === "function" && typeof api.papalNameForState === "function" && typeof api.regnalOptionsFor === "function" && typeof api.regnalSignalFor === "function" && typeof api.choosePlayerRegnalName === "function" && typeof api.axisPosition === "function" && typeof api.roman === "function" && typeof api.scrutinyLabel === "function" && typeof api.resolveDecision === "function" && typeof api.autoChoiceFor === "function", "April 1378: targeted-test API is not exported");
		// data audit
		const audit = api.validateData();
		assert(audit.ok, "April 1378: data audit failed — " + (audit.notes || []).join("; "));
		const roster = cardList(api);
		assert(roster.length === 16, "April 1378: the College is not sixteen electors");
		const sizes = { limousin: 0, gallican: 0, italian: 0, curial: 0 };
		roster.forEach((c) => { sizes[c.faction] = (sizes[c.faction] || 0) + 1; });
		assert(sizes.limousin === 5 && sizes.gallican === 5 && sizes.italian === 4 && sizes.curial === 2, "April 1378: faction arithmetic is not 5/5/4/2");
		assert(api.THRESHOLD === 11 && api.threshold(16) === 11, "April 1378: two-thirds of sixteen is not eleven");
		assert(api.OUTSIDERS && api.OUTSIDERS.prignano && Object.keys(api.OUTSIDERS).length === 1, "April 1378: the single non-cardinal candidate is not the Archbishop of Bari");
		// historical anchor: the documented scrutiny of 8 April
		const anchor = api.runHeadless("anchor", "deluna", "historical");
		assert(anchor.winner === "prignano" && anchor.ballots === 1, "April 1378: the documented morning did not elect the Archbishop of Bari on the first scrutiny");
		const anchorBallot = anchor.history[0];
		assert(anchorBallot.counts.prignano === 14 && anchorBallot.counts.tebaldeschi === 1, "April 1378: the documented tally is not 14 for Bari and 1 for St Peter's");
		assert(anchorBallot.date.includes("Thursday 8 April") && anchorBallot.session.includes("Thursday 8 April"), "April 1378: the documented morning is dated 7 April");
		assert(Array.from({ length: 12 }, (_, i) => api.scrutinyLabel(i + 1)).join("|") === "Scrutiny I|Scrutiny II|Scrutiny III|Scrutiny IV|Scrutiny V|Scrutiny VI|Scrutiny VII|Scrutiny VIII|Scrutiny IX|Scrutiny X|Scrutiny XI|Scrutiny XII", "April 1378: scrutiny labels are not consistently Roman-numbered");
		const orsiniEntry = anchorBallot.votes.find((v) => v.voter === "orsini");
		assert(orsiniEntry && Array.isArray(orsiniEntry.candidate) && orsiniEntry.candidate.length === 0, "April 1378: Orsini's withheld voice was not preserved in the documented scrutiny");
		assert(anchor.finale && anchor.finale.key === "schism", "April 1378: the documented election did not open the Great Schism");
		// blank ballot preserved (open mode)
		let s = api.initState("montelais", "april-blank", "open");
		while (s.pending) api.resolveDecision(s, api.autoChoiceFor(s));
		const blank = api.beginScrutiny(s, []);
		const blankRow = blank.votes.find((v) => v.voter === "montelais");
		assert(blankRow && Array.isArray(blankRow.candidate) && blankRow.candidate.length === 0, "April 1378: an explicit withheld voice became an AI ballot");
		// player ballot preserved
		s = api.initState("montelais", "april-preserve", "open");
		while (s.pending) api.resolveDecision(s, api.autoChoiceFor(s));
		const submitted = api.beginScrutiny(s, ["geneva"]);
		const mine = submitted.votes.find((v) => v.voter === "montelais");
		assert(mine && JSON.stringify(mine.candidate) === JSON.stringify(["geneva"]), "April 1378: the submitted oral vote was overwritten");
		// rejections
		s = api.initState("montelais", "april-reject", "open");
		while (s.pending) api.resolveDecision(s, api.autoChoiceFor(s));
		expectRejected("April 1378: a self-vote was accepted", () => api.beginScrutiny(s, ["montelais"]));
		expectRejected("April 1378: an unknown candidate was accepted", () => api.beginScrutiny(s, ["nobody"]));
		expectRejected("April 1378: two names were accepted in an oral scrutiny", () => api.beginScrutiny(s, ["geneva", "malsec"]));
		expectRejected("April 1378: a non-array ballot was accepted", () => api.beginScrutiny(s, "geneva"));
		// soundings: deterministic, no mutation, honest ranges
		s = api.initState("deluna", "april-sound", "open");
		const snapshot = JSON.stringify(s);
		const soundingA = api.makeSounding(s);
		const soundingB = api.makeSounding(s);
		assert(JSON.stringify(soundingA) === JSON.stringify(soundingB) && JSON.stringify(s) === snapshot, "April 1378: soundings are non-deterministic or mutate simulation state");
		assert(soundingA.rows.length > 0 && soundingA.rows.every((row) => Number.isInteger(row.low) && Number.isInteger(row.high) && row.low < row.high && !("count" in row) && !("total" in row)), "April 1378: soundings expose exact counts or invalid ranges");
		// open-mode determinism, termination, per-ballot integrity
		const openA = api.runHeadless("april-open", "geneva", "open");
		const openB = api.runHeadless("april-open", "geneva", "open");
		assert(JSON.stringify(openA) === JSON.stringify(openB) && openA.winner && openA.ballots <= 12, "April 1378: open-mode run is non-deterministic or fails to resolve within twelve scrutinies");
		for (const ballot of historyOf(openA)) assertBallotIntegrity(variant, api, ballot);
		// the player holds the outcome: bad handling opens the Schism, good handling averts it
		function playChoices(seed, first, second, actions) {
			const g = api.initState("montelais", seed, "open");
			api.resolveDecision(g, first);
			api.resolveDecision(g, second);
			let guard = 0;
			while (!g.over && guard < 80) {
				guard++;
				if (g.pending) { api.resolveDecision(g, api.autoChoiceFor(g)); continue; }
				if (g.ballotNo >= 12) break;
				(actions || []).forEach((a) => { if (api.actionAvailable(g, a)) api.performAction(g, a); });
				api.beginScrutiny(g, api.bestLegalPlayerVote(g, api.forecastCounts(g)));
			}
			while (!g.over && guard < 120) { guard++; if (g.pending) api.resolveDecision(g, api.autoChoiceFor(g)); else break; }
			return g;
		}
		const badGame = playChoices("april-bad", "admit", "promise", []);
		assert(badGame.finale && badGame.finale.key === "schism", "April 1378: promising the mob and voting under maximum terror did not open the Schism");
		const goodGame = playChoices("april-good", "refuse", "defy", ["parley", "protest"]);
		assert(goodGame.finale && goodGame.finale.key === "one-pope", "April 1378: a defended, protested election still fractured the Church");
		const talk = api.initState("corsini", "april-colloquy", "open");
		api.resolveDecision(talk, api.autoChoiceFor(talk));
		api.resolveDecision(talk, api.autoChoiceFor(talk));
		assert(api.actionAvailable(talk, "colloquy"), "April 1378: colloquy is not available after the opening decisions");
		api.performAction(talk, "colloquy");
		assert(talk.lastColloquy && typeof talk.lastColloquy.line === "string" && Array.isArray(talk.lastColloquy.heard) && talk.lastColloquy.heard.length > 0, "April 1378: colloquy did not retain a result for its dialog");
		assert(talk.lastColloquy.heard.every((item) => item.after > item.before), "April 1378: colloquy dialog reports a cardinal who did not warm to the player");
		// an Italian cardinal can be elected himself
		let selfElected = false;
		for (let i = 0; i < 6 && !selfElected; i++) {
			const g = api.initState("corsini", "april-self-" + i, "open");
			let guard = 0;
			while (!g.over && guard < 80) {
				guard++;
				if (g.pending) { api.resolveDecision(g, api.autoChoiceFor(g)); continue; }
				if (g.ballotNo >= 12) break;
				if (api.actionAvailable(g, "rally")) api.performAction(g, "rally");
				if (api.actionAvailable(g, "colloquy")) api.performAction(g, "colloquy");
				api.beginScrutiny(g, ["borsano"]);
			}
			while (!g.over && guard < 120) { guard++; if (g.pending) api.resolveDecision(g, api.autoChoiceFor(g)); else break; }
			if (g.electedId === "corsini") selfElected = true;
		}
		assert(selfElected, "April 1378: an Italian cardinal who rallies the room cannot be elected himself");
		// papal names: deterministic, numbered, historically fixed
		const nameA = api.papalNameForState("april-name", "prignano");
		const nameB = api.papalNameForState("april-name", "prignano");
		assert(typeof nameA === "string" && nameA === nameB && / [IVXLCDM]+$/.test(nameA), "April 1378: papal name is invalid or non-deterministic");
		assert(api.regnalOptionsFor("prignano")[0] === "Urban VI", "April 1378: Prignano's regnal name is not Urban VI");
		assert(api.regnalOptionsFor("geneva")[0] === "Clement VII", "April 1378: Robert of Geneva's regnal name is not Clement VII");
		assert(roster.every((card) => api.regnalOptionsFor(card.id).length >= 2 && api.regnalOptionsFor(card.id).every((name) => api.regnalSignalFor(name).length > 12)), "April 1378: a playable cardinal lacks a meaningful regnal-name choice");
		const nameState = { playerId: "geneva", electedId: "geneva", electedName: "Clement VII", playerRegnalName: "Clement VII", flags: {}, finale: { electedName: "Clement VII", playerRegnalName: "Clement VII" } };
		assert(api.choosePlayerRegnalName(nameState, "Alexander V") === "Alexander V" && nameState.electedName === "Alexander V" && nameState.finale.electedName === "Alexander V", "April 1378: the player's regnal-name choice did not update the result");
		expectRejected("April 1378: an unavailable regnal name was accepted", () => api.choosePlayerRegnalName(nameState, "Hadrian IX"));
		const rivalNameState = { playerId: "geneva", electedId: "prignano", playerRegnalName: "Clement VII", flags: { playerAntipope: true }, finale: { line: "Urban in Rome, Clement VII at Avignon.", playerRegnalName: "Clement VII" }, log: [{ kind: "finale", html: "Urban in Rome, Clement VII at Avignon." }] };
		api.choosePlayerRegnalName(rivalNameState, "Alexander V");
		assert(rivalNameState.finale.line.includes("Alexander V at Avignon") && rivalNameState.log[0].html.includes("Alexander V at Avignon"), "April 1378: a rival regnal-name choice left Clement in the finale record");
		assert(/legalist/.test(api.axisPosition("Law", 2)) && /resistant/.test(api.axisPosition("With the crowd", -2)) && api.axisPosition("Nerve", 0) === "balanced", "April 1378: dossier axes do not use directional language");
		// end score integrity
		const score = api.scoreGame(openA);
		assert(Number.isFinite(score.total) && score.parts.reduce((sum, part) => sum + part.points, 0) === score.total && score.verdict && score.verdict.grade && score.seriesScore === score.total && score.seriesScore >= 0 && score.seriesScore <= 100, "April 1378: end score is invalid");
		const capped = api.runHeadless("april-capped", "geneva", "open", 1);
		assert(capped.unresolved && !capped.winner && capped.ballots === 1, "April 1378: a capped simulation fabricated a winner instead of returning unresolved");
		const validSave = JSON.parse(JSON.stringify(api.initState("geneva", "april-save", "open")));
		assert(typeof api.validateSavedState === "function" && api.validateSavedState(validSave), "April 1378: a valid saved conclave cannot be restored");
		const invalidSave = JSON.parse(JSON.stringify(validSave));
		invalidSave.trust.geneva = Infinity;
		assert(!api.validateSavedState(invalidSave), "April 1378: an invalid saved trust value was accepted");
		return ["data-audit", "faction-arithmetic", "single-outsider", "historical-anchor", "documented-tally", "scrutiny-date", "roman-scrutinies", "orsini-withheld", "schism-onset", "blank-ballot", "player-ballot-preserved", "oral-validation", "uncertain-soundings", "open-termination", "player-drives-schism", "player-drives-unity", "colloquy-dialog", "italian-self-election", "papal-name", "regnal-choice", "directional-profile", "end-score", "lawful-unresolved-cap", "strict-save"];
	}
	if (variant.label === "accession-1458") {
		assert(typeof api.initState === "function" && typeof api.beginScrutiny === "function" && typeof api.stepAccession === "function" && typeof api.validateSavedState === "function", "1458: targeted-test API is not exported");
		assert(api.validateData().length === 0 && api.ELECTORS.length === 18 && api.THRESHOLD === 12, "1458: roster, threshold, or data audit is invalid");
		const factions = {};
		api.ELECTORS.forEach((cardinal) => { factions[cardinal.faction] = (factions[cardinal.faction] || 0) + 1; });
		assert(factions.italian === 8 && factions.catalan === 5 && factions.french === 2 && factions.greek === 2 && factions.avis === 1, "1458: faction arithmetic is wrong");

		const historical = api.runHeadless("1458-chronicle", "mella", "historical", 10);
		assert(historical.electedId === "piccolomini" && historical.electedName === "Pius II" && historical.history.length === 2, "1458: historical replay does not elect Pius II in two scrutinies");
		const second = historical.history[1];
		assert(second.votes.filter((vote) => vote.candidate[0] === "piccolomini").length === 9 && second.votes.filter((vote) => vote.candidate[0] === "estouteville").length === 6, "1458: second scrutiny is not the documented 9–6");
		assert(second.accessions.map((move) => move.id).join(",") === "borgia,tebaldi,colonna" && second.accessions.every((move) => move.from === move.id), "1458: documented accession order or source IDs are wrong");
		assert(second.counts.piccolomini === 12 && second.elected, "1458: final recorded tally does not reach twelve");
		for (const ballot of historical.history) assertBallotIntegrity(variant, api, ballot);

		const blank = api.initState("mella", "1458-blank", "historical");
		while (blank.pending) api.resolveDecision(blank, api.autoChoiceFor(blank));
		const blankRecord = api.beginScrutiny(blank, []);
		assert(blank.flags.divergedFromRecord && !blankRecord.scripted && blankRecord.votes.find((vote) => vote.voter === "mella").candidate.length === 0, "1458: a historical blank paper was overwritten or did not trigger divergence");
		expectRejected("1458: a self-vote was accepted", () => api.validatePlayerPicks(blank, ["mella"]));
		expectRejected("1458: an unknown candidate was accepted", () => api.validatePlayerPicks(blank, ["bogus"]));
		expectRejected("1458: a double paper was accepted", () => api.validatePlayerPicks(blank, ["barbo", "mella"]));

		const selfAccede = api.initState("piccolomini", "1458-self-accession", "open");
		while (selfAccede.pending) api.resolveDecision(selfAccede, api.autoChoiceFor(selfAccede));
		api.beginScrutiny(selfAccede, []);
		selfAccede.accession.phase = "live";
		selfAccede.accession.leaderId = "piccolomini";
		assert(!api.accessionEligible(selfAccede, "piccolomini"), "1458: the ballot leader can accede to himself");
		api.stageAccessionChoice(selfAccede, { act: "accede" });
		api.stepAccession(selfAccede);
		assert(!selfAccede.history[0].accessions.some((move) => move.id === "piccolomini"), "1458: an illegal player self-accession reached the record");

		const soundingState = api.initState("mella", "1458-soundings", "open");
		const soundingBefore = JSON.stringify(soundingState);
		const soundingA = api.makeSounding(soundingState);
		const soundingB = api.makeSounding(soundingState);
		assert(JSON.stringify(soundingA) === JSON.stringify(soundingB) && JSON.stringify(soundingState) === soundingBefore, "1458: soundings are non-deterministic or mutate simulation state");
		assert(soundingA.rows.length > 0 && soundingA.rows.every((row) => Number.isInteger(row.lo) && Number.isInteger(row.hi) && row.lo <= row.hi && row.lo >= 0 && row.hi <= 18), "1458: soundings contain invalid ranges");

		const saved = api.initState("mella", "1458-save", "open");
		assert(api.validateSavedState(JSON.parse(JSON.stringify(saved))).schemaVersion === api.SAVE_SCHEMA, "1458: a valid versioned save cannot be restored");
		expectRejected("1458: an unknown save schema was accepted", () => api.validateSavedState({ schemaVersion: 999 }));
		const viable = api.ELECTORS.filter((cardinal) => {
			const state = api.initState(cardinal.id, `1458-viability-${cardinal.id}`, "open");
			state.ballotNo = 7;
			state.momentum[cardinal.id] = 65;
			state.metrics.standing = 90;
			return (api.forecastCounts(state)[cardinal.id] || 0) >= api.THRESHOLD;
		});
		assert(viable.length === api.ELECTORS.length, `1458: only ${viable.length}/${api.ELECTORS.length} player candidacies can theoretically reach the threshold`);
		assert(Number.isFinite(historical.finale.score.total) && Object.values(historical.finale.score.parts).reduce((sum, value) => sum + value, 0) === historical.finale.score.total && historical.finale.score.seriesScore === historical.finale.score.total && historical.finale.score.seriesScore >= 0 && historical.finale.score.seriesScore <= 100, "1458: end score is invalid");
		const source = fs.readFileSync(path.join(ROOT, variant.file), "utf8");
		assert(!source.includes("by exhausted acclamation"), "1458: fabricated exhausted-acclamation fallback remains");
		return ["data-audit", "faction-arithmetic", "historical-replay", "documented-tally", "accession-order", "blank-ballot", "approval-validation", "self-accession", "uncertain-soundings", "versioned-save", "player-candidacy-viability", "end-score", "lawful-ending"];
	}
	if (variant.label === "accession-1458") {
		assert(typeof api.initState === "function" && typeof api.beginScrutiny === "function" && typeof api.stepAccession === "function" && typeof api.validateSavedState === "function", "1458: targeted-test API is not exported");
		assert(api.validateData().length === 0 && api.ELECTORS.length === 18 && api.THRESHOLD === 12, "1458: roster, threshold, or data audit is invalid");
		const factions = {};
		api.ELECTORS.forEach((cardinal) => { factions[cardinal.faction] = (factions[cardinal.faction] || 0) + 1; });
		assert(factions.italian === 8 && factions.catalan === 5 && factions.french === 2 && factions.greek === 2 && factions.avis === 1, "1458: faction arithmetic is wrong");

		const historical = api.runHeadless("1458-chronicle", "mella", "historical", 10);
		assert(historical.electedId === "piccolomini" && historical.electedName === "Pius II" && historical.history.length === 2, "1458: historical replay does not elect Pius II in two scrutinies");
		const second = historical.history[1];
		assert(second.votes.filter((vote) => vote.candidate[0] === "piccolomini").length === 9 && second.votes.filter((vote) => vote.candidate[0] === "estouteville").length === 6, "1458: second scrutiny is not the documented 9–6");
		assert(second.accessions.map((move) => move.id).join(",") === "borgia,tebaldi,colonna" && second.accessions.every((move) => move.from === move.id), "1458: documented accession order or source IDs are wrong");
		assert(second.counts.piccolomini === 12 && second.elected, "1458: final recorded tally does not reach twelve");
		for (const ballot of historical.history) assertBallotIntegrity(variant, api, ballot);

		const blank = api.initState("mella", "1458-blank", "historical");
		while (blank.pending) api.resolveDecision(blank, api.autoChoiceFor(blank));
		const blankRecord = api.beginScrutiny(blank, []);
		assert(blank.flags.divergedFromRecord && !blankRecord.scripted && blankRecord.votes.find((vote) => vote.voter === "mella").candidate.length === 0, "1458: a historical blank paper was overwritten or did not trigger divergence");
		expectRejected("1458: a self-vote was accepted", () => api.validatePlayerPicks(blank, ["mella"]));
		expectRejected("1458: an unknown candidate was accepted", () => api.validatePlayerPicks(blank, ["bogus"]));
		expectRejected("1458: a double paper was accepted", () => api.validatePlayerPicks(blank, ["barbo", "mella"]));

		const selfAccede = api.initState("piccolomini", "1458-self-accession", "open");
		while (selfAccede.pending) api.resolveDecision(selfAccede, api.autoChoiceFor(selfAccede));
		api.beginScrutiny(selfAccede, []);
		selfAccede.accession.phase = "live";
		selfAccede.accession.leaderId = "piccolomini";
		assert(!api.accessionEligible(selfAccede, "piccolomini"), "1458: the ballot leader can accede to himself");
		api.stageAccessionChoice(selfAccede, { act: "accede" });
		api.stepAccession(selfAccede);
		assert(!selfAccede.history[0].accessions.some((move) => move.id === "piccolomini"), "1458: an illegal player self-accession reached the record");

		const soundingState = api.initState("mella", "1458-soundings", "open");
		const soundingBefore = JSON.stringify(soundingState);
		const soundingA = api.makeSounding(soundingState);
		const soundingB = api.makeSounding(soundingState);
		assert(JSON.stringify(soundingA) === JSON.stringify(soundingB) && JSON.stringify(soundingState) === soundingBefore, "1458: soundings are non-deterministic or mutate simulation state");
		assert(soundingA.rows.length > 0 && soundingA.rows.every((row) => Number.isInteger(row.lo) && Number.isInteger(row.hi) && row.lo <= row.hi && row.lo >= 0 && row.hi <= 18), "1458: soundings contain invalid ranges");

		const saved = api.initState("mella", "1458-save", "open");
		assert(api.validateSavedState(JSON.parse(JSON.stringify(saved))).schemaVersion === api.SAVE_SCHEMA, "1458: a valid versioned save cannot be restored");
		expectRejected("1458: an unknown save schema was accepted", () => api.validateSavedState({ schemaVersion: 999 }));
		const viable = api.ELECTORS.filter((cardinal) => {
			const state = api.initState(cardinal.id, `1458-viability-${cardinal.id}`, "open");
			state.ballotNo = 7;
			state.momentum[cardinal.id] = 65;
			state.metrics.standing = 90;
			return (api.forecastCounts(state)[cardinal.id] || 0) >= api.THRESHOLD;
		});
		assert(viable.length === api.ELECTORS.length, `1458: only ${viable.length}/${api.ELECTORS.length} player candidacies can theoretically reach the threshold`);
		assert(Number.isFinite(historical.finale.score.total) && Object.values(historical.finale.score.parts).reduce((sum, value) => sum + value, 0) === historical.finale.score.total && historical.finale.score.seriesScore === historical.finale.score.total && historical.finale.score.seriesScore >= 0 && historical.finale.score.seriesScore <= 100, "1458: end score is invalid");
		const source = fs.readFileSync(path.join(ROOT, variant.file), "utf8");
		assert(!source.includes("by exhausted acclamation"), "1458: fabricated exhausted-acclamation fallback remains");
		return ["data-audit", "faction-arithmetic", "historical-replay", "documented-tally", "accession-order", "blank-ballot", "approval-validation", "self-accession", "uncertain-soundings", "versioned-save", "player-candidacy-viability", "end-score", "lawful-ending"];
	}
	if (variant.label === "may-2025") {
		assert(typeof api.newGame === "function" && typeof api.runScrutiny === "function" && typeof api.runHeadless === "function" && typeof api.validateSavedState === "function", "May 2025: targeted-test API is not exported");
		assert(api.validateData().length === 0 && api.ELECTORS.length === 133 && api.THRESHOLD === 89, "May 2025: roster, threshold, or data audit is invalid");
		assert(typeof api.portraitFor === "function" && Object.keys(api.PORTRAIT_FILES || {}).length === 133 && Object.keys(api.WIKIPEDIA_PAGES || {}).length === 133, "May 2025: portrait catalogue is incomplete or not exported");
		const portraitAttribution = JSON.parse(fs.readFileSync(path.join(ROOT, "assets", "portraits", "attribution.json"), "utf8")).portraits;
		const portraitAudit = api.ELECTORS.map((cardinal) => {
			const portrait = api.portraitFor(cardinal.id);
			const localPath = portrait && path.join(ROOT, portrait.src);
			const attribution = portraitAttribution[`2025/${cardinal.id}.webp`];
			return { cardinal, portrait, localPath, attribution, bytes: localPath && fs.existsSync(localPath) ? fs.statSync(localPath).size : 0 };
		});
		const invalidPortraits = portraitAudit.filter(({ portrait, localPath, attribution, bytes }) => !portrait || !/assets\/portraits\/2025\/[a-z0-9]+\.webp$/.test(portrait.src) || !/en\.wikipedia\.org/.test(portrait.wikipedia || "") || !fs.existsSync(localPath) || bytes <= 0 || bytes > 30000 || !attribution?.commons_file || !/^https:\/\/commons\.wikimedia\.org\//.test(attribution.source || "") || !attribution.license);
		assert(invalidPortraits.length === 0, `May 2025: missing, oversized, unattributed, or invalid portraits for ${invalidPortraits.map(({ cardinal }) => cardinal.id).join(", ")}`);
		assert(portraitAudit.reduce((sum, portrait) => sum + portrait.bytes, 0) < 1300000, "May 2025: portrait archive exceeds its mobile payload budget");
		assert(api.DAYS.length === 15 && api.DAYS[9].n === "VIII" && api.DAYS[10].n === "IX" && api.DAYS[14].date === "Wednesday 7 May", "May 2025: general-congregation chronology is wrong");
		assert(JSON.stringify(api.PAUSE_BALLOTS) === JSON.stringify([13, 20, 27, 34]), "May 2025: constitutional pause boundaries are wrong");

		api.newGame("prevost", "2025-player-ballot");
		api.startConclave();
		let state = api.getState();
		expectRejected("May 2025: a player self-vote was accepted", () => api.runScrutiny(state.player));
		const parolin = state.byKey.parolin.ix;
		const firstBallot = api.runScrutiny(parolin);
		const playerEntry = firstBallot.roll.find((vote) => vote.voter === "prevost");
		assert(playerEntry && playerEntry.candidate === "parolin", "May 2025: the submitted player ballot was rewritten");
		state.over = true;
		expectRejected("May 2025: a post-election scrutiny was accepted", () => api.runScrutiny(parolin));
		api.newGame("prevost", "2025-acceptance-smoke");
		api.startConclave();
		state = api.getState();
		for (let voter = 0; voter < state.electors.length; voter++) if (voter !== state.player) state.C[voter * state.electors.length + state.player] += 24;
		api.runScrutiny(state.byKey.parolin.ix);
		api.endSession();
		assert(state.awaitAccept && state.smoke.state !== "white", "May 2025: white smoke appeared before the elected player accepted");
		api.acceptElection(true, "Leo XIV");
		assert(state.over && state.smoke.state === "white" && state.popeName === "Leo XIV", "May 2025: acceptance did not complete the election and publish white smoke");

		api.newGame("prevost", "2025-soundings");
		const soundingBefore = JSON.stringify(api.serializeGame());
		const soundingA = api.makeSounding();
		const soundingB = api.makeSounding();
		assert(JSON.stringify(soundingA) === JSON.stringify(soundingB) && JSON.stringify(api.serializeGame()) === soundingBefore, "May 2025: soundings mutate state or consume simulation randomness");
		assert(soundingA.rows.length === 5 && soundingA.rows.every((row) => Number.isInteger(row.low) && Number.isInteger(row.high) && row.low <= row.high && !("count" in row)), "May 2025: soundings expose exact or invalid forecasts");

		api.newGame("prevost", "2025-save-replay");
		api.startConclave();
		state = api.getState();
		api.runScrutiny(state.byKey.parolin.ix);
		api.endSession();
		api.advanceConclaveDay();
		const save = api.saveCode();
		api.runScrutiny(api.getState().byKey.parolin.ix);
		const uninterrupted = JSON.stringify(api.serializeGame());
		api.loadCode(save);
		api.runScrutiny(api.getState().byKey.parolin.ix);
		assert(JSON.stringify(api.serializeGame()) === uninterrupted, "May 2025: save/reload changed the next scrutiny or subsequent state");
		const validSave = api.serializeGame();
		assert(api.validateSavedState(JSON.parse(JSON.stringify(validSave))), "May 2025: a valid versioned save cannot be restored");
		const invalidSave = JSON.parse(JSON.stringify(validSave));
		invalidSave.CSize--;
		assert(!api.validateSavedState(invalidSave), "May 2025: a corrupt matrix was accepted from a save");

		api.newGame("tagle", "2025-unread-void");
		api.startConclave();
		state = api.getState();
		const anchors = [state.byKey.parolin.ix, state.byKey.prevost.ix, state.byKey.tagle.ix, state.byKey.erdo.ix];
		for (let voter = 0; voter < state.electors.length; voter++) {
			let target = anchors[voter % anchors.length];
			if (target === voter) target = anchors[(voter + 1) % anchors.length];
			state.C[voter * state.electors.length + target] += 30;
		}
		api.runScrutiny(state.byKey.parolin.ix);
		api.endSession();
		api.advanceConclaveDay();
		api.runScrutiny(state.byKey.parolin.ix);
		api.runScrutiny(state.byKey.parolin.ix);
		api.endSession();
		state.session = "pm";
		for (let voter = 0; voter < state.electors.length; voter++) if (voter !== state.byKey.prevost.ix) state.C[voter * state.electors.length + state.byKey.prevost.ix] += 70;
		const decisive = api.runScrutiny(state.byKey.parolin.ix);
		const unread = state.ballots.find((ballot) => ballot.void);
		assert(decisive.n === 4 && unread && unread.n === 4 && unread.paperCount === 134 && unread.roll.length === 0 && Array.from(unread.counts).every((value) => value === 0), "May 2025: the void scrutiny exposes an invented unread tally");
		assert(decisive.roll.find((vote) => vote.voter === "tagle").candidate === "parolin", "May 2025: the repeated decisive scrutiny rewrote the player's vote");

		api.newGame("tagle", "2025-runoff-law");
		api.startConclave();
		state = api.getState();
		const deadlockAnchors = [state.byKey.parolin.ix, state.byKey.prevost.ix, state.byKey.tagle.ix, state.byKey.erdo.ix];
		for (let voter = 0; voter < state.electors.length; voter++) {
			let target = deadlockAnchors[voter % deadlockAnchors.length];
			if (target === voter) target = deadlockAnchors[(voter + 1) % deadlockAnchors.length];
			state.C[voter * state.electors.length + target] += 35;
		}
		const pauses = [];
		let scheduleGuard = 0;
		while (api.totalValidBallots() < 34 && scheduleGuard++ < 80) {
			if (state.session === "pause") { pauses.push(api.totalValidBallots()); api.resumeAfterPause(); continue; }
			if (state.session === "lunch") { state.session = "pm"; state.slots = 1; state.slot = 0; continue; }
			if (state.session === "dinner") { api.advanceConclaveDay(); continue; }
			api.runScrutiny(state.byKey.parolin.ix);
			if (state.pauseDue != null || api.sessionBallotsLeft() <= 0) api.endSession();
		}
		if (state.session === "pause") { pauses.push(api.totalValidBallots()); api.resumeAfterPause(); }
		assert(JSON.stringify(pauses) === JSON.stringify([13, 20, 27, 34]), `May 2025: pause sequence was ${pauses.join(", ")}`);
		assert(state.runoff && api.threshNow() === 88 && state.session === "am", "May 2025: runoff did not begin after the fourth pause with an 88-vote threshold");

		const impossible = api.ELECTORS.filter((cardinal) => !api.theoreticalPlayerWin(cardinal.id));
		assert(impossible.length === 0, `May 2025: ${impossible.length} selectable cardinals cannot theoretically win`);
		const calibration = Array.from({ length: 24 }, (_, index) => api.runHeadless(`2025-calibration-${index}`, "prevost"));
		assert(calibration.filter((result) => result.winner === "prevost").length >= 12 && calibration.every((result) => result.ballots >= 1 && result.ballots <= 12), "May 2025: passive historical calibration has lost the documented shape");
		assert(calibration.every((result) => Number.isFinite(result.score.total) && result.score.grade && result.score.seriesScore === result.score.total && result.score.seriesScore >= 0 && result.score.seriesScore <= 100), "May 2025: end score is invalid");
		return ["data-audit", "full-portrait-coverage", "portrait-links", "portrait-attribution", "portrait-payload-budget", "chronology", "pause-law", "player-ballot-preserved", "terminal-guard", "acceptance-before-smoke", "uncertain-soundings", "exact-save-replay", "strict-save", "unread-void", "runoff-threshold", "all-player-viability", "historical-calibration", "end-score"];
	}
	if (variant.label === "venice-1800") {
		assert(typeof api.initState === "function" && typeof api.conductBallot === "function" && typeof api.getState === "function" && typeof api.activeElectors === "function" && typeof api.makeSounding === "function" && typeof api.resolveNetworkAction === "function" && typeof api.alignmentWithPlayer === "function" && typeof api.supportBriefCandidates === "function" && typeof api.positionMetricDetail === "function", "Venice: targeted-test API is not exported");
		api.initState("mattei", "venice-player-ballot", { headless: true });
		const state = api.getState();
		const validSave = JSON.parse(JSON.stringify(Object.assign({}, state, { rng: null, rngState: state.rng.state, savedAt: 1 })));
		assert(typeof api.validateVeniceSave === "function" && api.validateVeniceSave(validSave), "Venice: a valid saved conclave cannot be restored");
		const invalidSave = JSON.parse(JSON.stringify(validSave));
		invalidSave.metrics.trust = 101;
		assert(!api.validateVeniceSave(invalidSave), "Venice: an out-of-range saved metric was accepted");
		const positionDetails = ["stature", "trust", "secrecy", "exposure", "temporal", "adaptation"].map((key) => api.positionMetricDetail(key));
		assert(positionDetails.every((detail) => detail && Number.isInteger(detail.value) && detail.label && detail.level && detail.scope && detail.direction && detail.definition && detail.effect && detail.moves), "Venice: Your position explanations are incomplete");
		state.support.bellisomi = 100;
		state.metrics.austrianGrip = 100;
		api.conductBallot("bellisomi");
		const latest = api.getState().history.at(-1);
		const playerEntry = latest.roll.find((entry) => entry.voter === "mattei");
		assert(playerEntry && playerEntry.candidate === "bellisomi", "Venice: virtual-veto processing overwrote the human ballot");
		assert(!latest.roll.some((entry) => entry.voter === entry.candidate), "Venice: post-processing created a self-vote");
		api.initState("herzan", "venice-herzan", { headless: true });
		assert(!api.activeElectors().some((card) => card.id === "herzan"), "Venice: Herzan is active before arrival");
		api.conductBallot("bellisomi");
		const herzanState = api.getState();
		assert(!herzanState.history[0].roll.some((entry) => entry.voter === "herzan"), "Venice: Herzan voted before arrival");
		if (herzanState.over) assert(!herzanState.flags.herzanArrived, "Venice: Herzan arrived after an already terminal first ballot");
		else assert(api.activeElectors().some((card) => card.id === "herzan"), "Venice: Herzan did not arrive for the next round");
		api.initState("herzan", "venice-alignment", { headless: true });
		const matteiAlignment = api.alignmentWithPlayer("mattei");
		const bellisomiAlignment = api.alignmentWithPlayer("bellisomi");
		const openingBrief = api.supportBriefCandidates();
		assert(matteiAlignment.score > bellisomiAlignment.score, "Venice: imperial alignment guidance is miscalibrated");
		assert(openingBrief.length === 3 && openingBrief.every((choice) => choice.id !== "herzan" && Number.isInteger(choice.alignment.score) && choice.alignment.score >= 0 && choice.alignment.score <= 100), "Venice: opening support brief is invalid");
		api.initState("chiaramonti", "venice-presentation", { headless: true });
		const forecastState = api.getState();
		const rngBefore = forecastState.rng.state;
		const forecastFirst = JSON.stringify(api.forecastCounts());
		const forecastSecond = JSON.stringify(api.forecastCounts());
		assert(forecastFirst === forecastSecond && forecastState.rng.state === rngBefore, "Venice: soundings changed the simulation RNG");
		const openingForecast = JSON.parse(forecastFirst);
		assert(openingForecast.bellisomi > openingForecast.mattei, "Venice: opening calibration does not give Bellisomi the broader coalition");
		const stateBeforeSounding = JSON.stringify(forecastState);
		const soundingA = api.makeSounding();
		const soundingB = api.makeSounding();
		assert(JSON.stringify(soundingA) === JSON.stringify(soundingB) && JSON.stringify(forecastState) === stateBeforeSounding, "Venice: soundings are non-deterministic or mutate simulation state");
		assert(soundingA.rows.length > 0 && soundingA.rows.every((row) => Number.isInteger(row.low) && Number.isInteger(row.high) && row.low < row.high && !("count" in row) && !("total" in row)), "Venice: soundings expose exact counts or invalid ranges");
		assert(api.portraitFor("chiaramonti") && /assets\/portraits\/1800\/chiaramonti\.webp$/.test(api.portraitFor("chiaramonti").src) && api.portraitFor("martiniana") && api.portraitFor("carandini") === null, "Venice: portrait lookup or fallback is invalid");
		const networks = api.playerNetworks();
		assert(networks.includes("Monastic") && networks.includes("Compromise") && api.networkAccess(forecastState, "Monastic") > api.networkAccess(forecastState, "Austrian"), "Venice: Chiaramonti's network access is not calibrated to his identity");
		const networkResultA = JSON.stringify(api.resolveNetworkAction(forecastState, "Monastic", "chiaramonti"));
		api.initState("chiaramonti", "venice-presentation", { headless: true });
		const networkResultB = JSON.stringify(api.resolveNetworkAction(api.getState(), "Monastic", "chiaramonti"));
		assert(networkResultA === networkResultB, "Venice: identical network actions are not deterministic");
		api.initState("mattei", "venice-bellisomi-route", { headless: true });
		const alternateState = api.getState();
		alternateState.support.bellisomi = 100;
		alternateState.metrics.austrianGrip = 20;
		api.conductBallot("bellisomi");
		assert(api.getState().electedId === "bellisomi", "Venice: a decisive Bellisomi route remains impossible after the imperial ceiling is broken");
		const score = api.scoreGame();
		assert(Number.isFinite(score.total) && score.parts.reduce((sum, part) => sum + part.points, 0) === score.total && score.verdict && score.verdict.grade && Number.isInteger(score.seriesScore) && score.seriesScore >= 0 && score.seriesScore <= 100, "Venice: end score is invalid");
		assert(/Austrian-aligned/.test(api.axisPosition("austria", 1.1)) && !/very high|middle/.test(api.axisPosition("austria", 1.1)), "Venice: dossiers still use abstract rather than directional labels");
		return ["strict-save", "position-explanations", "player-ballot-preserved", "self-vote", "herzan-arrival", "alignment-guidance", "opening-support", "historical-opening", "uncertain-soundings", "portrait-lookup", "network-membership", "network-determinism", "alternate-winner", "end-score", "directional-profile"];
	}
	return [];
}

function runHeadlessChecks(variant, api) {
	const runner = api.runHeadless || api.windowOm && api.windowOm.runHeadless;
	assert(typeof runner === "function", `${variant.label}: no runHeadless export`);
	assert(api.__uiBooted, `${variant.label}: browser UI bootstrap did not run`);
	const cards = cardList(api);
	assertUniqueIds(variant.label, cards);
	const cardIds = new Set(cards.map((card) => card.id));
	for (const player of variant.players) {
		assert(cardIds.has(player), `${variant.label}: configured player ${player} does not exist`);
	}
	const players = full ? cards.map((card) => card.id) : quick ? [variant.quickPlayer] : variant.players;
	const winners = new Map();
	const winnersByPlayer = new Map(players.map((player) => [player, new Map()]));
	const ballotCounts = [];
	for (let seedIndex = 0; seedIndex < seedCount; seedIndex++) {
		for (const player of players) {
			const seed = `${variant.label}-${player}-${seedIndex}`;
			const playerCard = cards.find((card) => card.id === player);
			const runnerArgs = variant.label === "viterbo-1268" && playerCard && playerCard.optional
				? [seed, player, [player]]
				: [seed, player];
			let first;
			let second;
			try {
				first = runner(...runnerArgs);
				second = runner(...runnerArgs);
			} catch (error) {
				fail(`${variant.label}: runtime error for seed=${seed}, player=${player}: ${error && error.stack || error}`);
			}
			assert(JSON.stringify(first) === JSON.stringify(second), `${variant.label}: non-deterministic result for seed=${seed}, player=${player}`);
			if (variant.label === "viterbo-1268" && playerCard && playerCard.optional) {
				assert(Array.isArray(first.ids) && first.ids.includes(player) && first.cards && first.cards[player], `${variant.label}: optional player ${player} was not added to the electorate`);
			}
			const winner = winnerOf(first);
			assert(winner, `${variant.label}: unresolved run for seed=${seed}, player=${player}`);
			assert(knownCandidateIds(api).has(winner), `${variant.label}: unknown winner ${winner}`);
			const history = historyOf(first);
			assert(Array.isArray(history) && history.length > 0, `${variant.label}: completed run has no ballot history`);
			for (const ballot of history) assertBallotIntegrity(variant, api, ballot);
			const reportedBallots = Number.isInteger(first.ballots) ? first.ballots : history.length;
			assert(reportedBallots === history.length, `${variant.label}: reports ${reportedBallots} ballots but records ${history.length}`);
			winners.set(winner, (winners.get(winner) || 0) + 1);
			const playerWinners = winnersByPlayer.get(player);
			playerWinners.set(winner, (playerWinners.get(winner) || 0) + 1);
			ballotCounts.push(reportedBallots);
		}
	}
	ballotCounts.sort((a, b) => a - b);
	const targeted = runTargetedChecks(variant, api);
	return {
		mode: variant.modeLabel,
		runs: ballotCounts.length,
		players: players.length,
		playersTested: players,
		medianBallots: ballotCounts[Math.floor(ballotCounts.length / 2)] || 0,
		maxBallots: Math.max(...ballotCounts),
		winners: Object.fromEntries([...winners.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)),
		winnersByPlayer: Object.fromEntries([...winnersByPlayer].map(([player, distribution]) => [player, Object.fromEntries([...distribution.entries()].sort((a, b) => b[1] - a[1]))])),
		targeted,
	};
}

function checkStaticFiles() {
	const browserSmoke = fs.readFileSync(path.join(ROOT, "tests", "browser-smoke.js"), "utf8");
	const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
	const workflow = fs.readFileSync(path.join(ROOT, ".github", "workflows", "regression.yml"), "utf8");
	assert(packageJson.scripts && packageJson.scripts["test:browser"] === "node tests/browser-smoke.js", "project: browser regression script is not wired through package.json");
	assert(/checkConstanceChooserReturn/.test(browserSmoke) && /checkStickyChooser/.test(browserSmoke) && /checkCarafaStart/.test(browserSmoke), "project: browser suite lacks chooser-return, portrait-stacking, or mobile-start coverage");
	assert(/browser-smoke:/.test(workflow) && /weekly-all-player:/.test(workflow) && /schedule:/.test(workflow), "project: CI lacks browser or scheduled all-player gates");
	const index = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
	const hrefs = [...new Set([...index.matchAll(/href="\.\/([^"#?]+\.html)"/g)].map((match) => match[1]))];
	for (const href of hrefs) assert(fs.existsSync(path.join(ROOT, href)), `index links to missing file ${href}`);
	for (const variant of VARIANTS) assert(hrefs.includes(variant.file), `index does not link to ${variant.file}`);
	for (const variant of VARIANTS) {
		const html = fs.readFileSync(path.join(ROOT, variant.file), "utf8");
		assert(/index\.html/.test(html), `${variant.label}: no link back to the directory`);
		assert(/aria-live=/.test(html), `${variant.label}: toast/status announcements are not exposed to assistive technology`);
		assert(/prefers-reduced-motion/.test(html), `${variant.label}: no reduced-motion support`);
	}
	const romanDates = {1268:"MCCLXVIII",1378:"MCCCLXXVIII",1417:"MCDXVII",1458:"MCDLVIII",1492:"MCDXCII",1559:"MDLIX",1800:"MDCCC",1903:"MCMIII",1978:"MCMLXXVIII",2025:"MMXXV"};
	for (const [year, roman] of Object.entries(romanDates)) assert(index.includes(`<span class="year">${year}</span><span class="roman">${roman}</span>`), `index: missing Roman date ${roman} for ${year}`);
	assert(index.includes("The Keys of Heaven"), "index: 1492 still lacks its distinctive title");
	assert(/class="card beta" href="\.\/constance-1417\.html"[\s\S]*?<span class="status">Beta<\/span>/.test(index), "index: Constance 1417 is not promoted to beta");
	assert(/class="card beta" href="\.\/carafa-winter-1559\.html"[\s\S]*?<span class="status">Beta<\/span>/.test(index), "index: Carafa Winter 1559 is not promoted to beta");
	for (const [status, expected] of Object.entries({ complete: 1, beta: 3, alpha: 6 })) {
		const section = index.match(new RegExp(`<section class="status-group" aria-labelledby="${status}-heading">([\\s\\S]*?)<\\/section>`));
		assert(section, `index: ${status} status section is missing`);
		const cards = (section[1].match(/<a class="card(?: [^"]*)?"/g) || []).length;
		const shown = section[1].match(/<span class="group-count">(\d+) games?<\/span>/);
		assert(cards === expected && shown && Number(shown[1]) === cards, `index: ${status} count says ${shown ? shown[1] : "nothing"}, but contains ${cards} cards`);
		const years = Array.from(section[1].matchAll(/<span class="year">(\d{4})<\/span>/g), (match) => Number(match[1]));
		assert(years.every((year, i) => i === 0 || years[i - 1] < year), `index: ${status} cards are not in chronological order`);
	}
	assert(index.includes("assets/art/conclave-1878.webp") && fs.existsSync(path.join(ROOT, "assets", "art", "conclave-1878.webp")), "index: historical header engraving is missing");
	const anchors = {
		"1492.html": ["The Keys of Heaven"],
		"carafa-winter-1559.html": ["Porto e Santa Rufina", "S. Maria Nuova", "Marcellus III"],
		"venice-1800.html": ["Gregory XVI", "Leo XII"],
		"october-1978.html": ["Paul VII", "John XXIV", "Pius XIII"],
		"may-2025.html": ["General Congregation VIII", "One paper too many", "Leo XIV"],
		"constance-1417.html": ["Kaufhaus", "Veni Creator", "Frequens", "accedimus nos duo"],
		"accession-1458.html": ["Et ego Senensi Cardinali accedo", "Mihi te vermiculo commendas", "Pius II"],
		"april-1378.html": ["Romano lo volemo", "Sermo fugit a me", "ad martellum", "Ego non sum papa"],
	};
	for (const [file, required] of Object.entries(anchors)) {
		const html = fs.readFileSync(path.join(ROOT, file), "utf8");
		for (const text of required) assert(html.includes(text), `${file}: missing historical anchor ${text}`);
	}
	const feastNames = {
		"viterbo-1268.html": "Giles",
		"april-1378.html": "Dionysius I",
		"constance-1417.html": "Martin V",
		"accession-1458.html": "Louis I",
		"1492.html": "Tiburtius",
		"carafa-winter-1559.html": "Emmanuel I",
		"venice-1800.html": "Leobinus I",
		"1903.html": "Dominic I",
		"october-1978.html": "Gerard I",
	};
	for (const [file, name] of Object.entries(feastNames)) {
		const html = fs.readFileSync(path.join(ROOT, file), "utf8");
		assert(html.includes(name), `${file}: missing feast-day regnal option ${name}`);
		assert(/feast[_-]?(?:name|regnal)|feastName|feastDay|isLeobinusDate/i.test(html), `${file}: feast-day name is not tied to a dated rule`);
	}
	return VARIANTS.map((variant) => variant.file);
}

function workerMain(label) {
	const variant = VARIANTS.find((item) => item.label === label);
	assert(variant, `Unknown worker variant ${label}`);
	const api = loadVariant(variant.file);
	return runHeadlessChecks(variant, api);
}

function runWorker(variant) {
	return new Promise((resolve, reject) => {
		const childArgs = [__filename, `--worker=${variant.label}`, `--seeds=${seedCount}`];
		if (full) childArgs.push("--full");
		if (quick) childArgs.push("--quick");
		const timeoutMs = requestedTimeoutMs || (quick ? 120000 : Math.max(180000, seedCount * 90000));
		const child = spawn(process.execPath, childArgs, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`${variant.label}: worker exceeded ${timeoutMs} ms`));
		}, timeoutMs);
		child.on("error", (error) => { clearTimeout(timer); reject(error); });
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code !== 0) return reject(new Error(stderr.trim() || `${variant.label}: worker exited ${code}`));
			try { resolve(JSON.parse(stdout)); }
			catch (error) { reject(new Error(`${variant.label}: invalid worker output: ${stdout}\n${stderr}`)); }
		});
	});
}

async function main() {
	if (args.get("worker")) {
		process.stdout.write(JSON.stringify(workerMain(String(args.get("worker")))));
		return;
	}
	const indexLinks = checkStaticFiles();
	const results = await Promise.all(VARIANTS.map(runWorker));
	const variants = {};
	VARIANTS.forEach((variant, index) => { variants[variant.label] = results[index]; });
	console.log(JSON.stringify({ seedCount, quick, full, indexLinks, variants }, null, 2));
}

if (require.main === module) {
	main().catch((error) => {
		console.error(error && error.stack || error);
		process.exit(1);
	});
} else {
	module.exports = { VARIANTS, loadVariant, loadEngineWithoutDom, runHeadlessChecks, runTargetedChecks, checkStaticFiles };
}
