# VPN brute-force incident response

## Trigger

More than 20 failed VPN logins from one source IP within 10 minutes.

## Steps

1. **Contain** — Block the source IP on the VPN gateway (FortiGate policy ID VPN-BLOCK-TEMP).
2. **Triage** — Check whether any attempt succeeded; if yes, escalate to tier 2 immediately.
3. **Notify** — Open a ticket in ServiceNow category `SEC-VPN` and page the on-call engineer.
4. **Preserve** — Export auth logs from the SIEM for the last 24 hours.
5. **Recover** — Remove the temporary block only after threat intel review.

## Escalation

Contact **soc-leads@acme.example** if customer data may be affected.
