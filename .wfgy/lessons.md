## 2026-09-26 -- Isolate GM phase state by session
Goal (G): Deliver a tested, pushed fix for the popup's local WebGPU model-loading stall.
What drifted / what went wrong: A concurrent GM session overwrote the shared turn-state file, resetting this release from DECIDE to SPECIFY after all release evidence was complete.
Fix / resolution: Complete the legal phase walk with preserved witnesses; a narrow GM patch now scopes turn-state and pending-gate data to the dispatch session.
Generalizes to: Never share mutable workflow state between concurrent sessions; carry the session identity into every state-file read and write.

## 2026-09-25 -- Recover completion only through a legal GM phase path
Goal (G): Deliver the portable local SemIf browser loop with verified CI release artifacts.
What drifted / what went wrong: The clean implementation reached GM SPECIFY and then PROVE, but neither phase had a legal direct edge to COMPLETE; retrying the transition would repeat the same gate denial.
Fix / resolution: Preserve the verified commit as the last known good state, record a dedicated GM repair row, invoke bounded-retry recovery, and use the repaired or documented legal path rather than bypassing validation.
Generalizes to: Treat a missing workflow edge as a workflow defect with its own evidence and repair path, never as an invitation to repeat a denied completion transition.

## 2026-09-26 -- Re-enter the legal lifecycle after a release-state reset
Goal (G): Deliver a tested and published browser-agent release with an honest terminal handoff.
What drifted / what went wrong: The corrective v0.1.5 commit returned the shared GM lifecycle to SPECIFY, while prior terminal evidence belonged to v0.1.4.
Fix / resolution: Preserve the green release as the checkpoint, add and resolve a concrete process residual, re-enter through SPECIFY to PROVE, and renew CI and independent-review witnesses for the corrected head.
Generalizes to: Commit-level evidence and lifecycle state must be renewed together after a corrective release.
