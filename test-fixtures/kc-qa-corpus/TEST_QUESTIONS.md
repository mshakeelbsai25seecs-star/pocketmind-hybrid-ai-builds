# Suggested QA questions

Ask these in Knowledge Chat with the **PocketMind Hybrid AI QA Corpus** collection selected.

## Code partition
- What does `handleSend` do in ChatView.tsx?
- What environment variable controls the API timeout in config_loader.py?
- What Rust function validates JWT tokens?

## Documentation
- What are the three layers in the PocketMind Hybrid AI architecture?
- How long does new-hire onboarding take?

## Runbooks
- What is the first step when responding to a VPN brute-force alert?
- Who approves an emergency password reset?

## Logs and data
- What error appears in app-2026-06-26.log for user alice?
- What does error code E-402 mean?

## General
- What industry does Acme Corp operate in?

## Codebase Explorer (cross-file navigation)

Switch Knowledge Chat to **Codebase Explorer** mode (header dropdown or Settings → Security)
and compare these engineering-style questions against Folder Q&A mode. Explorer mode injects a
repo map and pins matching function/class bodies before answering.

- How does a message get from ChatView.tsx to the backend?
- Which files handle authentication and configuration loading?
- What functions are defined in ChatView.tsx?
- How are JWT tokens validated in the Rust auth service?
- Where is the API timeout read from the environment and what is its default?
