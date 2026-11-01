Before changing production code, add or extend tests that fail for the bug or missing behavior.

1. Reproduce the failure with the smallest test that proves the gap.
2. Implement the fix while keeping the test red/green cycle honest.
3. Prefer behavior assertions over implementation details.
4. Run the narrowest suite first, then the package gate relevant to the touched app.

Never weaken security or approval tests to make a change pass.
