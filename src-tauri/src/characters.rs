use crate::database::{Character, Message};

pub fn build_context_with_memory(
    character: &Character, 
    conversation_history: &[Message]
) -> String {
    let mut context = String::new();
    
    context.push_str(&character.system_prompt);
    context.push_str("\n\n");
    
    if !character.personality_traits.is_empty() {
        context.push_str("Personality: ");
        context.push_str(&character.personality_traits);
        context.push_str("\n\n");
    }
    
    if !character.memory.is_empty() {
        context.push_str("Memory: ");
        context.push_str(&character.memory);
        context.push_str("\n\n");
    }
    
    for msg in conversation_history.iter().rev().take(20).rev() {
        let role_cap = if msg.role == "user" { "User" } else { "Assistant" };
        context.push_str(&format!("{}: {}\n", role_cap, msg.content));
    }
    
    context.push_str("Assistant: ");
    context
}

pub fn estimate_tokens(text: &str) -> usize {
    text.len() / 4
}