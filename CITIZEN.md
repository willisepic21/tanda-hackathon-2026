# Citizen-science CAPTCHAs (Zooniverse)

In classify mode, the CAPTCHA asks the visitor a real research question about real photos, the way reCAPTCHA once used people to digitise books.

```html
<div class="foldpass" data-sitekey="…" data-task="classify"></div>
<!-- or -->
<fold-captcha site-key="…" task="classify"></fold-captcha>
```

By default it uses the live **SquirrelMapper** project's *"Just fox squirrels!"* workflow (project 8149, workflow 30253). The question is "How many squirrels are in this image?" with answers 0 / 1 / 2 or more. SquirrelMapper studies how urban squirrel populations evolve. Change the project with `ZOONIVERSE_PROJECT`, `ZOONIVERSE_WORKFLOW` and `ZOONIVERSE_TASK`. The task must be a single-answer question.

## How it works

1. **Fetch (public, no login):** the server reads the workflow's question and a pool of subjects that still need answers from the [Panoptes API](https://zooniverse.github.io/panoptes/) (`/workflows/:id`, `/subjects/queued`). Multi-image subjects are skipped.
2. **Challenge:** two photos. One has a known answer (crowd consensus), the other still needs answers, in random order. The visitor can't tell which is which, and the known answer never leaves the server. A small proof-of-work runs in the background.
3. **Check:**
   - A wrong answer on the known photo fails the CAPTCHA.
   - Answering faster than 1.5 s fails.
   - Answers only count toward consensus if the visitor passed a known-answer check. The exception is the bootstrap period before any consensus exists.
4. **Consensus:** a photo with ≥ 5 counted answers and ≥ 80% agreement gets a consensus answer and becomes a known-answer photo. If there's still no agreement after 10 answers, it's marked ambiguous.
5. **Output:** every answer is appended to `data/results/classifications.jsonl` with the device ID hashed. Per-photo vote totals are at `/api/data/citizen-consensus.csv`. The `/data` page shows both.

## Getting the answers to the researchers

The only route that actually counts is one the project agrees to. Zooniverse's guidance is that classifications submitted from outside zooniverse.org, and any automated classifying, need explicit permission from Zooniverse and the project team. Forwarding is therefore **off by default**.

1. Email the project team (each project has a contact page) and Zooniverse (contact@zooniverse.org). Explain what FoldPass is, share a sample of `citizen-consensus.csv`, and point out how answers are gated by known-answer checks.
2. One of two things happens next:
   - **They accept exports:** send them the CSV/JSONL periodically. No code changes needed.
   - **They approve API submission:** they register or approve an OAuth app, or a Zooniverse Custom Front End. Set `ZOONIVERSE_FORWARD=1` and `ZOONIVERSE_TOKEN=<bearer token>`. Each counted answer is then posted to `POST /api/classifications` as an incomplete classification of the first task (`server/citizen.js` → `forwardClassification`).

## Limitations

- **Bootstrap is the weak point.** Until the first consensus exists there's no known answer to check against, so early answers are trusted on PoW alone. A seeded set of expert-labelled photos would close that gap. Set `bootstrap: false` in `server/config.js` to count nothing until gold exists.
- **Answers are short-cut classifications.** CAPTCHA visitors only answer the workflow's first question, not its follow-up tasks (squirrel colour and so on). Researchers should treat them as a separate, lower-effort source.
- **Not every project suits this.** Untrained visitors can only answer easy questions. Tasks like white-blood-cell typing need training and would make a bad CAPTCHA.
