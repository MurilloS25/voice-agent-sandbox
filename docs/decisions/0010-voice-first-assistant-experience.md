# The assistant is a turn-based voice app with a text alternative

- Status: accepted. Implemented and verified offline (plan 0006): unit and component tests, and scripted headless-Edge rehearsals with a fake microphone, a stub `speechSynthesis`, a scripted model and scripted speech-to-text on loopback only. **Not** verified: a real microphone, real device voices, a phone, a screen reader, other browsers, and any real provider (none was called).
- Date: 2026-10-02

## Context

After plans 0004 and 0005 `/assistant` was a chat with voice features. The product goal is the reverse: a voice assistant with a text alternative. It must stay turn-based (record, review, send, answer, speak): no full-duplex audio, no streaming, no auto-send, and no change to the agent, the transcription route, the booking write path or the privacy limits ([ADR 0009](0009-voice-input-and-spoken-output.md)).

## Decision

**One conversation, two views.** `ChatPanel` still owns the conversation (turn engine, idempotency, review state). Voice and Text are two views of it; switching never clears messages, the draft or a booking review. The recording flow moved from `VoiceInput` into a hook (`useVoiceCapture`) used by both the text composer and the voice stage. Voice is the first mode; a message prepared by a link (`?service=&date=`) waits, unsent, in the shared draft and the voice stage points to it ("Review it in Text").

**A voice session is something the visitor starts.** **Start voice assistant** speaks the fixed local welcome from inside the click (the browser's autoplay rules are respected, not worked around), turns on automatic reading of replies that arrive afterwards, and never records. The welcome is not a turn: no model call, no conversation id, no counter, not part of the model's history. A reload requires pressing Start again. **End voice session** cancels speech and any recording, turns automatic reading off and keeps the conversation and the review. Automatic reading applies only while the session is on *and* Voice is showing; leaving Voice stops speech, and Text keeps the manual Listen/Stop. The earlier "Read replies aloud" switch is removed: the session replaces it.

**The stage is derived, never simulated.** Its state comes from the capture hook (permission wait, recording, transcribing, a transcript waiting), the turn in flight and the speech controller: start, ready, preparing, listening, transcribing, review, thinking, speaking, error. "Sending" and "Thinking" are one real phase, because a turn is a single Server Action with no observable boundary between them; the stage says "Thinking" and that the message was sent. Every state has its own words and its own glyph, so none depends on colour or motion alone; motion is decoration under `prefers-reduced-motion: no-preference`.

**The transcript is reviewed before it is sent.** After transcription the stage shows "Review what I heard": editable text with **Send what I said**, **Record again** and **Cancel**. Nothing is sent until then. Record again replaces the transcript only when the new one arrives, so a refused microphone or a failed transcription keeps the previous one. Recording is not possible while a turn is being answered or read aloud, except through **Stop speaking**.

**A reply counts as read only when speech starts.** The controller reports the browser's `start` event; an error or a refused start (for example an autoplay block) leaves the reply unread and the stage offers **Read reply aloud**. Only an assistant reply's visible text is spoken; never the token, hidden fields, the booking review, the timeline or system notices.

**Local voice ranking.** English voices only; local voices before network voices; inside each group, names containing Natural, then Enhanced or Premium, then Online rank higher, then en-US, then the browser's default voice. No vendor-specific names are used. Because a network voice may send reply text to a speech service (ADR 0009), a network voice, **including a preferred "Online" one**, is used only after an explicit "Use the network voice"; the automatic choice is therefore the best *local* voice. Selection never throws: an unreadable list means "no voice". "Voice settings" offers the voice, the speed (0.75 to 1.25, default 0.95), Preview and Restore defaults, and says plainly that voices depend on the browser and device. Only `{ voiceName, rate }` is stored, under `quillwheel.voice-settings.v1`, validated field by field when read; a saved voice that no longer exists falls back to the automatic one, and the network-voice agreement is never stored.

**An app shell, not a page.** The assistant is a 100dvh shell with internal scrolling only (stage, text conversation and panels each scroll themselves; the document does not at normal text size). Transcript ("View transcript"), the execution timeline ("How this answer was made") and Voice settings are secondary panels: a column from the `lg` breakpoint, a replacement of the main view below it, not modal and never trapping focus, opened with `aria-expanded`/`aria-controls`, closed with Close or Escape, and returning focus to the control that opened them. The live booking review is shown once, prominently in the voice stage with the unchanged `ConfirmForm`; the transcript points to it instead of repeating the form. Below `lg` the panel buttons sit behind a "More" button to leave room for the stage. Where the viewport is too small for the shell (a `min-height` in rem), the document scrolls rather than hiding controls. The visual language is the home page's: celeste and dark teal on cream, a small hi-vis accent, soft shadows, one wheel-based orb.

**Fallbacks.** Without a microphone or `MediaRecorder` the voice view says so and offers Text; without `speechSynthesis` or a usable voice, voice input still works and replies stay on screen with a note; a refused microphone permission is explained, can be retried, and loses nothing.

## Consequences

- No server, API, OpenAPI, agent, prompt, model, provider or dependency change. `ConfirmForm`, its Server Action and `POST /v1/appointments` are untouched; the booking review is the same component in a different place.
- The default voice may sound less natural than an online one the visitor can choose; that is the price of keeping ADR 0009's rule.
- A real device, a real microphone, other browsers, a phone and a screen reader remain unverified; hands-free conversation, barge-in and streaming remain out of scope.
- The 200% text check uses the browser's own default font size (rem and media queries scale together); on a viewport whose height cannot hold the shell at that size the document scrolls instead.

## Alternatives considered

- **A separate voice conversation:** it would double the state and let the two diverge; one conversation with two views is simpler and safe.
- **Starting the session or the first recording automatically:** blocked by autoplay policy and contrary to the privacy rule that the microphone is requested only after a press.
- **Auto-sending the transcript:** a recognition error would spend a turn and approve text the visitor never saw.
- **Preferring the best-named voice even if it is a network voice:** simpler and better sounding, but it would send reply text off the device without a yes.
- **A modal dialog for the transcript:** traps focus and hides the review; a non-modal panel was chosen.
- **External text-to-speech:** out of scope for this iteration; the browser's local voices only.
