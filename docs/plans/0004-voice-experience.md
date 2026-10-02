# Plan 0004 — Voice experience

Status: accepted; implementation in progress. Phases 4A (contracts, limits and STT port) and 4B (adapters and configuration) are done; 4C to 4E are being implemented offline; 4F (checkpoints C1 to C3) has not started. The branch is `feature/voice-experience`, created from `5b08ef0` (a squash commit with a single parent, `253fb59`; PR #2 is merged). Research sources were consulted on 2026-10-01 and are listed at the end.

# Outcome

On `/assistant` a visitor presses **Speak**, says one short sentence, presses **Stop**, sees the transcript in the existing message box, can correct it, and sends it with the existing **Send message** button. The reply appears as text and can optionally be read aloud by the browser's synthesized voice, only after a visitor action. Booking is unchanged: the visitor presses the existing **Confirm booking** button. Voice adds no tool, no write path and no new way to confirm. No audio is stored anywhere.

## Scope

Included:

- A provider-neutral speech-to-text (STT) port, an offline scripted fake and an optional Groq adapter, disabled by default.
- `POST /v1/speech/transcriptions`: one short audio clip in, one transcript out. It does not call the agent.
- A Server Action and a client-side capture adapter in the web app, with an accessible Speak/Stop control, an editable transcript and clear failure states.
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
Server Action transcribeAudio (Next.js server, FormData → raw bytes, 14 s timeout)
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
| Web Server Action / fetch timeout (bound + the same 5 s margin as ADR 0007) | 14 s |
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
6. No key in the client or in any Server Action result; no tracing.
7. Nothing plays or records without a visitor action.
8. The server states only what it enforces (bytes, type family, concurrency, time), never audio duration.

## Approach: ordered slices

Each slice is a vertical, tested change; a checkpoint (marked **Stop**) is a point where work waits for approval.

- **4A Contracts, limits and port.** `apps/api/src/voice_agent_api/speech/{__init__,contracts,ports,errors,limits,sniff,bounded}.py`; the async route and fixed errors in `api/routes.py`, `api/errors.py`, `api/schemas.py`; dependency in `api/dependencies.py`; `openapi.json` and `schema.d.ts` regenerated. Tests in `tests/speech/` with a scripted port (no provider code yet).
- **4B Adapters and configuration.** `speech/fake.py` (scripted), `speech/providers.py` (the only module importing the Groq SDK, lazily; pinned base URL, `max_retries=0`, tracing refused), settings and validation in `config.py`, wiring in `factory.py`, `devtools/secrets.py` (`check`), `.env.example`, ADR 0009. Adapter tests use a mock HTTP transport. No new dependency is expected: the installed `groq` 0.37.1 provides `audio.transcriptions.create`; `python-multipart` is not used by the route. **Stop** before installing anything, if a dependency does turn out to be needed.
- **4C Capture and UX.** `apps/web/src/lib/voice/capture.ts`, `src/components/VoiceInput.tsx`, `src/app/assistant/transcribe.ts` (Server Action), `client.ts` (`transcribeAudio`, 14 s), integration in `ChatPanel`, `state.ts` types, `next.config.ts` only if the 1 MB action limit proves insufficient (it should not: 15 s of Opus is about 30–60 KB).
- **4D Synthesis.** `src/lib/voice/speech-output.ts`, Listen/Stop in `Transcript`, the opt-in switch and the network-voice notice in `ChatPanel`.
- **4E Tests, documentation, review.** HARNESS (new commands and settings), ARCHITECTURE, README, `evals/README.md`; `change-reviewer` and `/security-review` over the whole branch; secret scan.
- **4F Live evaluation and end to end** (see checkpoints).

## Verification

Offline, in the default runs (no network, no key, no live call in normal `pytest`):

- API: contracts and each public error row by row; a 600 KB stream is cut early (the test shows the generator was not consumed to the end) and answers 413; chunked bodies and false or missing `Content-Length`; client disconnect; blocking fake that outlives the deadline (504, late result discarded, slot held until it ends); semaphore full (429); magic-byte and declared-type mismatches; empty and silent clips; adapter against a mock HTTP transport (request body, key only in the `Authorization` header, language `en`, no retries); privacy (caplog and events never contain audio bytes or transcript text, `tempfile` patched to fail); config (`fake` refused under the default `APP_ENV`, `groq` fail-closed names only, `disabled` needs nothing); static boundary tests; the updated event-loop test; the timeout-budget test; OpenAPI drift.
- Fixtures: WAV bytes generated in the test with the stdlib `wave` and `struct` modules (sine or silence, 16 kHz mono) and minimal synthetic container headers for webm/ogg/mp4. No human voice is versioned.
- Web (Vitest): `AudioCapture` and `SpeechOutput` adapters injected with fakes (no `MediaRecorder` in jsdom): every state, the Speak/Stop toggle, cancellation, denied permission, no microphone, the client limit timer, track release on every exit, no browser storage, late results ignored, network-voice notice, autoplay block, no voices; keyboard, `aria-live`, axe, and layout at 320, 390 and 1440 px and at 200% text.
- Browser rehearsal (headless Chromium with the fake-device flags and a generated synthetic WAV as microphone, plus the fake STT; no key): the full Speak → edit → Send → review → Confirm path against a scripted model.
- Commands: those already in `docs/HARNESS.md` (`ruff format --check`, `ruff check`, `mypy`, `pytest`, `openapi` drift; `pnpm gen:api`, `lint`, `typecheck`, `test`, `build`). Only checks actually run are reported, with counts.

## Checkpoints (each needs its own explicit approval)

- **C0 (done):** the empty branch was created and published; this plan is its first commit.
- **C-plan:** this plan is reviewed again before anything is installed, changed or coded.
- **C1 — configuration check, no call:** you confirm Zero Data Retention on your own Groq account, the model page (Production, not deprecated), the free-tier limits, and put `SPEECH_PROVIDER`, `SPEECH_MODEL` (and the existing key) in your own `apps/api/.env` yourself; `secrets check` reports pass or fail by name only. No request is sent.
- **C2 — one live STT check:** one request with synthetic audio and no personal content, generated locally for the check (for example a fixed fictional sentence rendered by an operating-system voice, or a generated tone), kept temporary and deleted afterwards. Budget: at most 3 requests and 60 billed audio-seconds (each clip is billed as at least 10 s), against the free limits of 20 requests per minute and 7,200 audio-seconds per hour. This budget is counted separately from the text agent's token accounting. Output: pass or fail, latency and counts only, never the transcript text.
- **C3 — one real end to end:** one real session (microphone, Groq STT, Groq chat, the existing Confirm) with fictional data only, throwaway headless browser profile, memory store, API started with the provider enabled only for that process. Budget: at most 5 STT requests and 120 billed audio-seconds, plus the usual small chat usage. No human recording or personal voice is used without your explicit authorization. Afterwards every process is stopped and the in-memory appointment is gone.
- **C4:** push and pull request creation, as in earlier milestones.

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

## Sources (consulted 2026-10-01)

Groq: console.groq.com/docs/{speech-to-text, rate-limits, your-data, deprecations, models, model/whisper-large-v3-turbo, text-to-speech, text-to-speech/orpheus, api-reference}; github.com/groq/groq-python (v0.37.1, `audio/transcriptions.py`); pypi.org/project/{groq, langchain-groq, python-multipart}.
Alternatives: developers.openai.com/api/docs/{pricing, guides/your-data, guides/speech-to-text, guides/text-to-speech}; deepgram.com/pricing; assemblyai.com/pricing; azure.microsoft.com/en-us/pricing/details/speech; elevenlabs.io/pricing; github.com/SYSTRAN/faster-whisper; github.com/ggml-org/whisper.cpp.
Formats and Python: docs.python.org/3.13/library/wave.html; matroska.org/technical/elements.html; xiph.org/ogg/doc/framing.html; github.com/encode/starlette (`formparsers.py`); fastapi.tiangolo.com/tutorial/request-files.
Browser: developer.mozilla.org (MediaDevices.getUserMedia, MediaRecorder, isTypeSupported, AudioWorklet, SpeechRecognition, Using the Web Speech API, SpeechSynthesis, SpeechSynthesisVoice.localService, SpeechSynthesisErrorEvent.error, Autoplay guide); w3c.github.io/mediacapture-main and /mediacapture-record; developer.chrome.com (release notes 126, one-time permissions, new in Chrome 139, Chrome 71, autoplay); webkit.org/blog (16574, 11648, 6784); blog.mozilla.org/webrtc (one-time permissions); bugzilla.mozilla.org (1631143); learn.microsoft.com (Edge speech recognition API); MDN browser-compat-data (SpeechRecognition); chromium `media_switches.cc`; webrtc.org (testing); playwright.dev (BrowserContext, BrowserType).
Local: Next.js 16 docs shipped in `node_modules/next/dist/docs` (Server Actions `bodySizeLimit`, 1 MB default).
