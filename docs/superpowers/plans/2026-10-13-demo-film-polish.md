# Continuous demo film refinement

**Goal:** Refine the approved 45-second continuous app demonstration using the supplied reference's typography, camera movement and brand-color transitions, and make it editable in Remotion Studio.

**Architecture:** Preserve one mounted recording and its original timeline. The user subsequently requested a reference-inspired Logo opening: use 2.4 seconds and shorten only the final static tail to keep 45 seconds. Separate editable copy (inline Composition defaultProps in Root.tsx), camera keyframes, and visual composition. All footage remains real demo-mode UI; presentation effects do not alter the application.

**Tech stack:** Remotion 4.0.535, React, TypeScript, FFmpeg, Playwright CLI for Studio verification.

- [x] Inspect reference and source recording. Identify operation points and safe focus areas; do not infer the reference's authoring software from visuals.
- [x] Add src/Root.tsx with inline editable defaultProps: brand, accent, motion strength, captions and operation hints. Use built-in inferred Studio controls, without new dependencies.
- [x] Add src/camera.ts with continuous eased keyframes. Update src/video.tsx with staggered masked copy, geometric brand background and focused camera movement. Keep a single OffthreadVideo across all chapters.
- [x] Add macOS preview/export launchers and a Chinese editing guide covering Props, save, preview, render, camera timing and the limits of changing baked-in recordings.
- [x] Run npm run check; inspect representative frames including detail, rejection, acceptance, journal input and ending. Verify Studio editing and persistence with a reversible change.
- [x] Render the complete film and check dimensions, duration, frame rate and decoding. Deliver a separate V2 MP4, preserving the first version.
- [x] Commit only video-project and documentation changes. Update the existing codex/app-demo-animation branch and draft PR 8 using the authenticated Moln-ya connector; do not merge master.
