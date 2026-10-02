# Plan 0006 — Voice-first assistant experience

Status: completed. Branch `feature/voice-first-experience`, created from `53732ab` (PR #4 merged). A product-experience iteration before hardening and deployment (not Milestone 5). Web only: no agent, provider, model, prompt, STT, API, OpenAPI, database or dependency change.

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

Result: all offline web checks passed (`gen:api` without drift, Prettier with the existing policy, ESLint, typecheck, Vitest, production build); the API, `openapi.json`, the agent, the transcription route, `ConfirmForm` and `POST /v1/appointments` were not touched, so the API checks were not run. The browser rehearsals (scripted model and speech-to-text on loopback, throwaway Edge profile, stub `speechSynthesis`, fake microphone, no provider) were clean at 1440, 390 and 320 px, 200% text (real browser font size) and 720x450 (zoom 2x): no horizontal overflow, axe clean, no console messages, only loopback requests, a visible focus ring, and a focus order of header, modes, panel buttons, stage. Defects found by the rehearsals and fixed: `sr-only` elements escaped the scroll containers and made the document scroll; the panel buttons and the chrome left no room for the main control on a 320x568 screen (compact header and banner, a "More" menu below `lg`, hint moved under the control); the empty activity panel was a scroll region with no keyboard access; focus fell to the page when the review text box was removed after Send. Known limits: at 200% text or 720x450 the Stop and Send controls sit below the first screen of the stage and are reached by its own scroll; switching Voice and Text while **Confirm booking** is in flight remounts the form (the Server Action and its redirect are not affected); the "Online" voices are used only after an explicit opt-in, so the automatic voice is the best local one; a real microphone, device voices, a phone, a screen reader and browsers other than Edge were not exercised.

## Follow-up after manual acceptance (2026-10-02)

Feedback from a hands-on session (still no provider, no Groq, no Supabase): the favourite voice was a browser network voice; the design had improved; the centre control needed to feel alive; Voice repeated the whole introduction after a Text conversation; Voice felt like a chat because every transcript had to be reviewed and sent; and old history competed with the stage. Changes, all web-only:

- **Network voices.** Plain-words explanation (no claim about any provider), the exact voice and a Local/Network indicator, "Back to the recommended voice", and an agreement the visitor gives to a voice they picked themselves is remembered in this browser for that exact voice (`consentVoice`); anything else lasts for the page. No voice name is hard-coded and nothing is sent to the server.
- **Live orb.** One SVG with a distinct animation per state; Listening follows the real microphone volume through a Web Audio analyser on the recorder's own stream (`level-meter.ts`), browser only, cleaned up (frame cancelled, nodes disconnected, context closed) when listening ends; a non-reactive fallback without Web Audio; nothing moves under reduced motion.
- **Start with an existing conversation.** Empty (or welcome-only) conversation: the full introduction; real messages: only "Voice mode is ready.", no history read, no turn.
- **Voice-first sending.** "Review transcript before sending" (default off): a heard sentence is sent as the next turn and its reply read; guards for empty text, STT failure, cancellation, ended session, Text, double send, a message waiting in the box, over-long text; booking is never confirmed by voice. On: the previous manual review, unchanged.
- **Hierarchy.** The stage shows the state, the last sentence, the last reply, the live review and errors; the transcript and timeline are panels; the stage's exchange card is hidden from assistive technology while the transcript is open.
- **Switching to Text** ends the voice session (speech, recording and unsent transcript are cancelled; a turn already sent finishes and is not read); Voice needs Start again.

Verification: Prettier (`--end-of-line auto`), ESLint, typecheck, `gen:api` without drift, Vitest (37 files, 777 tests), production build; headless Edge rehearsals on loopback with a scripted model and STT, a stub voice list (local and network), a fake microphone and an injected `AudioContext` / animation-frame counter: auto-send, Text first then Voice, review on, leaving during Transcribing or Thinking, network agreement across a reload, reduced motion (no analyser, no frame loop, no CSS animation), 1440, 390, 320 px, 200% text and 720x450: no horizontal overflow, axe clean in every state checked, console clean, loopback only, keyboard focus stays on the main control. Remaining risks: a real microphone, device voices (including real network voices), a phone and a screen reader were not exercised by the automated checks; the analyser's sensitivity was tuned against a synthetic tone, not human speech.
