# Plan 0005 — Assistant-first navigation and visual polish

Status: in progress. Branch `feature/voice-ui-polish`, created from `b1ae052` (Milestone 4 squash on `main`). No provider, database or API change.

# Outcome

The assistant at `/assistant` is the only public way to start a booking, and it looks like part of the Quillwheel site instead of a form page: a branded header, a greeting that is not part of the model's conversation, a chat surface with a composer that holds the microphone, and the execution timeline as a secondary panel.

## Scope

Included:

- Every public booking entry point goes to `/assistant`; `/book` redirects there; the manual-form fallbacks and the fictional phone number are removed.
- A static greeting with quick actions that only fill the composer; `service` and `date` in the URL produce an editable draft, nothing else.
- After a recording, the transcript sits in the composer with **Send transcript** and **Record again**; there is still no auto-send.
- Visual redesign of `/assistant` with the existing palette, fonts and wheel; timeline relabelled "How this answer was made"; Listen/Stop inside the reply.

Excluded: agent, prompt, model, provider, evals, `POST /v1/appointments`, the confirm Server Action, privacy limits, speech normalization, new dependencies, deployment.

## Navigation decisions

- `/assistant?service=<id>&date=<YYYY-MM-DD>` is the only context a link carries. Both are validated (id shape, real calendar date; the service must also exist in the schedule service's list) and used **only** to pre-fill a visible, editable draft. A time in a URL is never read: the agent must offer times through `find_available_slots` in an earlier turn before `prepare_booking_review` accepts one, so nothing here can skip that.
- Home: the hero call to action, each service ("Ask about this service") and the availability results (one call to action per lookup) link to `/assistant`. Open times on the home page are informational text, not links, so no time ever travels in a URL. The lookup form stays as a read-only way to browse.
- `/book` becomes a redirect to `/assistant` (keeping only a well-formed `service`). `ConfirmForm`, its Server Action and `POST /v1/appointments` stay exactly where they are; they are now reachable only from the review card inside the chat.
- "Review again" / "Choose another time" in a stale, expired or conflicted review return to `/assistant` with the service and the local date of that review.
- Assistant unavailable: **Try again** and **Back to workshop**; no manual form.

## Visual architecture

- `AssistantHeader` (server): celeste band, small wheel, business name, "AI assistant" tag, "Back to workshop". Uses `Wheel`, `font-display`, existing tokens.
- `ChatPanel` keeps all state logic; it is re-skinned into a bordered conversation surface with the greeting first, message bubbles (user: bottle; assistant: celeste tint; system: rust edge) each with a text label, the review card inline, and the composer at the bottom.
- The composer is `sticky` only when the viewport is at least 44rem tall (a `rem` media query, so enlarged text turns it off); otherwise it flows with the page. The conversation gets matching bottom spacing so nothing is covered.
- The timeline is a right column from `lg` up and a collapsed `details` after the conversation below it.
- Recording state is conveyed by text (and a timer) as well as the pulsing dot; the pulse is `motion-safe` only.

## Accessibility and responsive

Targets: 1440, 390, 320 px and 200% text; no horizontal scroll; focus visible and ordered header → conversation → composer → timeline; every control labelled; no hover-only action; contrast uses the documented token pairs only; `aria-live` regions kept; axe clean in tests and in the browser pass.

## Tests

Updated or added at the layer that owns each behaviour: home (no phone, links to assistant), `ServiceList`, `SlotList`/availability, `/book` redirect, assistant page (no manual-form link, draft from URL), `ChatPanel` (greeting not sent, not spoken, quick actions do not submit, Try again / Back to workshop, transcript flow), `VoiceInput`, `Transcript`/review links, `ConfirmForm` (unchanged flow, new hrefs), `ExecutionTimeline` (safe events only), speech normalization untouched.

## Acceptance criteria

1. No text "Book with the form instead", no phone number, no link into `/book` anywhere in the public UI.
2. The greeting never appears in a `sendTurn` payload, does not change turn counters and is never passed to speech.
3. Nothing is sent without the visitor pressing Send / Send transcript / Enter.
4. All offline checks in `docs/HARNESS.md` pass; browser pass at 1440/390/320 px and 200% text is clean.
5. Zero provider and database calls; `.env` untouched.

## Verification

API suite, web suite and build, OpenAPI/client drift check, secret scan, diff review, and an offline browser pass against a scripted model on loopback with a throwaway profile.

## Decisions or follow-ups

No ADR expected (no architecture change). Follow-ups are listed in the pull request.
