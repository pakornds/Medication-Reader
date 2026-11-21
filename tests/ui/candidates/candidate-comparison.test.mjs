import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { mountCandidateComparison } from "../../../src/components/candidates/candidate-comparison.mjs";

const fixture = JSON.parse(readFileSync(new URL(
  "../../../backend/tests/fixtures/contracts/transfer_case.json", import.meta.url,
), "utf8"));
const crop = fixture.response.rows.find(row => row.id === "row-c").reverse_crop;
const request = {
  evidence: fixture.request.evidence,
  observation: {
    row_id: "row-c", crop, imprint: { status: "unreadable" },
    shape: { status: "readable", value: "oval", evidence: crop },
    form: { status: "readable", value: "tablet", evidence: crop },
    color: { status: "readable", value: "blue", evidence: crop },
  },
};

function reference(id, differences = []) {
  return {
    reference_id: id,
    fictional_medication: id,
    image_reference: `/pill-candidates/references/${id}`,
    matches: ["shape: oval", "color: blue"], differences,
  };
}

const result = candidates => ({ row_id: "row-c", status: "unresolved", candidates, follow_up: "Check label evidence." });
const exampleRefs = [reference("demo-1"), reference("demo-2", ["imprint: B2"])];

function documentFixture() {
  const document = {
    createElement(tag) {
      const listeners = new Map();
      return {
        tag, ownerDocument: document, children: [], textContent: "",
        append(...children) { this.children.push(...children); },
        replaceChildren(...children) { this.children = children; },
        setAttribute() {},
        addEventListener(type, handler) { listeners.set(type, handler); },
        dispatch(type) { return listeners.get(type)?.({ preventDefault() {} }); },
        remove() { this.removed = true; },
      };
    },
  };
  return document.createElement("main");
}

function descendants(element) {
  return [element, ...element.children.flatMap(descendants)];
}

test("reference comparison updates after an imprint edit and keeps identity unresolved", async t => {
  const root = documentFixture();
  const calls = [];
  mountCandidateComparison(root, {
    request, cropUrl: "/fixture/crop.png",
    lookup: async value => {
      calls.push(value);
      return result(value.observation.imprint.value === "B2" ? [exampleRefs[1]] : exampleRefs);
    },
  });
  const form = descendants(root).find(element => element.tag === "form");
  await form.dispatch("submit");
  const before = descendants(root);
  assert.equal(before.filter(element => element.tag === "article").length, 2);
  assert.deepEqual(before.filter(element => element.tag === "img").map(image => image.src),
    ["/fixture/crop.png", "/pill-candidates/references/demo-1", "/pill-candidates/references/demo-2"]);
  assert.ok(before.some(element => element.textContent === "imprint: B2"));

  before.find(element => element.name === "imprint").value = " B2 ";
  form.dispatch("input");
  assert.equal(descendants(root).filter(element => element.tag === "article").length, 0);
  await form.dispatch("submit");
  const after = descendants(root);
  assert.equal(after.filter(element => element.tag === "article").length, 1);
  assert.ok(after.some(element => element.textContent.startsWith("Identity unresolved.")));
  assert.deepEqual(calls[1].observation.imprint, { status: "readable", value: "B2", evidence: crop });
  assert.deepEqual(request.observation.imprint, { status: "unreadable" });
  t.diagnostic(JSON.stringify({ initialReferences: 2, refreshedReferences: 1, identity: "unresolved" }));
});

test("late lookup results after an edit or unmount stay hidden", async () => {
  const root = documentFixture();
  const pending = [];
  const dispose = mountCandidateComparison(root, {
    request,
    lookup: (_value, signal) => {
      const deferred = Promise.withResolvers();
      pending.push({ ...deferred, signal });
      return deferred.promise;
    },
  });
  const form = descendants(root).find(element => element.tag === "form");
  const first = form.dispatch("submit");
  form.dispatch("input");
  assert.equal(pending[0].signal.aborted, true);
  pending[0].resolve(result(exampleRefs));
  await first;
  assert.ok(!descendants(root).some(element => element.tag === "article"));
  const second = form.dispatch("submit");
  dispose();
  assert.equal(pending[1].signal.aborted, true);
  pending[1].resolve(result(exampleRefs));
  await second;
  assert.ok(!descendants(root).some(element => element.tag === "article"));
});

test("an unexpected row response stays hidden and a subsequent refresh can retry", async () => {
  const root = documentFixture();
  let calls = 0;
  mountCandidateComparison(root, {
    request,
    lookup: async () => calls++ === 0 ? { ...result(exampleRefs), row_id: "other-row" } : result(exampleRefs),
  });
  const form = descendants(root).find(element => element.tag === "form");
  await form.dispatch("submit");
  assert.ok(descendants(root).some(element => element.textContent === "Candidate lookup failed. Refresh to try again."));
  assert.ok(!descendants(root).some(element => element.tag === "article"));
  await form.dispatch("submit");
  assert.equal(descendants(root).filter(element => element.tag === "article").length, 2);
});
