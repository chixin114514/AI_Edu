# Apple Watch frontend continuation

**Goal:** Integrate master `b205ff7` into the existing mobile experience and make optional Watch setup understandable and cancellable.

**Architecture:** Preserve the existing relay API and native app. Keep connection state and pairing codes in page memory. Use the established secondary device area, warm-white/green palette, and existing confirmation dialogs. No new health storage or automatic consent.

**Tech stack:** Native JavaScript/CSS, Node test runner, Playwright CLI.

- [x] Import and verify upstream Git objects, resolve conflicts while preserving the mobile redesign and all Watch tests. Baseline combined suite: 87 tests.
- [x] Test UI behavior through registered click handlers: explicit consent, duplicate submission, closing during a pending request, session/account changes, and pairing-code expiry. Show current status with a recoverable pairing panel, setup steps, and a clear manual-feedback fallback.
- [x] Test and repair the sensor connection lifecycle so cancelled requests cannot clear a newer connection; display understandable network/non-JSON errors. Keep original relay serialization tests.
- [x] Match optional-device controls and pairing dialog to the mobile layout. Correct Bluetooth/Watch data descriptions, reset stale waveform, and disable baseline collection without a fresh reading.
- [x] Run `npm run check && npm test`, real-browser 320/390/768/1440px checks, guest planning/journey/Watch relay exercise with synthetic test readings, cancellation and expiry. Clearly distinguish web simulation from physical Watch validation.
- [ ] Obtain independent review, update validation notes, commit named files, and update PR #1 through the verified Moln-ya connection. Verify remote/local trees and preserve local history.
