# Plan 0004 — Voice experience

Status: completed. Phases 4A to 4E and the live checkpoints C1 to C3 are done (2026-10-01); C4 (push and pull request) is the closing step: the pull request is opened from this branch and is not merged by this milestone's work. The real Groq services were exercised only at C2 and C3 with synthetic audio; a real microphone and real speech synthesis voices were not. The branch is `feature/voice-experience`, created from `5b08ef0` (a squash commit with a single parent, `253fb59`; PR #2 is merged). Research sources were consulted on 2026-10-01 and are listed at the end.

# Outcome

On `/assistant` a visitor presses **Speak**, says one short sentence, presses **Stop**, sees the transcript in the existing message box, can correct it, and sends it with the existing **Send message** button. The reply appears as text and can optionally be read aloud by the browser's synthesized voice, only after a visitor action. Booking is unchanged: the visitor presses the existing **Confirm booking** button. Voice adds no tool, no write path and no new way to confirm. No audio is stored anywhere.

## Scope

Included:

- A provider-neutral speech-to-text (STT) port, an offline scripted fake and an optional Groq adapter, disabled by default.
- `POST /v1/speech/transcriptions`: one short audio clip in, one transcript out. It does not call the agent.
- A same-origin route handler (see the transport deviation under 4C) and a client-side capture adapter in the web app, with an accessible Speak/Stop control, an editable transcript and clear failure states.
- Browser SpeechSynthesis for spoken replies: a per-reply Listen/Stop button and an opt-in "Read replies aloud" switch, off by default.
- Tests, fixtures, documentation (HARNESS, ARCHITECTURE, README, ADR 0009) and a security review.
- An opt-in live STT check and one real end-to-end run, each behind its own approval.

Excluded (kept out on purpose):

- Public rate limiting and any deployment (Milestone 5).
- Telephony and inbound calls, full-duplex conversation, streaming, voice activity detection, barge-in.
- A second agent, server-side TTS, model training.
- Audio persistence of any kind, and any browser storage of audio or transcripts.
- Confirming, creating, rescheduling or cancelling an appointment by voice.
- Spanish or any language other than English.
- Changes to `agent/`, `/v1/agent/turns`, `ConfirmForm`, `confirmBooking`, `/v1/appointments` or the domain layer.

## Architecture and data flow

```
Browser: Speak ─ getUserMedia + MediaRecorder (client timer stops at 15 s) ─ Stop
   │  one Blob in memory (never stored; released after upload)
   ▼
Route handler POST /api/voice/transcribe (same origin; raw bytes, 14 s timeout; request.signal forwarded)
   ▼
POST /v1/speech/transcriptions   (async route; reads request.stream() incrementally)
   │  counts bytes, cuts at 512 KB → 413; checks declared type + magic bytes
   │  SpeechToText port → bounded executor (semaphore, deadline, safe abandonment)
   ▼
{ text }  →  editable in the existing composer  →  visitor presses Send
   ▼
sendTurn (unchanged) → /v1/agent/turns (unchanged) → reply text
   ▼
optional: SpeechSynthesis in the browser (Listen, or opt-in auto-read)
```

The three provenances stay distinct: the visitor's words (typed, or transcribed and approved by pressing Send), what the model inferred (timeline `tool_requested`), and what a tool confirmed (`tool_result`, `booking_review`). The transcript is labelled as machine-transcribed until the visitor sends it.

STT is stateless on the server: a retry of the same clip costs only provider quota and never consumes a conversation turn, so no idempotency key is needed. Turn idempotency stays with `sendTurn`.

## Decisions already made

1. English only: the adapter sends `language="en"`; Spanish is deferred.
2. The transcript is editable and sent manually. There is no auto-send.
3. Spoken output: per-reply Listen/Stop plus an opt-in auto-read switch, off by default.
4. Real STT: Groq `whisper-large-v3-turbo`, optional, disabled by default; the model id is configuration (`SPEECH_MODEL`), never code.
5. Hybrid architecture (capture → API STT → existing agent → browser synthesis). Browser SpeechRecognition is not used.

## Contracts

`POST /v1/speech/transcriptions` (tag `speech`)

- Request: the raw audio bytes as the body; `Content-Type` is one of `audio/webm`, `audio/ogg`, `audio/mp4`, `audio/wav` (codec parameters such as `;codecs=opus` are tolerated). Optional header `X-Audio-Duration-Ms`: an integer used only for diagnostics. It is validated for syntax and range (0 to 60,000) and is **never a security control**: it is client-controlled and does not prove the real length.
- Response 200: `{ "text": string (1..500 chars, normalized like agent messages), "language": "en" }`. The text is cut to the same 500-character limit the agent accepts, so a transcript can always be sent.
- The route is `async def` because `request.stream()` is asynchronous. It never uses `UploadFile`, multipart or `Request.body()`.

Public errors (fixed code and message, the existing error envelope, never an SDK message):

| Status | Code | When |
|---|---|---|
| 413 | `audio_too_large` | the stream exceeded 512 KB; reading stopped at once |
| 415 | `audio_unsupported` | declared type not allowed, or magic bytes missing or inconsistent with it |
| 422 | `audio_invalid` | empty body, or the provider could not decode the clip |
| 422 | `no_speech` | the provider returned no usable text |
| 422 | `validation_error` | malformed `X-Audio-Duration-Ms` |
| 429 | `speech_busy` | the transcription semaphore is full (`Retry-After`) |
| 502 | `transcription_failed` | provider error, rate limit or unusable output |
| 503 | `speech_unavailable` | `SPEECH_PROVIDER=disabled` |
| 504 | `transcription_timeout` | the provider wait or the body read exceeded its limit |

Internal types (frozen Pydantic models or dataclasses, no free dictionaries across layers): `AudioClip(data: bytes, media_type: AudioMediaType)`, `Transcript(text: str)`, `SpeechError` with a fixed `code`. Port: `SpeechToText.transcribe(clip: AudioClip) -> Transcript` (blocking, called only through the bounded executor).

## Limits (and what the server does not prove)

- **Server, enforced:** 512 KB total body, counted while streaming; allowed types; magic-byte consistency; concurrency and timeouts below.
- **Client, enforced in the browser only:** 15 s maximum (a timer stops the recording) and a 0.3 s minimum before the transcript can be used. A modified client can ignore both.
- **Not enforced by the server:** the real duration of the audio. Checking the true length of WebM, Ogg, MP4 and WAV reliably needs ffmpeg, PyAV or fragile hand-written parsers, which this milestone does not add. The server therefore never claims to reject audio longer than 15 s or shorter than 0.3 s. This is a documented residual risk until Milestone 5. The byte cap and the lack of a public deployment reduce abuse of the provider quota but do not eliminate it.
- **Magic-byte checks** (EBML `1A45DFA3`, `OggS`, `RIFF…WAVE`, `ftyp`) prove only the container family, not that the audio is valid.

Timeout budget (a test recomputes it from the real defaults, as in `tests/test_timeout_budget.py`):

| Item | Value |
|---|---|
| Body read (whole stream) | 3 s |
| Provider wait `SPEECH_TIMEOUT_S` (also the SDK `timeout`; `max_retries=0`) | 6 s |
| Route bound (read + provider) | 9 s |
| Web route handler's call to the API (`SPEECH_TIMEOUT_MS`; bound + the same 5 s margin as ADR 0007) | 14 s |
| In-flight transcriptions (semaphore) | 2 |

## Request handling, event loop and cancellation

- The route reads `request.stream()` chunk by chunk into a bounded buffer, adds each chunk's length to a counter, and as soon as the total would exceed 512 KB it stops reading and answers 413. It never holds more than the allowed amount in memory. A client disconnect raises during the read and ends the request without calling the provider; no partial audio is retained.
- The blocking Groq SDK call never runs on the event loop. It goes through a dedicated bounded executor patterned on `BoundedCaller` (ADR 0007): a small thread pool, a semaphore that limits concurrent transcriptions, a hard wait limit, and safe abandonment (a late result returns to a discarded future and touches no state).
- **If the client cancels after the provider call has started:** the call cannot be cancelled. It is abandoned: its result is discarded, never stored or logged, and its semaphore slot stays occupied until it finishes or reaches its own timeout. The semaphore (2) therefore bounds the worst case.
- The existing synchronous routes stay synchronous. The event-loop tests are updated for this split: the async route must contain no blocking call (no SDK, no sleep, no synchronous I/O) and must hand provider work to the bounded executor; the other routes keep their threadpool rule. No `def` is kept artificially.

## Configuration

New settings (validated like the others; invalid values fail closed with only the setting name logged):

- `APP_ENV`: `development` | `test` | `production`, default `production`.
- `SPEECH_PROVIDER`: `disabled` (default) | `fake` | `groq`.
- `SPEECH_MODEL`: required for `groq`, no default, not a placeholder.
- `SPEECH_TIMEOUT_S` (default 6), `SPEECH_READ_TIMEOUT_S` (default 3; added in 4B because the body read has its own budget), `SPEECH_MAX_AUDIO_BYTES` (default 524288), `SPEECH_MAX_CONCURRENT` (default 2). Their upper bounds are the defaults (6 s, 3 s, 512 KB; at most 4 concurrent): configuration can only lower the budget, so the 14 s web timeout always covers a request (a test pins the caps).

Rules: `disabled` needs nothing and the route answers 503. `groq` reuses `GROQ_API_KEY` (the existing validation applies) and requires `SPEECH_MODEL`; the endpoint is pinned to `https://api.groq.com`, tracing is refused and the provider loggers stay at WARNING, as in ADR 0008. `fake` is accepted **only** when `APP_ENV` is explicitly `development` or `test`; with the default `production` it fails startup, so the fake cannot be enabled by accident in a public environment. `.env.example` gets placeholders only; `secrets generate` never writes provider values; `secrets check` reports the speech provider by name only.

## Web states and accessibility

Recording states: `unsupported | idle | requesting_permission | denied | recording | transcribing | review | error`.

- The control is a toggle: **Speak** starts, **Stop** ends. Holding a button is never required (it could be a later addition, never the only mechanism). It works with keyboard, touch and screen readers, respects reduced motion, and has a 48 px minimum target.
- The microphone is requested only when Speak is pressed. A note before first use says where the audio goes and that it is not stored. An ignored permission prompt is handled with our own timeout and a Cancel button.
- While recording: a visible "Recording" state with elapsed time, announced politely (`aria-live`), and the 15 s timer. Every track is stopped on Stop, error, unmount and page hide.
- After transcription the text appears in the existing message box and is focused; the visitor edits it and presses Send. Unsupported browsers, denied permission, no microphone, a failed transcription or an empty result show a clear notice, and typing keeps working.
- Cancel discards the Blob; a newer recording, or leaving the page, aborts an in-flight transcription and ignores its late result.
- No localStorage, IndexedDB or Cache for audio or transcripts; the Blob is released after upload; any object URL is revoked.

Spoken output:

- SpeechSynthesis is **not** assumed to be local. A voice with `localService=true` is preferred. If only a network voice (`localService=false`) exists, the browser or operating system may send the reply text to an external service, so a visible explanation and the visitor's opt-in are required first.
- The feature is labelled **"Synthesized voice"**. Each assistant reply has Listen/Stop; "Read replies aloud" is off by default and, when on, reads only after the visitor sends a message. An autoplay block is swallowed silently and Listen stays available. No voices, or no SpeechSynthesis, hides or disables Listen with a note and never breaks the page.
- Long replies are split into sentence-sized utterances (a known Chrome cutoff); `speechSynthesis.cancel()` runs on a new recording, a new turn and unmount.
- Only reply text is spoken; the proposal token is never in reply text and is never read.

## Invariants

1. Voice never creates, reschedules, cancels or confirms an appointment; `confirmBooking` and the signed-proposal flow are untouched.
2. The agent, store, tools, contracts and providers are unchanged; `tests/agent/test_boundary.py` still passes, and `speech/` and `agent/` do not import each other.
3. No raw audio is persisted: nothing is written to disk, a database, logs, browser storage or events; `tempfile` is patched to fail in tests.
4. Audio and transcripts are never logged; logs carry only outcome, byte count and timings. `exc_info` never records transcribed text, provider payloads, audio, keys or HTTP bodies.
5. No SDK exception reaches the client; public errors are fixed and typed.
6. No key or API address in the client or in any route handler or Server Action result; no tracing.
7. Nothing plays or records without a visitor action.
8. The server states only what it enforces (bytes, type family, concurrency, time), never audio duration.

## Approach: ordered slices

Each slice is a vertical, tested change; a checkpoint (marked **Stop**) is a point where work waits for approval.

- **4A Contracts, limits and port.** Done. `apps/api/src/voice_agent_api/speech/{__init__,contracts,ports,errors,limits,sniff,bounded}.py` (the bounded body read and the bounded execution both live in `bounded.py`); the async route in `api/speech_routes.py` (a separate module, because the existing test forbids async functions in `api/routes.py`); the fixed errors in `speech/errors.py`, mapped to their statuses in `api/errors.py`; the `speech` dependency in `api/dependencies.py` and the wiring in `factory.py`; `openapi.json` and `schema.d.ts` regenerated. `api/routes.py` and `api/schemas.py` are unchanged. Tests in `tests/speech/` with a scripted port.
- **4B Adapters and configuration.** `speech/fake.py` (scripted), `speech/providers.py` (the only module importing the Groq SDK, lazily; pinned base URL, `max_retries=0`, tracing refused), settings and validation in `config.py`, wiring in `factory.py`, `devtools/secrets.py` (`check`), `.env.example`, ADR 0009. Adapter tests use a mock HTTP transport. No new dependency is expected: the installed `groq` 0.37.1 provides `audio.transcriptions.create`; `python-multipart` is not used by the route. **Stop** before installing anything, if a dependency does turn out to be needed.
- **4C Capture and UX.** Done. `apps/web/src/lib/voice/{limits,capture,transcribe}.ts`, `src/components/VoiceInput.tsx`, `src/app/api/voice/transcribe/route.ts`, `sendTranscription` and `SPEECH_TIMEOUT_MS = 14000` in `src/lib/api/client.ts`, integration in `ChatPanel`, test fakes in `src/test/voice-fakes.ts`.
  - **Deviation (pre-authorized only for real cancellation): a same-origin route handler instead of a Server Action.** The plan named a Server Action `transcribeAudio`. Checking the installed Next.js 16.3.7 showed that a started Server Action cannot be cancelled: the client's `callServer(actionId, actionArgs)` takes no signal, `fetchServerAction` builds its own fetch without one, and actions are dispatched one at a time, so a pending transcription would also hold up `sendTurn` and the booking confirmation behind it. The browser therefore calls `POST /api/voice/transcribe` on its own origin; the handler checks the `Origin` header, the type and the size (counting bytes while reading, never keeping more than 512 KB), forwards to the API with `request.signal` so a cancel or a closed page reaches the API call, maps the API's codes to a small fixed set, and has no logging at all. The evidence is pinned by `server-action-cancellation.test.ts`, which reads the installed Next.js client: if a future version adds cancellation, it fails and the decision should be revisited.
  - **Addition: an availability probe.** Before the microphone is requested, the page asks the same route whether voice is switched on (an empty probe that the API answers with `speech_unavailable` before reading any audio), so nobody records for nothing when no provider is configured. It is asked once per page and only after Speak is pressed.
  - **UI detail.** One control changes from Speak to Stop in place (focus stays on it); Cancel recording, Cancel transcription and Record again are separate buttons. The 15 s limit stops the recording and transcribes it, and says so.
- **4D Synthesis.** Done. `src/lib/voice/speech-output.ts` (framework-free controller: deterministic sentence-sized chunking, voice choice, `voiceschanged`, stale-callback guard), `use-speech-output.ts` (one controller per page, `useSyncExternalStore`), `src/components/SpokenReplies.tsx` (the "Synthesized voice" panel: "Read replies aloud", off by default and held in memory only; the network-voice explanation and opt-in), Listen/Stop on assistant replies in `Transcript.tsx`, and the wiring in `ChatPanel.tsx`. A local English voice is preferred; with only a network voice nothing is spoken (neither Listen nor automatic reading) until the visitor presses "Use the network voice"; with no voice, or no `speechSynthesis`, the controls are not shown and the chat stays text. Speaking stops on Stop, a new recording, a new turn, a new conversation, `pagehide`, unmount and when the switch is turned off. Only an assistant reply's visible text is spoken (never the token, the review, the timeline or a system notice). A refused start (for example by an autoplay policy) is silent and leaves Listen available. The only wording about locality is that the browser *reports* its voice as running on the device.
- **4E Tests, documentation, review.** HARNESS (new commands and settings), ARCHITECTURE, README, `evals/README.md`; `change-reviewer` and `/security-review` over the whole branch; secret scan.
- **4F Live checkpoints.** Done (C1 to C3, see the closeout): documentation and configuration only, one live transcription of a synthetic clip, and one end-to-end session in headless Edge with a fake microphone device. No live harness is committed.

## Verification

Offline, in the default runs (no network, no key, no live call in normal `pytest`):

- API: contracts and each public error row by row; a 600 KB stream is cut early (the test shows the generator was not consumed to the end) and answers 413; chunked bodies and false or missing `Content-Length`; client disconnect; blocking fake that outlives the deadline (504, late result discarded, slot held until it ends); semaphore full (429); magic-byte and declared-type mismatches; empty and silent clips; adapter against a mock HTTP transport (request body, key only in the `Authorization` header, language `en`, no retries); privacy (caplog and events never contain audio bytes or transcript text, `tempfile` patched to fail); config (`fake` refused under the default `APP_ENV`, `groq` fail-closed names only, `disabled` needs nothing); static boundary tests; the updated event-loop test; the timeout-budget test; OpenAPI drift.
- Fixtures: WAV bytes generated in the test with the stdlib `wave` and `struct` modules (sine or silence, 16 kHz mono) and minimal synthetic container headers for webm/ogg/mp4. No human voice is versioned.
- Web (Vitest): `AudioCapture` and `SpeechOutput` adapters injected with fakes (no `MediaRecorder` in jsdom): every state, the Speak/Stop toggle, cancellation, denied permission, no microphone, the client limit timer, track release on every exit, no browser storage, late results ignored, network-voice notice, autoplay block, no voices; keyboard, `aria-live`, axe, and layout at 320, 390 and 1440 px and at 200% text.
- Browser rehearsal (headless Edge or Chromium with the fake-device flags and a generated synthetic WAV as microphone, plus the fake STT; no key): the full Speak → edit → Send → review → Confirm path against a scripted model.
- Commands: those already in `docs/HARNESS.md` (`ruff format --check`, `ruff check`, `mypy`, `pytest`, `openapi` drift; `pnpm gen:api`, `lint`, `typecheck`, `test`, `build`). Only checks actually run are reported, with counts.

## Checkpoints (each needs its own explicit approval)

- **C0 (done):** the empty branch was created and published; this plan is its first commit.
- **C-plan:** this plan is reviewed again before anything is installed, changed or coded.
- **C1 — configuration check, no call (done):** you confirm Zero Data Retention on your own Groq account, the model page (Production, not deprecated), the free-tier limits, and put `SPEECH_PROVIDER`, `SPEECH_MODEL` (and the existing key) in your own `apps/api/.env` yourself; `secrets check` reports pass or fail by name only. No request is sent.
- **C2 — one live STT check (done):** one request with synthetic audio and no personal content, generated locally for the check (for example a fixed fictional sentence rendered by an operating-system voice, or a generated tone), kept temporary and deleted afterwards. Budget: at most 3 requests and 60 billed audio-seconds (each clip is billed as at least 10 s), against the free limits of 20 requests per minute and 7,200 audio-seconds per hour. This budget is counted separately from the text agent's token accounting. Output: pass or fail, latency and counts only, never the transcript text.
- **C3 — one real end to end (done):** one real session (microphone, Groq STT, Groq chat, the existing Confirm) with fictional data only, throwaway headless browser profile, memory store, API started with the provider enabled only for that process. Budget: at most 5 STT requests and 120 billed audio-seconds, plus the usual small chat usage. No human recording or personal voice is used without your explicit authorization. Afterwards every process is stopped and the in-memory appointment is gone.
- **C4 (the closing step):** push and pull request creation, as in earlier milestones; the pull request is opened from this branch and not merged by this milestone's work.

## Acceptance criteria

1. The Speak/Stop → editable transcript → Send flow works in a supported browser with the fake provider and, after C2/C3, with Groq.
2. An oversized body is cut at 512 KB with 413 without buffering the rest; the route never blocks the event loop; every public error is fixed and typed.
3. No audio or transcript appears in logs, events, disk, browser storage or state beyond the visible composer; the fake is refused under `APP_ENV=production`.
4. The booking path is byte-for-byte the existing one; voice cannot confirm.
5. Spoken output never starts without a visitor action; network voices are disclosed; a missing voice never breaks the page.
6. Accessibility checks pass (keyboard, screen-reader announcements, axe, 320/390/1440 px, 200% text).
7. Documentation states the limits honestly: the server enforces only bytes, type family, concurrency and time; real audio duration, public rate limiting and abuse of the provider quota remain open until Milestone 5.
8. All offline checks pass and the final report lists exactly the checks run.

## Risks and deferred work

- Real audio duration is not verified by the server (residual until M5); an attacker with a custom client could send up to 512 KB of long, low-bitrate audio. Quota abuse is reduced, not removed, by the byte cap, the semaphore and the absence of a public deployment.
- Abandoned provider calls hold a worker and a slot until their timeout (documented, bounded by the semaphore).
- Groq may change models, limits or retention; the model is configuration and the check at C1 is where it is re-verified.
- Browser behavior varies (formats, permission prompts, synthesis voices); capture probes `isTypeSupported` at runtime and falls back to typed input.
- A transcript can contain a recognition error; the visitor sees and edits it before sending.
- Deferred: public rate limiting and spend caps, deployment, Spanish, a browser-recognition fallback, hold-to-talk as an addition, server-side TTS, persisted conversations.

## Decisions or follow-ups

- ADR 0009 (speech-to-text port, hybrid architecture, raw-body streaming, honest limits) is written with slice 4B.
- `docs/HARNESS.md` gains the new settings and the opt-in live commands in the same change that adds them.

## Closeout and verification (2026-10-01)

Milestone 4 is complete: voice as an input and output layer around the unchanged text agent, verified offline and at three live checkpoints. It is a portfolio demo, not production-ready.

Delivered: the speech package and `POST /v1/speech/transcriptions` (async, incremental body read capped at 512 KB, bounded off-loop execution); the `SpeechToText` port, the scripted fake (only with `APP_ENV` explicitly `development` or `test`) and the optional Groq adapter, all disabled by default; fail-closed settings; the same-origin route handler and the Speak/Stop capture with an editable, never-auto-sent transcript; the browser's synthesized replies (Listen/Stop and an opt-in switch, local voice preferred, network voice only after an explicit opt-in); ADR 0009 and the documentation. No dependency was added, `agent/`, the tools, the domain, `ConfirmForm` and the booking routes are unchanged, and no `.env`, key, audio file or capture was created or committed.

### Offline verification (before the live checkpoints)

- API (default `pytest`, offline): 1009 passed, 16 deselected (15 database integration tests and 1 provider test), against a Milestone 3 baseline of 734; `ruff format --check`, `ruff check` and `mypy` clean; `openapi.json` with no drift; the timeout-budget tests (including the web constant `SPEECH_TIMEOUT_MS = 14000`) pass.
- Web: `pnpm gen:api` with no diff, Prettier with `--end-of-line auto` on every changed file, `pnpm lint`, `pnpm typecheck`, `pnpm test` (29 files, 481 tests; the Milestone 3 baseline was 265 in 21 files) and `pnpm build` (the route `/api/voice/transcribe` is dynamic). axe runs in the component tests.
- Browser rehearsal (headless Edge over the DevTools protocol, a fake microphone fed by a synthetic tone, a stub `speechSynthesis`, the fake transcription, a scripted model, the production web build; no provider, no key): 17 of 17 checks passed on the final code.
- Reviews: a read-only change review per phase, one over the whole branch and a separate security and privacy review. No P0 to P2 finding remained. Defects found and fixed during the work (each with a regression test): a `Content-Length` of thousands of digits answered 500 instead of 413; a recorder error was taken for a normal stop; a late transcript could overwrite a sent message's cleared box; the microphone was not released until the recorder reported its stop; an unobserved rejection when a late capture was cancelled; a missing read deadline in the route handler; an error on a middle speech chunk left the controls out of step.

### Final offline state (after the logging fix, before the pull request)

API: 1010 passed and 16 deselected (the 1009 above plus the new log-privacy test), `ruff format --check`, `ruff check` and `mypy` (113 files) clean, `openapi.json` with no drift. Web: `pnpm gen:api` with no diff, Prettier with `--end-of-line auto`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (29 files, 481 tests) and `pnpm build` all pass. The whole branch then got one more read-only change review and one independent security and privacy review, with no P0 to P2 finding; their small documentation findings were fixed.

### Live checkpoints (sanitized)

All used fictional data and synthetic audio generated from a locally installed Windows voice (no human voice, no personal data), `APPOINTMENT_STORE=memory` for the test process only (no Supabase), the API's real route and a network guard that allowed only loopback and `api.groq.com`. Nothing below includes the transcript, the selected date, an identifier, a token, a payload or a key.

- **C1 (configuration, no request).** From the official documentation: `whisper-large-v3-turbo` is listed under Production Models and is not deprecated; the transcription endpoint is `https://api.groq.com/openai/v1/audio/transcriptions`; `language` takes an ISO-639-1 code; the accepted formats include flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav and webm; the minimum billed length is 10 seconds; the maximum file size is 25 MB on the free tier; the free-plan limits are 20 requests per minute, 2,000 per day, 7,200 audio-seconds per hour and 28,800 per day (the models page shows higher figures that could not be attributed to the account without a request); and `/openai/v1/audio/transcriptions` is listed as eligible for Zero Data Retention, which the operator confirmed enabling (the repository cannot verify it). `secrets check` (no `--connect`) passed with names only, the effective settings were within the plan's caps, tracing was off, the fake was not selected, and building the application from settings made 0 network attempts with every network path blocked. 0 requests.
- **C2 (one transcription).** One real transcription request through the application's route. HTTP 200; the provider call took 962 ms; the transcript was non-empty (55 characters), reported as English and contained the five expected concepts; the clip was 3,760 ms and 120,366 bytes (16 kHz, 16-bit, mono); the conservative accounting is 10 billed audio-seconds; the privacy scan of the application's logs passed; no agent turn was consumed and no appointment was created.
- **C3 (one end-to-end session).** A single execution, **15 of 15 steps passed**. In headless Edge with a fake capture device: Speak and Stop, a real transcription shown in the message box, edited by the visitor's own Send, a real agent reply that searched for open times (`find_available_slots`), a typed second turn that chose an offered time (`prepare_booking_review`), exactly one booking review, the existing **Confirm booking** pressed once, exactly one appointment in memory, and a replay of the same confirmation that returned the same appointment with no duplicate. Requests to the provider: 1 transcription (720 ms) and 4 chat requests (756, 1243, 898 and 777 ms), 0 blocked, no retry. Budget: 10 billed audio-seconds, 6,264 agent tokens (ceiling 12,000) and a peak of 3,315 tokens per minute (target under 7,000). The turn replies listed times and did not claim a booking; the proposal token appeared only in the form's hidden input (not in visible text, the timeline, the URL, the console or any request URL), with no cookies and no browser storage; Listen and Stop with a local stand-in voice received only the visible reply text. Accessibility and layout: 0 axe violations (idle, recording, the review page and fresh pages), 0 console errors, no horizontal overflow at 1440, 390 and 320 px or at 200% text, a sensible keyboard order with a visible focus indicator, the polite status announcements for recording, transcribing and review, and reduced motion respected. The browser contacted only loopback. All processes were stopped and the temporary audio, profile, scripts and logs were deleted; a restarted memory store held no appointment.
- **Totals for Milestone 4:** 2 transcription requests (C2 and C3) and 20 audio-seconds counted against the quota, 4 chat requests (all in C3), no retry, no Supabase or database access, and no personal data or human voice. The live run was not repeated after the logging fix below.

### A privacy finding from C3, and its fix

The live session's log audit found that the confirmation audit line `appointment_confirm outcome=… appointment_id=…` carried the appointment's id at INFO. The normal entrypoint (`main.py`) enables INFO for the application logger, so the line was emitted in a normal run, contrary to [ADR 0007](../decisions/0007-agent-orchestration-and-tool-boundary.md) ("no application identifiers in logs"). A search of every production log call found one more exposure of the same kind: the unhandled-error line logged the concrete request path, which can include an appointment id. Both were fixed in commit `00ad24f`: they now log only the outcome (`created` or `replayed`) and the route template, and the tests require exactly those events and assert that no identifier-shaped value, token or alias reaches the application logs. The fix was validated offline by capturing the real created and replayed log lines (the new tests fail against the old code). That commit also left a comment one line over the linter's limit, corrected in the commit that closes this milestone. The other log calls were checked and carry only counts, codes, class names, setting names, route templates and timings.

### Known limits and risks (also in the README, HARNESS and ADR 0009)

- The server does not measure audio duration (the 15 s and 0.3 s limits are enforced in the browser only); there is no public rate limit or spend cap on transcription (Milestone 5).
- Zero Data Retention was confirmed by the operator and cannot be verified from the repository.
- Logging gaps, documented and not fixed: uvicorn's access log prints request paths such as `GET /v1/appointments/<id>` and is enabled by the documented run commands, so a deployment must disable or redact it; the unhandled-error handler logs a traceback whose exception messages are not redacted (the current code paths use fixed messages).
- The same-origin check compares the `Origin` host with `Host`, so it must be revisited behind a proxy; worker threads are not daemons, so a hung provider call can delay process exit; the SDK's HTTP client honours the host's proxy and TLS environment variables; voice is English only.
- Not exercised: a real microphone (the browser run used a fake capture device), real speech synthesis voices (a local stand-in was injected), a phone, a screen reader, Safari and Firefox, other languages, and the database integration tests.

Deferred: public rate limiting and spend caps, access-log handling, deployment (Milestone 5), Spanish, hold-to-talk as an addition, a browser-recognition fallback and server-side text-to-speech.

## Sources (consulted 2026-10-01)

Groq: console.groq.com/docs/{speech-to-text, rate-limits, your-data, deprecations, models, model/whisper-large-v3-turbo, text-to-speech, text-to-speech/orpheus, api-reference}; github.com/groq/groq-python (v0.37.1, `audio/transcriptions.py`); pypi.org/project/{groq, langchain-groq, python-multipart}.
Alternatives: developers.openai.com/api/docs/{pricing, guides/your-data, guides/speech-to-text, guides/text-to-speech}; deepgram.com/pricing; assemblyai.com/pricing; azure.microsoft.com/en-us/pricing/details/speech; elevenlabs.io/pricing; github.com/SYSTRAN/faster-whisper; github.com/ggml-org/whisper.cpp.
Formats and Python: docs.python.org/3.13/library/wave.html; matroska.org/technical/elements.html; xiph.org/ogg/doc/framing.html; github.com/encode/starlette (`formparsers.py`); fastapi.tiangolo.com/tutorial/request-files.
Browser: developer.mozilla.org (MediaDevices.getUserMedia, MediaRecorder, isTypeSupported, AudioWorklet, SpeechRecognition, Using the Web Speech API, SpeechSynthesis, SpeechSynthesisVoice.localService, SpeechSynthesisErrorEvent.error, Autoplay guide); w3c.github.io/mediacapture-main and /mediacapture-record; developer.chrome.com (release notes 126, one-time permissions, new in Chrome 139, Chrome 71, autoplay); webkit.org/blog (16574, 11648, 6784); blog.mozilla.org/webrtc (one-time permissions); bugzilla.mozilla.org (1631143); learn.microsoft.com (Edge speech recognition API); MDN browser-compat-data (SpeechRecognition); chromium `media_switches.cc`; webrtc.org (testing); playwright.dev (BrowserContext, BrowserType).
Local: Next.js 16 docs and client shipped in `node_modules/next/dist` (Server Actions: `bodySizeLimit`, sequential dispatch, `callServer`).
