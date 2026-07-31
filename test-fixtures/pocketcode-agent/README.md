# PocketCode agent golden fixtures

Offline fixtures for Cursor-parity measurement (Phase 0).

| Fixture | Purpose |
|---------|---------|
| `fortisiem-intake/` | XML/MD data workspace — Q&A without code symbols |
| `mini-code/` | Tiny TypeScript tree — locate + edit |

Run the harness (no LLM required — fingerprints, ranking, prompt, skills):

```bash
npm run test:agent-parity
```

Live LLM golden runs are manual: open each folder in PocketCode Ask/Agent and check
`lastToolMetrics.duplicates` stays ≤ 1 and steps stay within `GOLDEN.json` budgets.
