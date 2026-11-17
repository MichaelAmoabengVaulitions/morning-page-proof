import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { STANDARD_LINE } from "../src/config.mjs";
import { buildModelRequest, buildReport, checkSentence, cleanReply, isNoneReply, parseCreatedTime } from "../src/helpers.mjs";
import { judgeReply, pickPenEntries, preparePage, runProof } from "../src/morning_page.mjs";

const TIME_ZONE = "Europe/Lisbon";
const DRY_RUN = { model: "test/model", dryRun: true };

function makeEntry(fields = {}) {
  return {
    id: "page_1",
    source: "pen",
    created: "2026-10-21T06:49:00Z",
    ocr_text: "send the plan to Ana before lunch",
    ocr_confidence: 0.9,
    ...fields,
  };
}

function makeUser(fields = {}) {
  return { timeZone: TIME_ZONE, replyLanguage: "en", goals: [], ...fields };
}

function makeExport(entries, fields = {}) {
  return {
    user: { timezone: TIME_ZONE },
    settings: { language: "en" },
    north_star: { items: [] },
    journal_entries: entries,
    ...fields,
  };
}

function utcTime(created) {
  return parseCreatedTime(created, TIME_ZONE).date.toISOString();
}

describe("reading the page time", () => {
  it("gets the local hour right on both sides of the clock change", () => {
    assert.equal(preparePage(makeEntry({ created: "2026-10-21T06:49:00Z" }), makeUser()).when, "Wed 21 Oct 07:49");
    assert.equal(preparePage(makeEntry({ created: "2026-10-29T07:53:00Z" }), makeUser()).when, "Thu 29 Oct 07:53");
  });

  it("reads a time with no zone as the user's local time", () => {
    assert.equal(utcTime("2026-09-03 08:01"), "2026-09-03T07:01:00.000Z");
    assert.equal(utcTime("2026-10-24 07:30"), "2026-10-24T06:30:00.000Z");
    assert.equal(utcTime("2026-10-26 07:30"), "2026-10-26T07:30:00.000Z");
  });

  it("uses the user's time zone from the export", () => {
    const page = preparePage(makeEntry({ created: "2026-10-21T12:49:00Z" }), makeUser({ timeZone: "America/New_York" }));
    assert.equal(page.when, "Wed 21 Oct 08:49");
  });

  it("reads a number as milliseconds since 1970", () => {
    assert.equal(utcTime(Date.UTC(2026, 9, 21, 6, 49)), "2026-10-21T06:49:00.000Z");
  });

  it("skips a page with no usable time and says why", () => {
    for (const created of [undefined, null, "", "18-10-2026", "not a timeT"]) {
      const page = preparePage(makeEntry({ created }), makeUser());
      assert.equal(page.outcome, "no_time", String(created));
      assert.ok(page.reason);
    }
    assert.match(preparePage(makeEntry({ created: "18-10-2026" }), makeUser()).reason, /no time of day/);
  });
});

describe("choosing pages", () => {
  const outcomeAt = (clock) => {
    const page = preparePage(makeEntry({ created: `2026-10-21 ${clock}` }), makeUser());
    return page.outcome ?? "sent to the model";
  };

  it("counts 05:00 to 11:59 as morning", () => {
    assert.equal(outcomeAt("04:59"), "not_morning");
    assert.equal(outcomeAt("05:00"), "sent to the model");
    assert.equal(outcomeAt("11:59"), "sent to the model");
    assert.equal(outcomeAt("12:00"), "not_morning");
  });

  it("keeps pen entries once each and counts the ones it skipped", () => {
    const entries = [makeEntry({ id: "a" }), makeEntry({ id: "a" }), makeEntry({ id: "b", source: "typed" })];
    const { penEntries, skippedCount } = pickPenEntries(entries);
    assert.deepEqual(penEntries.map((entry) => entry.id), ["a"]);
    assert.equal(skippedCount, 1);
  });

  it("doesn't send an empty page to the model", () => {
    for (const pageText of [undefined, "", "   \n "]) {
      assert.equal(preparePage(makeEntry({ ocr_text: pageText }), makeUser()).outcome, "empty_page");
    }
  });

  it("treats a confidence that isn't a number from 0 to 1 as low", () => {
    for (const confidence of [undefined, "0.9", 93, -0.2]) {
      const page = preparePage(makeEntry({ ocr_confidence: confidence }), makeUser());
      assert.equal(page.outcome, "low_confidence", String(confidence));
    }
  });

  it("sends a page at exactly 0.70 and stops one at 0.69", () => {
    assert.equal(preparePage(makeEntry({ ocr_confidence: 0.7 }), makeUser()).outcome, undefined);
    assert.equal(preparePage(makeEntry({ ocr_confidence: 0.69 }), makeUser()).outcome, "low_confidence");
  });
});

describe("goals", () => {
  const stuckGoal = { title: "Portfolio site", status: "stuck", updated: "2026-10-07" };
  const goalNoteOn = (day, goals) => preparePage(makeEntry({ created: `${day} 08:00` }), makeUser({ goals })).input.goal_note;

  it("works when north_star or its items are missing", async () => {
    for (const northStar of [undefined, {}]) {
      const proof = await runProof(makeExport([makeEntry()], { north_star: northStar }), DRY_RUN);
      assert.deepEqual(proof.pages[0].input.goals, []);
    }
  });

  it("adds a goal note after 14 days stuck, not after 13", () => {
    assert.equal(goalNoteOn("2026-10-21", [stuckGoal]), "Portfolio site");
    assert.equal(goalNoteOn("2026-10-20", [stuckGoal]), null);
  });

  it("gives a goal note once per goal", async () => {
    const entries = [makeEntry({ id: "a", created: "2026-10-21 08:00" }), makeEntry({ id: "b", created: "2026-10-22 08:00" })];
    const proof = await runProof(makeExport(entries, { north_star: { items: [stuckGoal] } }), DRY_RUN);
    assert.deepEqual(proof.pages.map((page) => page.input.goal_note), ["Portfolio site", null]);
  });

  it("ignores an update date that is invalid or after the page", () => {
    for (const updated of ["not a date", undefined, "2026-10-25"]) {
      assert.equal(goalNoteOn("2026-10-21", [{ ...stuckGoal, updated }]), null, String(updated));
    }
  });

  it("doesn't send goals about sensitive topics", () => {
    const sleepGoal = { title: "Sleep before midnight", status: "stuck", updated: "2026-09-01" };
    const page = preparePage(makeEntry(), makeUser({ goals: [sleepGoal, stuckGoal] }));
    assert.deepEqual(page.input.goals.map((goal) => goal.title), ["Portfolio site"]);
  });
});

describe("the model request", () => {
  it("asks only for providers that don't keep the data", () => {
    const request = buildModelRequest("test/model", preparePage(makeEntry(), makeUser()).input, "en");
    assert.deepEqual(request.provider, { data_collection: "deny" });
    assert.equal(request.temperature, 0.2);
    assert.match(request.messages[0].content, /in English/);
    assert.equal(JSON.parse(request.messages[1].content).page_text, "send the plan to Ana before lunch");
  });
});

describe("the model reply", () => {
  it("removes quotes, line breaks and extra spaces", () => {
    assert.equal(cleanReply('"Send the plan to Ana."'), "Send the plan to Ana.");
    assert.equal(cleanReply("“Send the plan\nto  Ana.”\n"), "Send the plan to Ana.");
  });

  it("reads NONE in its different spellings", () => {
    for (const reply of ["NONE", "None", "NONE.", "  none  ", "NONE\n"]) {
      assert.equal(isNoneReply(reply), true, reply);
    }
    assert.equal(isNoneReply("None of the plan is done yet."), false);
  });

  it("gives each kind of reply the right outcome", () => {
    assert.equal(judgeReply("   ").outcome, "model_failed");
    assert.equal(judgeReply(undefined).outcome, "model_failed");
    assert.equal(judgeReply("NONE.").outcome, "model_said_none");
    assert.equal(judgeReply("Send the plan to Ana!").outcome, "failed_checks");
    assert.deepEqual(judgeReply('"Send the plan to Ana."'), { outcome: "shown", reply: "Send the plan to Ana.", problems: [] });
  });
});

describe("sentence checks", () => {
  it("passes a plain sentence", () => {
    assert.deepEqual(checkSentence("Send the moodboard to Ana before lunch."), []);
  });

  it("fails each rule with a clear reason", () => {
    const cases = [
      ["Send the plan. Then call Ana.", /more than one sentence/],
      [`${Array(21).fill("word").join(" ")}.`, /21 words/],
      ["Send the plan to Ana!", /exclamation/],
      ["Send the plan to Ana \u{1F642}", /emoji/],
    ];
    for (const [sentence, reason] of cases) assert.match(checkSentence(sentence).join(), reason, sentence);
    assert.deepEqual(checkSentence(`${Array(20).fill("word").join(" ")}.`), []);
  });

  it("blocks words about feelings, health and sleep as whole words", () => {
    for (const word of ["sleep", "slept", "health", "mood", "feeling", "anxious"]) {
      assert.match(checkSentence(`Plan the ${word} part today.`).join(), /blocked word/, word);
    }
  });
});

describe("a dry run on a small made-up export", () => {
  const entries = [
    makeEntry({ id: "morning" }),
    makeEntry({ id: "evening", created: "2026-10-21T20:30:00Z" }),
    makeEntry({ id: "blurry", ocr_confidence: 0.41 }),
    makeEntry({ id: "blank", ocr_text: "" }),
    makeEntry({ id: "undated", created: "18-10-2026" }),
    makeEntry({ id: "typed", source: "typed" }),
  ];

  it("gives each page one outcome without calling the model", async () => {
    const sendRequest = () => assert.fail("a dry run must not call the model");
    const proof = await runProof(makeExport(entries), { ...DRY_RUN, sendRequest });
    assert.deepEqual(proof.pages.map((page) => [page.id, page.outcome]), [
      ["morning", "not_run"],
      ["evening", "not_morning"],
      ["blurry", "low_confidence"],
      ["blank", "empty_page"],
      ["undated", "no_time"],
    ]);
  });

  it("writes a report with the model parts marked as not run", async () => {
    const report = buildReport(await runProof(makeExport(entries), DRY_RUN));
    assert.match(report, /dry run/);
    assert.match(report, /skipped the 1 typed and voice entries/);
    assert.match(report, /Pages that would be sent to the model: 1/);
    assert.ok(report.includes(STANDARD_LINE));
  });
});

describe("a run with a fake model", () => {
  it("turns each reply into an outcome and sums up the run", async () => {
    const entries = ["good", "loud", "nothing", "broken"].map((id) => makeEntry({ id, ocr_text: id }));
    const replies = {
      good: { text: "Send the plan to Ana.", cost: 0.0002, seconds: 1 },
      loud: { text: "Call Ana!", cost: 0.0002, seconds: 2 },
      nothing: { text: "NONE", cost: 0.0001, seconds: 3 },
      broken: { error: "couldn't reach OpenRouter", seconds: 2 },
    };
    const sendRequest = async (request) => replies[JSON.parse(request.messages[1].content).page_text];
    const proof = await runProof(makeExport(entries), { model: "test/model", dryRun: false, sendRequest });
    assert.deepEqual(proof.pages.map((page) => page.outcome), ["shown", "failed_checks", "model_said_none", "model_failed"]);

    const report = buildReport(proof);
    assert.match(report, /Pages sent to the model: 4/);
    assert.match(report, /Sentences that passed the checks: 1/);
    assert.match(report, /Average time per call: 2\.0 seconds/);
    assert.match(report, /\$0\.00050/);
    assert.equal(report.split(STANDARD_LINE).length - 1, 3);
  });

  it("says when OpenRouter didn't report the cost", async () => {
    const sendRequest = async () => ({ text: "Send the plan to Ana.", cost: null, seconds: 1 });
    const proof = await runProof(makeExport([makeEntry()]), { model: "test/model", dryRun: false, sendRequest });
    assert.match(buildReport(proof), /didn't report the cost/);
  });

  it("stops sending pages once the key is rejected", async () => {
    let callCount = 0;
    const sendRequest = async () => {
      callCount += 1;
      return { error: "the key was rejected", keyRejected: true, seconds: 0.1 };
    };
    const proof = await runProof(makeExport([makeEntry({ id: "a" }), makeEntry({ id: "b" })]), {
      model: "test/model",
      dryRun: false,
      sendRequest,
    });
    assert.equal(callCount, 1);
    assert.deepEqual(proof.pages.map((page) => page.outcome), ["model_failed", "model_failed"]);
  });
});

describe("the report", () => {
  it("keeps page text with quotes, line breaks and markdown on one line", async () => {
    const proof = await runProof(makeExport([makeEntry({ ocr_text: 'call "Ana"\nthen *finish* the ~~plan~~' })]), DRY_RUN);
    const pageLine = buildReport(proof).split("\n").find((line) => line.startsWith("- What was written:"));
    assert.equal(pageLine, '- What was written: "call "Ana" / then \\*finish\\* the \\~\\~plan\\~\\~"');
  });
});
