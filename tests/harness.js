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
	{ file: "1492.html", label: "1492", players: ["borgia", "giuliano", "sforza"], quickPlayer: "borgia", maxPicks: () => 3, threshold: (n) => Math.ceil(n * 2 / 3) },
	{ file: "viterbo-1268.html", label: "viterbo-1268", players: ["orsini", "annibale", "paltanieri"], quickPlayer: "orsini", maxPicks: (ballot) => ballot.turn <= 3 ? 3 : 2, threshold: (n) => Math.ceil(n * 2 / 3) },
	{ file: "carafa-winter-1559.html", label: "carafa-winter-1559", players: ["ccarafa", "medici", "morone"], quickPlayer: "medici", maxPicks: () => 3, threshold: (n) => Math.ceil(n * 2 / 3) },
	{ file: "venice-1800.html", label: "venice-1800", players: ["bellisomi", "mattei", "chiaramonti"], quickPlayer: "chiaramonti", maxPicks: () => 1, threshold: (n) => Math.ceil(n * 2 / 3) },
	{ file: "1903.html", label: "1903", players: ["rampolla", "sarto", "gibbons"], quickPlayer: "sarto", maxPicks: () => 1, threshold: (n) => Math.ceil(n * 2 / 3) },
	{ file: "october-1978.html", label: "october-1978", players: ["siri", "benelli", "wojtyla"], quickPlayer: "wojtyla", maxPicks: () => 1, threshold: (n) => Math.floor(n * 2 / 3) + 1 },
	{ file: "constance-1417.html", label: "constance-1417", players: ["colonna", "dailly", "polton"], quickPlayer: "colonna", maxPicks: () => 3, threshold: (n) => Math.ceil(n * 2 / 3) },
	{ file: "april-1378.html", label: "april-1378", players: ["deluna", "orsini", "geneva"], quickPlayer: "deluna", maxPicks: () => 1, threshold: (n) => Math.ceil(n * 2 / 3) },
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
	const selectionGrid = elements.get("#selgrid");
	if (!selectionGrid || !selectionGrid.children.length) throw new Error(`${file}: UI bootstrap rendered no selection cards`);
	return Object.assign({ __uiBooted: true, __uiCardsRendered: selectionGrid.children.length }, context.__EO_TEST_EXPORTS__, moduleObject.exports || {}, context.window.__om || {});
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
		const state = api.initState("borgia", "1492-validation", "open", []);
		const ballot = api.beginScrutiny(state, ["carafa", "carafa", "borgia", "not-a-cardinal"]);
		assert(JSON.stringify(ballot.votes.borgia) === JSON.stringify(["carafa"]), "1492: player approvals were not deduplicated and validated");
		const presentationState = api.initState("borgia", "1492-presentation", "open", []);
		const rngBefore = presentationState.rng.state;
		const oddsFirst = JSON.stringify(api.marketOdds(presentationState));
		const oddsSecond = JSON.stringify(api.marketOdds(presentationState));
		assert(oddsFirst === oddsSecond && presentationState.rng.state === rngBefore, "1492: opening the market changed the simulation RNG");
		return ["approval-validation", "presentation-rng"];
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
		return ["blank-ballot", "approval-validation", "accessus-validation", "illness-eligibility", "regnal-names"];
	}
	if (variant.label === "carafa-winter-1559") {
		assert(typeof api.initState === "function" && typeof api.beginScrutiny === "function" && typeof api.playerAccede === "function" && typeof api.getState === "function", "Carafa Winter: targeted-test API is not exported");
		let state = api.initState("medici", "carafa-opening", { headless: true });
		assert(api.present().length === 40 && api.voters().length === 40 && api.threshold() === 27, "Carafa Winter: opening attendance or threshold is wrong");
		let ballot = api.beginScrutiny([]);
		assert(Array.isArray(ballot.votes.medici) && ballot.votes.medici.length === 0, "Carafa Winter: an explicit blank ballot became an AI ballot");
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
		return ["attendance-40-to-44", "approval-validation", "accessus-validation", "illness-eligibility", "metric-bounds"];
	}
	if (variant.label === "1903") {
		assert(typeof api.initState === "function" && typeof api.makeSounding === "function" && typeof api.playerNetworks === "function" && typeof api.networkAccess === "function" && typeof api.resolveNetworkAction === "function" && typeof api.actionRouteCopy === "function" && typeof api.portraitFor === "function" && typeof api.scoreGame === "function", "1903: revised information/network/portrait/score API is not exported");
		const portrait = api.portraitFor("gibbons");
		assert(portrait && /assets\/portraits\/1903\/gibbons\.webp$/.test(portrait.src) && /en\.wikipedia\.org/.test(portrait.wikipedia) && !("source" in portrait) && api.portraitFor("sanminiatelli") === null, "1903: portrait link or fallback is invalid");
		let state = api.initState("gibbons", "1903-soundings", "historical");
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
		state = api.initState("gibbons", "1903-player-ballot", "historical");
		const record = api.simulateBallot(state, "rampolla");
		assert(record.votes.find((vote) => vote.voter === "gibbons").candidate === "rampolla", "1903: submitted player ballot was overwritten");
		const completed = api.runHeadless("1903-score", "gibbons", "historical");
		const score = api.scoreGame(completed);
		assert(Number.isFinite(score.total) && score.parts.reduce((sum, part) => sum + part.points, 0) === score.total && score.verdict && score.verdict.grade, "1903: end score is invalid");
		return ["portrait-lookup", "uncertain-soundings", "action-route-copy", "network-membership", "network-determinism", "player-ballot-preserved", "end-score"];
	}
	if (variant.label === "october-1978") {
		assert(typeof api.initState === "function" && typeof api.runBallot === "function" && typeof api.getState === "function" && typeof api.makeSounding === "function" && typeof api.networkAccess === "function" && typeof api.workNetwork === "function" && typeof api.portraitFor === "function" && typeof api.scoreGame === "function", "October 1978: targeted-test API is not exported");
		assert(cardList(api).length === 111 && api.THRESHOLD === 75, "October 1978: electorate or two-thirds-plus-one threshold is wrong");
		const portrait = api.portraitFor("villot");
		assert(portrait && /assets\/portraits\/1978\/villot\.webp$/.test(portrait.src) && /en\.wikipedia\.org/.test(portrait.wikipedia) && !("source" in portrait) && api.portraitFor("sidarouss") === null, "October 1978: portrait link or fallback is invalid");
		api.initState("villot", "october-soundings", { headless: true });
		const soundingState = JSON.stringify(api.getState());
		const soundingA = api.makeSounding("siri", 1);
		const soundingB = api.makeSounding("siri", 1);
		assert(JSON.stringify(soundingA) === JSON.stringify(soundingB) && JSON.stringify(api.getState()) === soundingState, "October 1978: sounding generation is non-deterministic or mutates state");
		assert(soundingA.candidates.length === 3 && soundingA.candidates.every((id) => api.ID[id] && id !== "siri") && !Object.hasOwn(soundingA, "score"), "October 1978: sounding is exact, invalid, or includes a self-candidate");
		assert(api.playerNetworks().includes("Curia") && api.playerNetworks().includes("Montinian"), "October 1978: Villot's modelled networks are not exposed");
		assert(api.networkAccess("Curia") > api.networkAccess("Africa"), "October 1978: membership does not improve network access");
		api.initState("villot", "october-network", { headless: true });
		const networkA = api.workNetwork("Curia", "curia", "villot");
		const networkStateA = JSON.stringify(api.getState());
		api.initState("villot", "october-network", { headless: true });
		const networkB = api.workNetwork("Curia", "curia", "villot");
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
		assert(Number.isFinite(score.total) && score.parts.reduce((sum, part) => sum + part.points, 0) === score.total && score.verdict && score.verdict.grade, "October 1978: end score is invalid");
		assert(/conciliar/.test(api.axisPosition("vatican2", 1.8)) && !/high|middle/.test(api.axisPosition("vatican2", 1.8)), "October 1978: dossier axes still use ambiguous magnitude labels");
		return ["portrait-lookup", "uncertain-soundings", "network-membership", "network-determinism", "player-ballot-preserved", "terminal-guard", "papal-name", "end-score", "directional-profile"];
	}
	if (variant.label === "constance-1417") {
		assert(typeof api.initState === "function" && typeof api.beginScrutiny === "function" && typeof api.playerAccede === "function" && typeof api.makeSounding === "function" && typeof api.thresholds === "function" && typeof api.electedNow === "function" && typeof api.validateData === "function" && typeof api.scoreGame === "function" && typeof api.papalNameForState === "function", "Constance: targeted-test API is not exported");
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
		const anchored = api.runHeadless("anchor", "polton", "historical");
		assert(anchored.winner === "colonna" && anchored.ballots <= 3, "Constance: the historical anchor did not elect Colonna by St Martin's morning");
		const finalRecord = anchored.history[anchored.history.length - 1];
		assert(Array.isArray(finalRecord.locks && finalRecord.locks.colonna) && finalRecord.locks.colonna.length === 6, "Constance: the anchor election did not turn all six locks");
		const anchorNeeds = api.thresholds(anchored);
		assert(Object.keys(anchorNeeds).every((key) => (finalRecord.colleges[key].colonna || 0) >= anchorNeeds[key]), "Constance: anchor tallies fall below a college threshold");
		const openA = api.runHeadless("constance-open", "dailly", "open");
		const openB = api.runHeadless("constance-open", "dailly", "open");
		assert(JSON.stringify(openA) === JSON.stringify(openB) && openA.winner && openA.ballots <= 12, "Constance: open-mode run is non-deterministic or fails to resolve within twelve scrutinies");
		for (const ballot of historyOf(openA)) assertBallotIntegrity(variant, api, ballot);
		const nameA = api.papalNameForState("constance-name", "saluzzo");
		const nameB = api.papalNameForState("constance-name", "saluzzo");
		assert(typeof nameA === "string" && nameA === nameB && / [IVXLCDM]+$/.test(nameA), "Constance: papal name is invalid or non-deterministic");
		assert(api.regnalOptionsFor("condulmer")[0] === "Eugene IV", "Constance: Condulmer's first regnal choice is not Eugene IV");
		const score = api.scoreGame(openA);
		assert(Number.isFinite(score.total) && score.parts.reduce((sum, part) => sum + part.points, 0) === score.total && score.verdict && score.verdict.grade, "Constance: end score is invalid");
		return ["data-audit", "six-college-rule", "blank-ballot", "approval-validation", "accession-validation", "no-first-scrutiny-accession", "player-ballot-preserved", "uncertain-soundings", "historical-anchor", "open-termination", "papal-name", "end-score"];
	}
	if (variant.label === "april-1378") {
		assert(typeof api.initState === "function" && typeof api.beginScrutiny === "function" && typeof api.makeSounding === "function" && typeof api.runHeadless === "function" && typeof api.validateData === "function" && typeof api.scoreGame === "function" && typeof api.papalNameForState === "function" && typeof api.regnalOptionsFor === "function" && typeof api.regnalSignalFor === "function" && typeof api.choosePlayerRegnalName === "function" && typeof api.axisPosition === "function" && typeof api.resolveDecision === "function" && typeof api.autoChoiceFor === "function", "April 1378: targeted-test API is not exported");
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
		assert(Number.isFinite(score.total) && score.parts.reduce((sum, part) => sum + part.points, 0) === score.total && score.verdict && score.verdict.grade, "April 1378: end score is invalid");
		return ["data-audit", "faction-arithmetic", "single-outsider", "historical-anchor", "documented-tally", "scrutiny-date", "orsini-withheld", "schism-onset", "blank-ballot", "player-ballot-preserved", "oral-validation", "uncertain-soundings", "open-termination", "player-drives-schism", "player-drives-unity", "italian-self-election", "papal-name", "regnal-choice", "directional-profile", "end-score"];
	}
	if (variant.label === "venice-1800") {
		assert(typeof api.initState === "function" && typeof api.conductBallot === "function" && typeof api.getState === "function" && typeof api.activeElectors === "function" && typeof api.makeSounding === "function" && typeof api.resolveNetworkAction === "function" && typeof api.alignmentWithPlayer === "function" && typeof api.supportBriefCandidates === "function", "Venice: targeted-test API is not exported");
		api.initState("mattei", "venice-player-ballot", { headless: true });
		const state = api.getState();
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
		assert(Number.isFinite(score.total) && score.parts.reduce((sum, part) => sum + part.points, 0) === score.total && score.verdict && score.verdict.grade, "Venice: end score is invalid");
		assert(/Austrian-aligned/.test(api.axisPosition("austria", 1.1)) && !/very high|middle/.test(api.axisPosition("austria", 1.1)), "Venice: dossiers still use abstract rather than directional labels");
		return ["player-ballot-preserved", "self-vote", "herzan-arrival", "alignment-guidance", "opening-support", "historical-opening", "uncertain-soundings", "portrait-lookup", "network-membership", "network-determinism", "alternate-winner", "end-score", "directional-profile"];
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
			ballotCounts.push(reportedBallots);
		}
	}
	ballotCounts.sort((a, b) => a - b);
	const targeted = runTargetedChecks(variant, api);
	return {
		runs: ballotCounts.length,
		players: players.length,
		medianBallots: ballotCounts[Math.floor(ballotCounts.length / 2)] || 0,
		maxBallots: Math.max(...ballotCounts),
		winners: Object.fromEntries([...winners.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)),
		targeted,
	};
}

function checkStaticFiles() {
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
	const anchors = {
		"carafa-winter-1559.html": ["Porto e Santa Rufina", "S. Maria Nuova", "Marcellus III"],
		"venice-1800.html": ["Gregory XVI", "Leo XII"],
		"october-1978.html": ["Paul VII", "John XXIV", "Pius XIII"],
		"constance-1417.html": ["Kaufhaus", "Veni Creator", "Frequens", "accedimus nos duo"],
		"april-1378.html": ["Romano lo volemo", "Sermo fugit a me", "ad martellum", "Ego non sum papa"],
	};
	for (const [file, required] of Object.entries(anchors)) {
		const html = fs.readFileSync(path.join(ROOT, file), "utf8");
		for (const text of required) assert(html.includes(text), `${file}: missing historical anchor ${text}`);
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

main().catch((error) => {
	console.error(error && error.stack || error);
	process.exit(1);
});
