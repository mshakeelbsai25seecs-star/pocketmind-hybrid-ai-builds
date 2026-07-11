import os

# Read current file
with open('src/database.rs', 'r') as f:
    content = f.read()

# Fix 1: Replace the broken create_dir_all line
old = '''std::fs::create_dir_all(&app_dir).map_err(|e| rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(1),
            Some(e.to_string())
        ))?;'''

new = 'std::fs::create_dir_all(&app_dir).map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;'

if old in content:
    content = content.replace(old, new)
    print('Fixed create_dir_all')
else:
    print('create_dir_all not found in expected form, checking...')
    # Show lines around create_dir_all
    lines = content.split('\n')
    for i, line in enumerate(lines):
        if 'create_dir_all' in line:
            print(f'Line {i+1}: {line}')
            for j in range(max(0, i-1), min(len(lines), i+3)):
                print(f'  {j+1}: {lines[j]}')

# Fix 2: Check for any SELECT using execute
lines = content.split('\n')
for i, line in enumerate(lines, 1):
    if '.execute(' in line:
        stripped = line.strip().lower()
        if 'select' in stripped or 'from' in stripped:
            print(f'WARNING: Possible SELECT on line {i}: {line.strip()}')

# Write back
with open('src/database.rs', 'w') as f:
    f.write(content)

print('Done')
