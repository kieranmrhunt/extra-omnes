#!/usr/bin/env node
"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");

let chromium;
try {
	({ chromium } = require("playwright"));
} catch (error) {
	try {
		({ chromium } = require("playwright-core"));
	} catch (_) {
		throw error;
	}
}

const ROOT = path.resolve(__dirname, "..");
const VARIANTS = [
	"viterbo-1268.html",
	"april-1378.html",
	"constance-1417.html",
	"accession-1458.html",
	"1492.html",
	"carafa-winter-1559.html",
	"venice-1800.html",
	"1903.html",
	"october-1978.html",
];

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function contentType(file) {
	return ({ ".html": "text/html; charset=utf-8", ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml" })[path.extname(file).toLowerCase()] || "application/octet-stream";
}

function startServer() {
	return new Promise((resolve, reject) => {
		const server = http.createServer((request, response) => {
			const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
			const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
			const file = path.resolve(ROOT, requested);
			if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
				response.writeHead(403).end("Forbidden");
				return;
			}
			fs.readFile(file, (error, data) => {
				if (error) {
					response.writeHead(error.code === "ENOENT" ? 404 : 500).end("Not found");
					return;
				}
				response.writeHead(200, { "Content-Type": contentType(file), "Cache-Control": "no-store" });
				response.end(data);
			});
		});
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve(server));
	});
}

function addressOf(server) {
	const address = server.address();
	return `http://127.0.0.1:${address.port}`;
}

async function preparePage(browser, viewport) {
	const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
	const page = await context.newPage();
	const pageErrors = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.route("**/*", async (route) => {
		const url = new URL(route.request().url());
		if (url.hostname === "127.0.0.1") await route.continue();
		else await route.abort();
	});
	return { context, page, pageErrors };
}

async function pageGeometry(page) {
	return page.evaluate(() => ({
		innerWidth: window.innerWidth,
		scrollWidth: document.documentElement.scrollWidth,
		bodyWidth: document.body.scrollWidth,
		scrollY: window.scrollY,
	}));
}

async function smokeSelection(browser, baseUrl, file) {
	const { context, page, pageErrors } = await preparePage(browser, { width: 390, height: 844 });
	try {
		const response = await page.goto(`${baseUrl}/${file}`, { waitUntil: "domcontentloaded" });
		assert(response && response.ok(), `${file}: returned HTTP ${response && response.status()}`);
		await page.waitForFunction(() => document.querySelectorAll("#selgrid > *").length > 0);
		const cardCount = await page.locator("#selgrid > *").count();
		assert(cardCount > 0, `${file}: selection screen rendered no electors`);
		assert(await page.locator('a[href*="index.html"]').count(), `${file}: no directory link is available`);
		const unlabelledControls = await page.evaluate(() => [...document.querySelectorAll("#screen-select input, #screen-select select, #screen-select textarea")].filter((control) => {
			if (control.type === "hidden") return false;
			return !(control.labels && control.labels.length) && !control.getAttribute("aria-label") && !control.getAttribute("aria-labelledby") && !control.getAttribute("title");
		}).map((control) => control.id || control.name || control.outerHTML.slice(0, 80)));
		assert(unlabelledControls.length === 0, `${file}: unlabelled selection controls: ${unlabelledControls.join(", ")}`);
		const geometry = await pageGeometry(page);
		assert(geometry.scrollWidth <= geometry.innerWidth + 2 && geometry.bodyWidth <= geometry.innerWidth + 2, `${file}: mobile selection overflows horizontally (${geometry.scrollWidth}px in ${geometry.innerWidth}px)`);
		assert(pageErrors.length === 0, `${file}: browser error: ${pageErrors.join("; ")}`);
		return { file, cardCount, width: geometry.scrollWidth };
	} finally {
		await context.close();
	}
}

async function checkDialogFocus(browser, baseUrl, file, opener) {
	const { context, page, pageErrors } = await preparePage(browser, { width: 390, height: 844 });
	try {
		await page.goto(`${baseUrl}/${file}`, { waitUntil: "domcontentloaded" });
		await page.locator(opener).click();
		await page.locator('#modalhost:not(.hidden)[role="dialog"]').waitFor();
		for (let step = 0; step < 8; step++) {
			const inside = await page.evaluate(() => document.getElementById("modalhost").contains(document.activeElement));
			assert(inside, `${file}: keyboard focus escaped the open dialog`);
			await page.keyboard.press("Tab");
		}
		await page.keyboard.press("Escape");
		await page.waitForFunction(() => document.getElementById("modalhost").classList.contains("hidden"));
		const restored = await page.evaluate((selector) => document.activeElement === document.querySelector(selector), opener);
		assert(restored, `${file}: closing the dialog did not restore focus to its opener`);
		assert(pageErrors.length === 0, `${file}: browser error during dialog check: ${pageErrors.join("; ")}`);
	} finally {
		await context.close();
	}
}

async function checkCarafaStart(browser, baseUrl) {
	const file = "carafa-winter-1559.html";
	const { context, page, pageErrors } = await preparePage(browser, { width: 390, height: 844 });
	try {
		await page.goto(`${baseUrl}/${file}`, { waitUntil: "domcontentloaded" });
		await page.locator("#selgrid .ccard").first().click();
		await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
		await page.locator("#startbtn").click();
		for (let guard = 0; guard < 20; guard++) {
			const choice = page.locator(".overlay .choices button").first();
			if (!await choice.count()) break;
			await choice.click();
			await page.waitForTimeout(20);
		}
		await page.locator("#screen-game:not(.hidden)").waitFor();
		await page.waitForTimeout(100);
		const geometry = await pageGeometry(page);
		assert(geometry.scrollY <= 2, `${file}: a new mobile game opens ${geometry.scrollY}px down the page`);
		assert(geometry.scrollWidth <= geometry.innerWidth + 2, `${file}: mobile game overflows horizontally`);
		assert(pageErrors.length === 0, `${file}: browser error after starting: ${pageErrors.join("; ")}`);
	} finally {
		await context.close();
	}
}

async function check1458Filters(browser, baseUrl) {
	const file = "accession-1458.html";
	const { context, page, pageErrors } = await preparePage(browser, { width: 390, height: 844 });
	try {
		await page.goto(`${baseUrl}/${file}`, { waitUntil: "domcontentloaded" });
		await page.locator("#selgrid > *").first().waitFor();
		const result = await page.evaluate(() => {
			const segment = document.querySelector(".filterrow .segment");
			const difficulty = document.querySelector('[role="img"][aria-label^="Difficulty"]');
			const rect = segment && segment.getBoundingClientRect();
			return { segment: !!segment, difficulty: difficulty && difficulty.getAttribute("aria-label"), left: rect && rect.left, right: rect && rect.right, viewport: innerWidth };
		});
		assert(result.segment && result.difficulty, `${file}: mobile filters or accessible difficulty are missing`);
		assert(result.left >= -1 && result.right <= result.viewport + 1, `${file}: faction filter is clipped outside the viewport`);
		assert(pageErrors.length === 0, `${file}: browser error during filter check: ${pageErrors.join("; ")}`);
	} finally {
		await context.close();
	}
}

async function checkConstanceChooserReturn(browser, baseUrl) {
	const file = "constance-1417.html";
	const { context, page, pageErrors } = await preparePage(browser, { width: 390, height: 844 });
	try {
		await page.goto(`${baseUrl}/${file}`, { waitUntil: "domcontentloaded" });
		await page.locator("#selgrid > *").first().click();
		await page.locator("#startbtn").click();
		for (let guard = 0; guard < 8; guard++) {
			const option = page.locator("#decision .opts button").first();
			if (!await option.count()) break;
			await option.click();
		}
		await page.locator("#actColloquy:not([disabled])").click();
		await page.locator("#modalhost .chooser-list").waitFor();
		await page.locator("#modalhost .chooser-row .profile").first().click();
		await page.locator("#modalhost .closebar button", { hasText: "Back" }).click();
		await page.locator("#modalhost .chooser-list").waitFor();
		assert(await page.locator("#modalhost .chooser-controls").count(), `${file}: closing a dossier did not return to the colloquy chooser`);
		assert(pageErrors.length === 0, `${file}: browser error during chooser-return check: ${pageErrors.join("; ")}`);
	} finally {
		await context.close();
	}
}

async function checkStickyChooser(browser, baseUrl, file) {
	const { context, page, pageErrors } = await preparePage(browser, { width: 390, height: 844 });
	try {
		await page.goto(`${baseUrl}/${file}`, { waitUntil: "domcontentloaded" });
		await page.locator("#selgrid > *").first().click();
		await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
		const hit = await page.evaluate(() => {
			const button = document.getElementById("startbtn");
			const rect = button.getBoundingClientRect();
			const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
			return { buttonVisible: rect.width > 0 && rect.height > 0, buttonOnTop: target === button || button.contains(target), target: target && (target.id || target.className || target.tagName) };
		});
		assert(hit.buttonVisible && hit.buttonOnTop, `${file}: a portrait or card covers the sticky chooser (${hit.target})`);
		assert(pageErrors.length === 0, `${file}: browser error during sticky chooser check: ${pageErrors.join("; ")}`);
	} finally {
		await context.close();
	}
}

async function checkIndexGeometry(browser, baseUrl, viewport) {
	const { context, page, pageErrors } = await preparePage(browser, viewport);
	try {
		await page.goto(`${baseUrl}/index.html`, { waitUntil: "domcontentloaded" });
		assert(await page.locator("a.card").count() === VARIANTS.length, "index.html: directory card count is wrong");
		const geometry = await pageGeometry(page);
		assert(geometry.scrollWidth <= geometry.innerWidth + 2, `index.html: ${viewport.width}px layout overflows horizontally`);
		assert(pageErrors.length === 0, `index.html: browser error: ${pageErrors.join("; ")}`);
	} finally {
		await context.close();
	}
}

async function main() {
	const server = await startServer();
	let browser;
	try {
		const launchOptions = { headless: true };
		if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
		browser = await chromium.launch(launchOptions);
		const baseUrl = addressOf(server);
		const selections = [];
		await checkIndexGeometry(browser, baseUrl, { width: 390, height: 844 });
		await checkIndexGeometry(browser, baseUrl, { width: 1365, height: 768 });
		for (const file of VARIANTS) selections.push(await smokeSelection(browser, baseUrl, file));
		await checkDialogFocus(browser, baseUrl, "april-1378.html", "#rulesBtn");
		await checkDialogFocus(browser, baseUrl, "constance-1417.html", "#helpSelect");
		await checkCarafaStart(browser, baseUrl);
		await check1458Filters(browser, baseUrl);
		await checkConstanceChooserReturn(browser, baseUrl);
		await checkStickyChooser(browser, baseUrl, "1903.html");
		await checkStickyChooser(browser, baseUrl, "october-1978.html");
		console.log(JSON.stringify({ variants: selections, checks: ["mobile-and-desktop-geometry", "dialog-focus", "chooser-return", "sticky-portrait-stacking", "carafa-start-position", "1458-filter-strip"] }, null, 2));
	} finally {
		if (browser) await browser.close();
		await new Promise((resolve) => server.close(resolve));
	}
}

main().catch((error) => {
	console.error(error && error.stack || error);
	process.exitCode = 1;
});
