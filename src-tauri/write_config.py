import json

config = {
    "build": {
        "beforeDevCommand": "npm run dev",
        "beforeBuildCommand": "npm run build",
        "devPath": "http://localhost:5173",
        "distDir": "../dist"
    },
    "tauri": {
        "allowlist": {
            "all": False,
            "shell": {
                "all": False,
                "open": True
            },
            "fs": {
                "all": True,
                "readFile": True,
                "writeFile": True,
                "readDir": True,
                "copyFile": True,
                "createDir": True,
                "removeDir": True,
                "removeFile": True,
                "renameFile": True,
                "exists": True
            },
            "path": {
                "all": True
            },
            "dialog": {
                "all": True
            },
            "window": {
                "all": False,
                "close": True,
                "hide": True,
                "show": True,
                "maximize": True,
                "minimize": True,
                "unmaximize": True,
                "unminimize": True,
                "startDragging": True
            }
        },
        "bundle": {
            "active": True,
            "category": "Productivity",
            "copyright": "NexusAI",
            "identifier": "com.nexusai.app",
            "icon": [
                "icons/32x32.png",
                "icons/128x128.png",
                "icons/128x128@2x.png",
                "icons/icon.icns",
                "icons/icon.ico"
            ],
            "targets": "all",
            "windows": {
                "certificateThumbprint": None,
                "digestAlgorithm": "sha256",
                "timestampUrl": ""
            },
            "macOS": {
                "entitlements": None,
                "exceptionDomain": "",
                "frameworks": [],
                "providerShortName": None,
                "signingIdentity": None
            }
        },
        "security": {
            "csp": "default-src 'self'; connect-src 'self' https:; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'"
        },
        "updater": {
            "active": False
        },
        "windows": [
            {
                "fullscreen": False,
                "height": 920,
                "resizable": True,
                "title": "NexusAI",
                "width": 1440,
                "minWidth": 800,
                "minHeight": 600,
                "center": True,
                "decorations": True,
                "transparent": False
            }
        ]
    }
}

with open('tauri.conf.json', 'w') as f:
    json.dump(config, f, indent=2)

print('Config written successfully')
