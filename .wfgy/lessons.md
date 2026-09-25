## 2026-09-25 -- Recover completion only through a legal GM phase path
Goal (G): Deliver the portable local SemIf browser loop with verified CI release artifacts.
What drifted / what went wrong: The clean implementation reached GM SPECIFY and then PROVE, but neither phase had a legal direct edge to COMPLETE; retrying the transition would repeat the same gate denial.
Fix / resolution: Preserve the verified commit as the last known good state, record a dedicated GM repair row, invoke bounded-retry recovery, and use the repaired or documented legal path rather than bypassing validation.
Generalizes to: Treat a missing workflow edge as a workflow defect with its own evidence and repair path, never as an invitation to repeat a denied completion transition.
