# NexusAI Enterprise Security Checklist

## Network security

- [ ] Server is not exposed to the public internet unless approved.
- [ ] Access is limited to LAN, VPN, or trusted IP ranges.
- [ ] Firewall allows only required ports.
- [ ] Default test ports are closed after deployment if not needed.
- [ ] Internal DNS name is used where possible, for example `nexusai.internal`.

## Authentication

- [ ] Organization Server access token is enabled.
- [ ] Token is stored only on authorized employee devices.
- [ ] Token can be rotated if leaked.
- [ ] Different pilot/admin tokens are used if required.

## Data handling

- [ ] Pilot data policy is defined before testing.
- [ ] Staff know whether real company documents are allowed during pilot.
- [ ] Chat logs are disabled or controlled according to company policy.
- [ ] Server logs do not capture sensitive prompts unless explicitly approved.

## Server hardening

- [ ] OS updates applied.
- [ ] NVIDIA drivers installed from trusted source.
- [ ] Docker access restricted to admin users.
- [ ] Model files stored in a controlled directory.
- [ ] Backups and retention policy are defined if chat/log persistence is enabled.

## Production readiness

- [ ] HTTPS configured if traffic crosses networks.
- [ ] Reverse proxy timeout supports long streaming responses.
- [ ] Monitoring is enabled for GPU memory, CPU, RAM, disk, and server uptime.
- [ ] Incident contact person is defined.
