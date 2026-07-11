import re

with open('src/database.rs', 'r') as f:
    content = f.read()

# Add update_character before delete_character
update_char = '''
    pub fn update_character(&self, id: &str, updates: &Character) -> Result<()> {
        let now = Utc::now().timestamp();
        self.conn.execute(
            "UPDATE characters SET name = ?1, description = ?2, system_prompt = ?3, 
             avatar_path = ?4, personality_traits = ?5, memory = ?6, folder_id = ?7, updated_at = ?8
             WHERE id = ?9",
            params![
                &updates.name, &updates.description, &updates.system_prompt,
                &updates.avatar_path, &updates.personality_traits, &updates.memory,
                &updates.folder_id, now, id
            ],
        )?;
        Ok(())
    }
'''

# Find the position to insert (before delete_character)
if 'pub fn delete_character' in content and 'pub fn update_character' not in content:
    content = content.replace(
        '    pub fn delete_character(&self, id: &str) -> Result<()> {',
        update_char + '\n    pub fn delete_character(&self, id: &str) -> Result<()> {'
    )
    print('Added update_character')

# Add set_setting before get_all_settings
set_setting = '''
    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) 
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }
'''

if 'pub fn get_all_settings' in content and 'pub fn set_setting' not in content:
    content = content.replace(
        '    pub fn get_all_settings(&self) -> Result<Vec<(String, String)>> {',
        set_setting + '\n    pub fn get_all_settings(&self) -> Result<Vec<(String, String)>> {'
    )
    print('Added set_setting')

with open('src/database.rs', 'w') as f:
    f.write(content)

print('Done')
