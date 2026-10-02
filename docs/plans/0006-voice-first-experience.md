# Plan 0006 — Voice-first assistant experience

Status: in progress. Branch `feature/voice-first-experience`, created from `53732ab` (PR #4 merged). A product-experience iteration before hardening and deployment (not Milestone 5). Web only: no agent, provider, model, prompt, STT, API, OpenAPI, database or dependency change.

# Outcome

`/assistant` stops being "a chat with voice features" and becomes "a voice assistant with a text alternative": a full-height app shell whose main stage is the microphone, with the chat, transcript and timeline as secondary surfaces. It stays a turn-based flow (record, review, send, answer, speak), not a full-duplex or streaming conversation.

## Scope

Included:

- Two modes, **Voice** (initial) and **Text**, over one conversation held by `ChatPanel`; switching never clears messages or booking reviews.
- A visitor-started voice session: **Start voice assistant** speaks the fixed local welcome from the click itself (no model call, no turn, no conversation id, no counters, not in model history) and turns on automatic reading of *future* replies only; it never starts recording. **End voice session** cancels speech and turns auto-read off, keeping the conversation.
- A visual state machine driven by the real flow: ready, listening, transcribing, review ("Review what I heard", editable, Send / Record again / Cancel), thinking, speaking, error or unavailable. No timer-simulated states.
- Local voice quality: ranked English voices from `getVoices` / `voiceschanged`, a compact "Voice settings" panel (voice, speed, Preview, Reset), preferences (voice name and rate only) validated from `localStorage`.
- A new shell: 100dvh, internal scroll only, compact header, secondary drawers for transcript and timeline, the booking review prominent in the voice stage, restyled with the home page's palette.

Excluded: any external TTS, STT or agent change, `ConfirmForm` and its Server Action, `POST /v1/appointments`, privacy limits, new dependencies, deployment.

## Decisions

- **No new conversation mode.** `ChatPanel` keeps the turn engine; the voice stage and the text composer are two views of it. The recording logic moves from `VoiceInput` into a hook shared by both views; `VoiceInput` keeps its markup and tests.
- **Sending and Thinking are one real phase.** The turn is a single Server Action, so there is no honest signal to tell "sending" from "thinking": the stage shows one "Thinking" state whose text says the message was sent.
- **Reading is marked only when it starts.** A reply counts as read aloud when its first utterance reports `start`; an error or a refused start leaves it unread and the stage offers "Read reply aloud".
- **Network voices keep the ADR 0009 rule.** The ranking prefers local English voices (and, within a locality, names containing Natural, Enhanced, Premium or Online); a network voice, including a preferred "Online" one, is used only after an explicit "Use this online voice". The default is therefore the best *local* voice, not the best-named voice overall.
- **Preferences** store only `{ voice name, rate }` under `quillwheel.voice-settings.v1`; a stored voice that is gone, or any invalid value, falls back to the defaults.
- **Transcript in voice mode.** The live booking review is rendered once, in the voice stage; the transcript drawer shows a pointer to it instead of a second form.

## Approach (slices)

1. Voice selection and settings (pure ranking, preferences, controller changes, `onstart`). Tests: `speech-output`, `voice-selection`, `voice-preferences`.
2. Shared capture hook and its error copy; `VoiceInput` unchanged for the visitor. Tests: existing `VoiceInput`.
3. Shell, stage, drawers, session, auto-read, mode switch. Tests: new `VoiceExperience`, updated `ChatPanel`, page.
4. Styling pass (tokens, compact banner, reduced motion), responsive and accessibility fixes found in the browser.
5. Docs (`HARNESS`, `ARCHITECTURE`, ADR 0010), final checks, PR.

## Verification

Web: `gen:api` (no drift), Prettier, ESLint, typecheck, Vitest, build. API checks only if the API changes (it should not). Repository: `git diff --check`, secret scan, diff review. Browser pass with a scripted model and scripted STT on loopback, a throwaway Edge profile and a stub `speechSynthesis`: 1440, 390 and 320 px, 200% text, zoom 2x, Voice, Text, transcript, timeline, booking review, `agent_unavailable`, no microphone, microphone denied, no horizontal overflow, axe, keyboard and focus, clean console, loopback-only requests.

## Decisions or follow-ups

ADR 0010 records the stage/state model and the voice ranking rule. Not done here: real device voices and a real microphone (headless Edge only), other browsers, hands-free mode, hardening and deployment (Milestone 5).
