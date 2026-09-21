/**
 * Controller flow with a mocked Jev and a fake browser: debounce, one action per utterance,
 * stale-request handling, candidate picking by number, chaining commands in one breath.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Controller } from "../../src/controller.js";
import { DEBOUNCE_MS } from "../../src/constants.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeBrowser() {
  return {
    url: "https://example.com/",
    onChange() {
      return () => {};
    },
    tabInfo() {
      return [{ index: 0, url: this.url, active: true }];
    },
    async snapshot() {
      return {
        url: this.url,
        title: "Example",
        site: "example_com",
        searchBoxId: null,
        elements: [
          { id: "e01", role: "link", text: "More information" },
          { id: "e02", role: "link", text: "Other link" },
        ],
        tabs: this.tabInfo(),
      };
    },
    overlayCalls: [],
    async overlay(fn, ...args) {
      this.overlayCalls.push([fn, ...args]);
    },
  };
}

/** Mock Jev: keyword-driven answers, with configurable latency. */
function mockDecide({ latency = 20, complete = (t) => (t.split(" ").length >= 2 ? 0.9 : 0.1) } = {}) {
  const calls = [];
  const fn = async ({ transcript }, { signal } = {}) => {
    calls.push(transcript);
    await sleep(latency);
    if (signal?.aborted) {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }
    const t = transcript.toLowerCase();
    const ch = (c, conf = 0.95, extra = {}) => ({ type: "choice", choice: c, confidence: conf, probabilities: { [c]: conf, ...extra } });
    let intent = ch("none", 0.9);
    let target = ch("none", 0.9);
    if (t.startsWith("go back") || t.startsWith("вернись назад")) intent = ch("go_back");
    else if (t.startsWith("scroll")) intent = ch("scroll_down");
    else if (t.startsWith("click ambiguous")) {
      intent = ch("click_element");
      target = ch("e01", 0.2, { e02: 0.4, none: 0.2 });
    } else if (t.startsWith("click")) {
      intent = ch("click_element");
      target = ch("e01", 0.95);
    }
    return {
      answers: {
        intent,
        target,
        site: ch("none"),
        complete: { noul: complete(t) },
        is_command: { noul: intent.choice === "none" ? 0.1 : 0.95 },
        destructive: { noul: 0.02 },
        scroll_amount: { score: 1, confidence: 0.9, probabilities: {} },
        tab_direction: ch("none"),
      },
      latencyMs: latency,
      usage: { input_tokens: 1000, output_tokens: 10 },
      costUsd: 0.000042,
      model: "jev-1.13.0",
      requestId: "req",
      candidates: { text: [], url: [] },
      state: {},
      questionCount: 8,
    };
  };
  fn.calls = calls;
  return fn;
}

function setup(opts = {}) {
  const browser = fakeBrowser();
  const executed = [];
  const decideFn = opts.decideFn || mockDecide(opts);
  const executeFn = async (action) => {
    executed.push(action);
    await sleep(opts.execMs ?? 10);
    return { ok: true, detail: "ok" };
  };
  const c = new Controller({ browser, decideFn, executeFn });
  return { c, browser, executed, decideFn };
}

test("503 is reported without an action and the next command still works", async () => {
  const successful = mockDecide({ latency: 0 });
  let first = true;
  const decideFn = async (...args) => {
    if (!first) return successful(...args);
    first = false;
    throw Object.assign(new Error("no healthy upstream"), { status: 503 });
  };
  const { c, executed } = setup({ decideFn });
  const errors = [];
  const logs = [];
  c.on("service_error", (error) => errors.push(error));
  c.on("log", (entry) => logs.push(entry));
  await c.start();
  c.handleCommand("go back");
  await sleep(50);
  assert.equal(executed.length, 0);
  assert.equal(c.inflight.length, 0);
  assert.equal(errors[0].kind, "temporary");
  assert.match(errors[0].message, /503 no healthy upstream/);
  assert.ok(logs.some((entry) => entry.level === "error" && entry.msg === errors[0].message));
  c.handleCommand("go back");
  await sleep(50);
  assert.equal(executed.length, 1);
  await c.close();
});

test("timeout is a temporary service error", async () => {
  const error = Object.assign(new Error("request timed out"), { code: "ETIMEDOUT" });
  const { c, executed } = setup({ decideFn: async () => { throw error; } });
  const serviceError = new Promise((resolve) => c.once("service_error", resolve));
  await c.start();
  c.handleCommand("go back");
  assert.equal((await serviceError).kind, "temporary");
  assert.equal(executed.length, 0);
  assert.equal(c.inflight.length, 0);
  await c.close();
});

test("auth failures are reported separately from temporary failures", async () => {
  const error = Object.assign(new Error("invalid API key"), { status: 401 });
  const { c, executed } = setup({ decideFn: async () => { throw error; } });
  const serviceError = new Promise((resolve) => c.once("service_error", resolve));
  await c.start();
  c.handleCommand("go back");
  const reported = await serviceError;
  assert.equal(reported.kind, "auth");
  assert.match(reported.message, /authentication\/configuration error/i);
  assert.equal(executed.length, 0);
  await c.close();
});

test("debounces partials into one request and acts once per utterance", async () => {
  const { c, executed, decideFn } = setup();
  await c.start();
  c.handleTranscript({ text: "go", final: false, utteranceId: "u1" });
  await sleep(50);
  c.handleTranscript({ text: "go back", final: false, utteranceId: "u1" });
  await sleep(DEBOUNCE_MS + 150);
  assert.equal(executed.length, 1);
  assert.equal(executed[0].type, "go_back");
  assert.equal(decideFn.calls.length, 1, "first partial was debounced away");
  // the rest of the same utterance is ignored
  c.handleTranscript({ text: "go back please", final: true, utteranceId: "u1" });
  await sleep(DEBOUNCE_MS + 100);
  assert.equal(executed.length, 1);
  assert.equal(c.uiState().stats.calls, 1);
  assert.ok(c.uiState().stats.costUsd > 0);
  await c.close();
});

test("waits on an incomplete partial, then acts when the recognizer marks it final", async () => {
  const { c, executed } = setup();
  await c.start();
  c.handleTranscript({ text: "scroll", final: false, utteranceId: "u2" });
  await sleep(DEBOUNCE_MS + 100);
  assert.equal(executed.length, 0);
  assert.equal(c.lastDecision.policy.decision, "wait");
  c.handleTranscript({ text: "scroll", final: true, utteranceId: "u2" });
  await sleep(150);
  assert.equal(executed.length, 1);
  assert.equal(executed[0].type, "scroll_down");
  await c.close();
});

test("cancels stale in-flight requests beyond MAX_INFLIGHT", async () => {
  const { c, executed, decideFn } = setup({ latency: 400 });
  await c.start();
  c.handleTranscript({ text: "go", final: false, utteranceId: "u3" });
  await sleep(DEBOUNCE_MS + 20);
  c.handleTranscript({ text: "go ba", final: false, utteranceId: "u3" });
  await sleep(DEBOUNCE_MS + 20);
  c.handleTranscript({ text: "go back", final: false, utteranceId: "u3" });
  await sleep(DEBOUNCE_MS + 20);
  assert.equal(c.inflight.length, 2, "oldest request aborted, two in flight");
  await sleep(600);
  assert.equal(executed.length, 1);
  assert.equal(decideFn.calls.length, 3);
  await c.close();
});

test("ambiguous target shows numbered candidates; a spoken number picks without a model call", async () => {
  const { c, executed, browser, decideFn } = setup();
  await c.start();
  c.handleTranscript({ text: "click ambiguous thing", final: true, utteranceId: "u4" });
  await sleep(150);
  assert.equal(executed.length, 0);
  assert.ok(c.candidates, "candidates pending");
  assert.deepEqual(
    c.candidates.list.map((x) => x.id),
    ["e02", "e01"],
  );
  assert.ok(browser.overlayCalls.some(([fn]) => fn === "candidates"));
  const callsBefore = decideFn.calls.length;
  c.handleTranscript({ text: "the second one", final: true, utteranceId: "u5" });
  await sleep(100);
  assert.equal(executed.length, 1);
  assert.equal(executed[0].targetId, "e01");
  assert.equal(decideFn.calls.length, callsBefore, "no Jev call for the number");
  await c.close();
});

test("commands spoken in one breath: words after an executed command become a new command", async () => {
  const { c, executed } = setup();
  await c.start();
  c.handleTranscript({ text: "go back", final: false, utteranceId: "u6" });
  await sleep(DEBOUNCE_MS + 150);
  assert.equal(executed.length, 1);
  c.handleTranscript({ text: "go back scroll down", final: false, utteranceId: "u6" });
  await sleep(DEBOUNCE_MS + 150);
  assert.equal(executed.length, 2);
  assert.equal(executed[1].type, "scroll_down");
  // one trailing word is ignored
  c.handleTranscript({ text: "go back scroll down please", final: true, utteranceId: "u6" });
  await sleep(DEBOUNCE_MS + 150);
  assert.equal(executed.length, 2);
  await c.close();
});

test("typed command is treated as a final utterance", async () => {
  const { c, executed } = setup();
  await c.start();
  c.handleCommand("go back");
  await sleep(150);
  assert.equal(executed.length, 1);
  await c.close();
});

test("Russian closed-set command acts early and side-talk is ignored", async () => {
  const { c, executed } = setup();
  await c.start();
  c.handleTranscript({ text: "вернись назад", final: false, utteranceId: "ru1" });
  await sleep(DEBOUNCE_MS + 150);
  assert.equal(executed.length, 1);
  assert.equal(executed[0].type, "go_back");

  c.handleTranscript({ text: "Слушай, после работы давай поедим", final: true, utteranceId: "ru2" });
  await sleep(DEBOUNCE_MS + 100);
  assert.equal(executed.length, 1);
  await c.close();
});
