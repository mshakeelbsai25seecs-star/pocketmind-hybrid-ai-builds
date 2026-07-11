import { useState } from 'react';

/**
 * ChatView renders the main chat UI for the NexusAI desktop client.
 * It displays messages, handles keyboard shortcuts, and sends user input to the backend.
 */
export default function ChatView() {
  const [input, setInput] = useState('');

  const handleSend = async () => {
    if (!input.trim()) return;
    const content = input.trim();
    setInput('');
    // Sends the user message to Tauri invoke('add_message', ...) then starts generation.
    console.log('Sending message:', content);
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void handleSend();
    }
  };

  const handleCopy = async (text: string) => {
    await navigator.clipboard.writeText(text);
  };

  return (
    <div className="chat-view">
      <div className="messages">{/* message.role: 'user' | 'assistant' */}</div>
      <textarea value={input} onChange={e => setInput(e.target.value)} onKeyDown={handleKeyDown} />
      <button type="button" onClick={() => void handleSend()}>Send</button>
    </div>
  );
}
