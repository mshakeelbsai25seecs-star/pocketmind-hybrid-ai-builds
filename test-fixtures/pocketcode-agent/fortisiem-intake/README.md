# FortiSIEM intake notes

Operators often ask: **what is the logon time rule?**

Answer lives in `rules/auth-logon.xml`:
- Rule id: `PH_RULE_Logon_Time_Outside_Business`
- Event: `Win-Security-4624`
- Default window: 08:00–18:00
- Severity: 5
