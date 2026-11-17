# Morning Page proof

I wrote this proof to run the Morning Page logic on Noor's pen pages. It writes `proof_results.md`, a page by page report of what she would have seen on her home screen each morning.

Morning Page works like this. When a user writes a page with the pen in the morning, a small model is asked for one short sentence about it, and ordinary code checks that sentence. If the check fails, or anything else goes wrong, the user sees the standard line "Your page from this morning is saved." instead.

## How to run it

You need Node 18 or newer. There is nothing to install.

Put the export at `data/noor_user_export.json`. It isn't in the repository, because the brief asks us not to publish it.

To try it without a key and without any network calls:

```
node src/run.mjs --dry-run
```

This prints what would be sent to the model for each page, and writes the report with the model parts marked as not run.

To call the model, run it without the flag. The script reads the key from `OPENROUTER_API_KEY`, or asks for it at a prompt where typing is hidden. The key is never written anywhere.

```
node src/run.mjs
node src/run.mjs --model openai/gpt-4o-mini
```

To run the tests:

```
node --test
```

## What the report shows

For each pen page, the report gives the local day and time, what was written, the handwriting confidence, what the model returned, whether the checks passed, what the user would see and how long the call took. It ends with how many pages went to the model, how many sentences passed, the average time per call and the total cost OpenRouter reported.

Each page ends in one outcome:

- `not_morning` or `no_time`: written outside 05:00 to 11:59, or with no time of day. The page is skipped.
- `empty_page` or `low_confidence`: nothing to read, or handwriting confidence below 0.70. The standard line is shown and the model isn't called.
- `model_failed`, `model_said_none` or `failed_checks`: the standard line is shown.
- `shown`: the sentence is shown.
- `not_run`: a dry run, so the model wasn't called.

## Choices I made

I kept the proof to pen pages. Noor already writes with the pen every weekday morning, so that is the path worth proving first. Typed and voice users would get a sentence from their entry the evening before, which is the second version of the feature.

Goals about sleep or health are never sent to the model, and every request asks OpenRouter for providers that don't keep or train on the data.

If OpenRouter rejects the key, the script stops calling the model for the remaining pages, since every call would fail the same way. Rate limits, server errors and timeouts get one retry.

## What I would add next

- A check that the sentence is in the user's reply language. For now only the prompt asks for it.
- A check that the sentence doesn't name people who aren't on the page.
- A sentence count that doesn't treat "e.g." or a time like "8.30" as the end of a sentence.

## Files

- `src/run.mjs` reads the flags, the key and the export, calls OpenRouter and writes the report.
- `src/morning_page.mjs` decides what happens to each page.
- `src/helpers.mjs` holds the time handling, the model request, the sentence checks and the report text.
- `src/config.mjs` holds the cut-off, hours, word limit, standard line and other fixed values.
- `test/` has the tests, which use small made-up pages and a fake OpenRouter.
