# Mobile experience implementation plan

**Goal:** Deliver a legible mobile planning and adaptive journey flow with a restrained visual identity.

**Architecture:** Keep the Node service and endpoint contracts. Update the existing HTML shell, CSS and view functions. Keep draft state and pending generation in the client, without persisting model consent or sensor data.

**Tech stack:** Native HTML/CSS/ES modules, Node test runner, existing SQLite API tests, real browser verification.

## 1. Protect interaction behavior

- [x] Add `test/frontend.test.js` using the existing VM/DOM-stub approach, dispatching actual registered input/submit handlers and using real view rendering.
- [x] Demonstrate failing tests for draft retention across navigation/reload, malformed stored draft recovery, readable non-JSON HTTP errors, and duplicate generation prevention.
- [x] Preserve the existing API smoke test assertions.

## 2. Implement the core mobile experience

- [x] Update `public/index.html`: brand header, accessible more menu, four mobile destinations, viewport safe area and skip link.
- [x] Update `public/app.js`: compact planning view, optional details, draft lifecycle, pending/error rendering; prioritize current stop, pending suggestion and feedback; move simulation controls and sensor details below main tasks.
- [x] Rewrite `public/style.css` into readable sections with shared tokens, mobile-first spacing and desktop layouts. No framework or external font dependencies.
- [x] Bump `public/sw.js` shell cache so revised assets can be cached together.
- [x] Run `node test/frontend.test.js` until the new behavior tests pass; run `npm run check && npm test`.

## 3. Browser verification and delivery

- [x] At 390×844 verify first-screen planning, draft retention, rejected and accepted suggestions, check-in, end and report. At 320px and desktop verify overflow and controls.
- [x] Check console errors and relevant computed styles; save screenshots outside tracked source.
- [x] Document results in `docs/VALIDATION.md`, including demo-only and no hardware verification limitations.
- [ ] Review `git diff --check`, targeted diff and test output. Commit explicitly named files, push branch with verified Moln-ya connection, create and attach PR.

## Upstream integration

Merged master `9d98bbe` during continuation; kept district selectors, map lifecycle, account isolation, HTTPS and per-stop recommendations. Added regression coverage for automatic location preserving restored destination and immediate view refresh before optional history loading. Current suite: 78 tests.
