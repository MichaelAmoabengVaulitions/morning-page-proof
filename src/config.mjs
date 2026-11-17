import path from "node:path";
import { fileURLToPath } from "node:url";

const projectFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export const EXPORT_PATH = path.join(projectFolder, "data", "noor_user_export.json");
export const REPORT_PATH = path.join(projectFolder, "proof_results.md");

export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
// Small and cheap, which is all one short sentence needs. --model changes it.
export const DEFAULT_MODEL = "openai/gpt-4o-mini";
// Low, so the same page gives much the same sentence on each run.
export const TEMPERATURE = 0.2;
// Room for one sentence of 20 words, and it cuts off a reply that runs on.
export const MAX_TOKENS = 60;
// A home screen widget can't wait long, so a call that takes longer counts as failed.
export const TIMEOUT_MS = 20_000;
// The first try and one retry.
export const MAX_ATTEMPTS = 2;

// Below this the handwriting reading is too unsure to write a sentence about.
export const CONFIDENCE_CUTOFF = 0.7;
// A morning page is written from 05:00 up to 11:59 local time.
export const MORNING_START_HOUR = 5;
export const MORNING_END_HOUR = 12;
// A stuck goal gets a goal note once it hasn't moved for this many days.
export const GOAL_NOTE_DAYS = 14;
// About as much as the widget can show without cutting the sentence off.
export const WORD_LIMIT = 20;
// What the user sees whenever there is no checked sentence to show.
export const STANDARD_LINE = "Your page from this morning is saved.";

export const LANGUAGE_NAMES = { en: "English", nl: "Dutch", pt: "Portuguese" };

// Topics the sentence must never touch. They match whole words, so "mood" doesn't block "moodboard",
// and a * matches any ending, so "feel*" also blocks "feeling". "angst" is Dutch for anxiety.
export const BLOCKED_WORDS = [
  "anxi*", "angst*", "panic*", "depress*", "mood", "moods", "therap*", "pattern", "patterns",
  "stress*", "lonel*", "sad", "tired", "exhausted", "burnout", "burn out", "mental*", "health*",
  "feel*", "felt", "sleep*", "slept", "emotion*",
];
