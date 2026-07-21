# Windows Server → Full Server RAG via WSL2

Native Windows Docker Desktop is **not** supported for this stack. Use **WSL2 Ubuntu + Docker Engine** (or Docker Desktop with WSL integration), then run the same Linux `install.sh`.

## 1. Install WSL2 + Ubuntu

On Windows Server (Admin PowerShell):

```powershell
wsl --install -d Ubuntu-22.04
```

Reboot if prompted. Open Ubuntu and finish the first-time user setup.

## 2. Install Docker inside Ubuntu (WSL)

Follow Docker’s current Engine install for Ubuntu, or:

```bash
# Inside WSL Ubuntu
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo usermod -aG docker "$USER"
```

Log out of WSL and back in so the `docker` group applies. Confirm:

```bash
docker info
docker compose version
```

### Docker Desktop alternative

If IT standardizes on Docker Desktop: enable **Use the WSL 2 based engine** and integrate with your Ubuntu distro. Run all commands below **inside that Ubuntu shell**.

## 3. NVIDIA GPU in WSL (optional but preferred)

1. Install a recent **NVIDIA Windows driver** that supports WSL.
2. Inside WSL, install the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) for Ubuntu.
3. Verify:

```bash
nvidia-smi
docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi
```

If the Docker GPU test fails, `./scripts/install.sh` will automatically use the **CPU** profile (slower but works).

## 4. Deploy Full Server RAG

Copy the `full-rag` folder into WSL (e.g. `~/pocketmind/full-rag`), then:

```bash
cd ~/pocketmind/full-rag
chmod +x scripts/*.sh
./scripts/install.sh
./scripts/smoke_test.sh
```

Force CPU:

```bash
./scripts/install.sh --cpu
```

Default data/model paths inside Linux are still:

- `/opt/nexusai/models`
- `/opt/nexusai/data`

Override in `.env` if you lack root (e.g. `$HOME/nexusai/models`). You may need `sudo mkdir` / ownership for `/opt/nexusai`.

## 5. Reach the gateway from Windows clients

From Windows, use the WSL IP or `localhost` if port forwarding is active:

```text
http://127.0.0.1:8080/v1
```

Paste the Bearer token printed by `install.sh` into PocketMind Organization Server / Server RAG settings.

## Unsupported on Windows for this package

- Native Windows Server PowerShell installer for full-rag
- ARM Windows / ARM WSL without x86_64 emulation guarantees
- Air-gapped install without pre-pulled images and GGUFs (this package assumes online pulls)
