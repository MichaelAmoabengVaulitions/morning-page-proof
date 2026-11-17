import { CONFIDENCE_CUTOFF, GOAL_NOTE_DAYS, MORNING_END_HOUR, MORNING_START_HOUR } from "./config.mjs";
import {
  buildModelRequest, checkSentence, cleanReply, formatPageTime, getLocalParts,
  hasBlockedWord, isNoneReply, languageName, parseCreatedTime,
} from "./helpers.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

export async function runProof(exportData, { model, dryRun, sendRequest }) {
  const user = readUser(exportData);
  const { penEntries, skippedCount } = pickPenEntries(exportData.journal_entries);
  const proof = { model, dryRun, skippedCount, replyLanguage: user.replyLanguage, keyRejected: false, pages: [] };
  const usedGoalNotes = new Set();
  for (const entry of penEntries) {
    const page = preparePage(entry, user, usedGoalNotes);
    const finishedPage = page.outcome ? page : { ...page, ...(await askModel(page, proof, sendRequest)) };
    proof.keyRejected ||= finishedPage.keyRejected === true;
    proof.pages.push(finishedPage);
  }
  return proof;
}

function readUser(exportData) {
  const goals = exportData.north_star?.items;
  return {
    timeZone: exportData.user.timezone,
    replyLanguage: exportData.settings.language,
    goals: Array.isArray(goals) ? goals : [],
  };
}

export function pickPenEntries(entries) {
  const entriesById = new Map();
  for (const entry of entries) {
    if (!entriesById.has(entry.id)) entriesById.set(entry.id, entry);
  }
  const uniqueEntries = [...entriesById.values()];
  const penEntries = uniqueEntries.filter((entry) => entry.source === "pen");
  return { penEntries, skippedCount: uniqueEntries.length - penEntries.length };
}

export function preparePage(entry, user, usedGoalNotes = new Set()) {
  const pageText = typeof entry.ocr_text === "string" ? entry.ocr_text.trim() : "";
  const page = { id: entry.id, when: null, pageText, confidence: readConfidence(entry.ocr_confidence) };
  const created = parseCreatedTime(entry.created, user.timeZone);
  if (created.reason) return { ...page, outcome: "no_time", reason: created.reason };

  const local = getLocalParts(created.date, user.timeZone);
  const timedPage = { ...page, when: formatPageTime(local) };
  const earlyOutcome = findEarlyOutcome(local.hour, pageText, page.confidence);
  if (earlyOutcome) return { ...timedPage, outcome: earlyOutcome };

  const pageDay = Date.UTC(local.year, local.month - 1, local.day);
  return { ...timedPage, input: buildModelInput(pageText, user, pageDay, usedGoalNotes) };
}

// Anything that isn't a number from 0 to 1 counts as low confidence, so the model
// is never asked about a page we can't trust.
function readConfidence(value) {
  return typeof value === "number" && value >= 0 && value <= 1 ? value : null;
}

function findEarlyOutcome(hour, pageText, confidence) {
  if (!isMorning(hour)) return "not_morning";
  if (!pageText) return "empty_page";
  if (confidence === null || confidence < CONFIDENCE_CUTOFF) return "low_confidence";
  return null;
}

function isMorning(hour) {
  return hour >= MORNING_START_HOUR && hour < MORNING_END_HOUR;
}

function buildModelInput(pageText, user, pageDay, usedGoalNotes) {
  // Goals about sleep, health and the like stay out of the request, so the model can't bring them up.
  const goals = user.goals.filter((goal) => !hasBlockedWord(goal.title));
  const goalNote = pickGoalNote(goals, pageDay, usedGoalNotes);
  // A goal counts as used once its note is sent, so no goal gets a second note.
  if (goalNote) usedGoalNotes.add(goalNote);
  return {
    page_text: pageText,
    goals: goals.map((goal) => ({
      title: goal.title,
      status: goal.status,
      days_since_update: daysSinceUpdate(goal.updated, pageDay),
    })),
    goal_note: goalNote,
    style: { reply_language: languageName(user.replyLanguage), tone: "plain and short", emoji: false },
  };
}

function pickGoalNote(goals, pageDay, usedGoalNotes) {
  const noteGoal = goals.find((goal) =>
    goal.status === "stuck" &&
    !usedGoalNotes.has(goal.title) &&
    (daysSinceUpdate(goal.updated, pageDay) ?? 0) >= GOAL_NOTE_DAYS);
  return noteGoal ? noteGoal.title : null;
}

// Null when the date can't be read or is after the page, since then we can't say
// how long the goal had been stuck on that day.
function daysSinceUpdate(updated, pageDay) {
  const updatedDay = Date.parse(`${updated}T00:00:00Z`);
  if (Number.isNaN(updatedDay) || updatedDay > pageDay) return null;
  return Math.round((pageDay - updatedDay) / DAY_MS);
}

async function askModel(page, proof, sendRequest) {
  if (proof.dryRun) return { outcome: "not_run" };
  // Every later call would be rejected too, so stop sending once the key fails.
  if (proof.keyRejected) return { outcome: "model_failed", reason: "not sent, because the key was rejected" };

  const result = await sendRequest(buildModelRequest(proof.model, page.input, proof.replyLanguage));
  const call = { sent: true, seconds: result.seconds, cost: result.cost };
  if (result.error) return { ...call, outcome: "model_failed", reason: result.error, keyRejected: result.keyRejected };
  return { ...call, ...judgeReply(result.text) };
}

export function judgeReply(reply) {
  const sentence = cleanReply(reply);
  if (!sentence) return { outcome: "model_failed", reason: "the model sent an empty reply" };
  if (isNoneReply(sentence)) return { outcome: "model_said_none", reply: sentence };
  const problems = checkSentence(sentence);
  return { outcome: problems.length ? "failed_checks" : "shown", reply: sentence, problems };
}
