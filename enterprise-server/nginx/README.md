# Nginx Reverse Proxy

Use Nginx when the company wants one stable internal URL such as:

```text
http://nexusai.internal/v1
```

The proxy can later be extended with:

- HTTPS/TLS
- IP allowlists
- token validation
- access logs
- internal DNS
- VPN-only access

For the first pilot, keep it LAN-only and simple.
