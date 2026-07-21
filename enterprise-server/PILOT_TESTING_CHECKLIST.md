# PocketMind Hybrid AI Enterprise Pilot Testing Checklist

## Pilot scope

- [ ] Pilot users selected: 3-5 people.
- [ ] Use cases selected: documents, drafting, coding, support, reports, or research.
- [ ] Allowed document sensitivity level defined.
- [ ] Pilot duration defined: usually 3-7 days.

## Server test

- [ ] Server detection report generated.
- [ ] GPU detected if expected.
- [ ] Model server starts successfully.
- [ ] `/v1/models` returns model list.
- [ ] `/v1/chat/completions` returns a response.
- [ ] Streaming response works.
- [ ] Server remains stable after repeated prompts.

## PocketMind Hybrid AI client test

- [ ] Organization Server page connects successfully.
- [ ] Models load from server.
- [ ] Server model can be selected in chat.
- [ ] Response streams into chat.
- [ ] Local mode still works if needed.
- [ ] Document attachments work with RAG-style relevant sections.
- [ ] Chat history remains separated by model/server mode.

## User acceptance

- [ ] Staff can open PocketMind Hybrid AI without assistance.
- [ ] Staff can select Organization Server model.
- [ ] Staff understand what data is allowed.
- [ ] Staff can ask document and drafting questions.
- [ ] Staff know who to contact for support.

## Decision after pilot

- [ ] Continue pilot.
- [ ] Expand to more users.
- [ ] Upgrade server/model.
- [ ] Add server-side RAG/knowledge base.
- [ ] Move toward signed production release.
