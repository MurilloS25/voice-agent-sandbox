# Web

Next.js (App Router), React, TypeScript, and Tailwind CSS front end for Voice Agent Sandbox.

Commands are listed in [docs/HARNESS.md](../../docs/HARNESS.md). Server Components and the `confirmBooking` Server Action call the API through `src/lib/api/client.ts`, which imports `server-only` and uses the server-only `API_BASE_URL` variable (see `.env.example`). The browser never calls the API and never sees a database setting or signing key. Types in `src/lib/api/schema.d.ts` are generated from `apps/api/openapi.json`; do not edit them by hand.

## Assistant (`/assistant`)

A plain-text chat with the workshop's agent (plan 0003, phase 3C). The chat state lives in component memory only: nothing is written to `localStorage`, `sessionStorage`, cookies or a database, and a reload starts fresh.

- `src/app/assistant/actions.ts` (`sendTurn`) calls `sendAgentTurn` in `src/lib/api/client.ts` (26 s budget, `AGENT_TURN_TIMEOUT_MS`) and reduces every API status to a small outcome: answered, retry (unknown outcome, in progress, busy), assistant not available, conversation ended, or message refused.
- `src/components/ChatPanel.tsx` makes the conversation id (`crypto.randomUUID()`) on the first send, a new turn id per new message and a 1-based turn index, and keeps the exact pending submission until a terminal answer arrives. A retry resends the identical four values; the turn index advances only when a turn is accepted. If the API has lost the conversation (it restarted or it expired) the transcript stays on the page read-only and "Start a new conversation" keeps it as an earlier conversation.
- `Transcript` renders every message as plain text (no Markdown, HTML or generated links). A booking review reuses `BookingReview` and the existing `ConfirmForm` unchanged, so the proposal token exists only in that form's hidden field, and only the newest review can be confirmed. `ExecutionTimeline` lists typed events only.
- With no model provider configured (the default) the page shows "The assistant isn't switched on" with Try again and Back to workshop.

## Voice input and spoken replies (`/assistant`)

Plan 0004, phases 4C and 4D. Voice only fills and reads the same chat: the transcript goes into the existing message box and is never sent automatically, and booking is still the unchanged **Confirm booking** button.

- `src/components/VoiceInput.tsx` and `src/lib/voice/capture.ts`: a Speak/Stop toggle (no press-and-hold), 15 s and 0.3 s enforced here only, a 512 KB check before upload, format chosen with `isTypeSupported`. The microphone is requested only after Speak (and after a probe that voice is switched on), and every exit (stop, cancel, error, an ignored or abandoned prompt, unmount, `pagehide`) stops every track. Nothing is stored in the browser and no object URL is created. Typed input stays available in every state.
- `src/app/api/voice/transcribe/route.ts`: a same-origin route handler, not a Server Action, because a started Server Action cannot be cancelled. It checks `Origin`, type and size, forwards `request.signal` to the API, returns only fixed error codes, and has no logging. The browser never calls the Python API.
- `src/lib/voice/speech-output.ts`, `src/lib/voice/voice-selection.ts`, `src/components/VoiceSettings.tsx`: the browser's `speechSynthesis`. The English voice list is read with `getVoices` and refreshed on `voiceschanged`; local voices rank before network ones and names with Natural, Enhanced, Premium or Online rank higher. A network voice needs an explicit "Use the network voice" before anything is spoken. "Voice settings" has the voice, the speed, Preview and Restore defaults; only `{ voiceName, rate }` is remembered (`quillwheel.voice-settings.v1`). Only the visible reply text is spoken, with numeric dates made speakable (`prepareTextForSpeech`; the page text is untouched). A reply counts as read only when the browser reports that speech started.

## The voice-first shell (`/assistant`)

Plan 0006, [ADR 0010](../../docs/decisions/0010-voice-first-assistant-experience.md). Voice is the first mode and Text is the alternative, over the same conversation (`ChatPanel` owns it).

- `src/components/VoiceStage.tsx`, `Orb.tsx`, `src/lib/voice/stage.ts`, `use-voice-capture.ts`: the stage and its states (start, ready, preparing, listening, transcribing, review, thinking, speaking, error), all derived from the capture hook, the turn in flight and the speech controller. **Start voice assistant** speaks the local welcome (or only "Voice mode is ready." when the conversation already has messages) from the click and turns on reading of later replies; it never records and is not a turn. With "Review transcript before sending" off (the default) a heard sentence is sent automatically, with the protections described in ADR 0010; `Orb.tsx` is one SVG whose listening bars follow `src/lib/voice/level-meter.ts` (Web Audio on the recorder's own stream, browser only, cleaned up when listening ends). **End voice session** stops speech and keeps the conversation.
- `src/components/SecondaryPanel.tsx`: transcript, "How this answer was made" and Voice settings as non-modal panels that return focus to the control that opened them.
- Text mode keeps the composer, quick starts, Review again, Listen/Stop and the existing confirmation. `ConfirmForm` is unchanged; the live booking review is rendered once (in the voice stage while Voice is showing).
- Tests: `VoiceExperience.test.tsx` (the voice flow, panels, settings, fallbacks), `ChatPanel.test.tsx` (text mode, passes `initialMode="text"`), `speech-settings.test.ts`, `voice-selection.test.ts`.
- Tests use fakes for the microphone, the recorder and speech synthesis (`src/test/voice-fakes.ts`, `speech-fakes.ts`); jsdom has none of them. `server-action-cancellation.test.ts` pins the evidence for the route-handler decision by reading the installed Next.js client.
