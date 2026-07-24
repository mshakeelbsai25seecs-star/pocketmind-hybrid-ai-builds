import { exportSocTextFile, type SocExportKind } from './socLocalExport';
import type { Message } from './types';

export type ChatExportKind = 'md' | 'json' | 'txt';

function toSocKind(kind: ChatExportKind): SocExportKind {
  return kind;
}

export function renderChatExport(title: string, modelLabel: string, messages: Message[], kind: ChatExportKind): string {
  if (kind === 'json') {
    return JSON.stringify(
      {
        title,
        model: modelLabel,
        messages: messages.map(m => ({
          id: m.id,
          role: m.role,
          content: m.content,
          created_at: m.created_at,
        })),
      },
      null,
      2,
    );
  }

  if (kind === 'txt') {
    return [
      title,
      `Model: ${modelLabel}`,
      '---',
      ...messages.map(m => `${String(m.role).toUpperCase()}\n${m.content}\n`),
    ].join('\n');
  }

  return [
    `# ${title}`,
    '',
    `_Model: ${modelLabel}_`,
    '',
    ...messages.flatMap(m => [`## ${m.role}`, '', m.content, '']),
  ].join('\n');
}

export async function exportChatAs(
  title: string,
  modelLabel: string,
  messages: Message[],
  kind: ChatExportKind,
) {
  const contents = renderChatExport(title, modelLabel, messages, kind);
  return exportSocTextFile({
    defaultFileName: `${title || 'chat'}.${kind}`,
    contents,
    kind: toSocKind(kind),
    title: `Export chat as ${kind.toUpperCase()}`,
  });
}
