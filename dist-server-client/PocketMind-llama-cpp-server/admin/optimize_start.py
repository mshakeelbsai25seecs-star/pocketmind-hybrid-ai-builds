"""CLI: apply auto GPU plan then start docker compose (used by start-server.ps1)."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Allow `python optimize_start.py` from admin/ or package root.
ADMIN_DIR = Path(__file__).resolve().parent
PACKAGE_ROOT = ADMIN_DIR.parent
if str(ADMIN_DIR) not in sys.path:
    sys.path.insert(0, str(ADMIN_DIR))

from gpu_optimizer import (  # noqa: E402
    apply_plan_to_env,
    build_plan,
    save_plan,
)


def main() -> int:
    parser = argparse.ArgumentParser(description="Apply PocketMind GPU auto-optimizer to .env")
    parser.add_argument("--cpu", action="store_true", help="Force CPU plan")
    parser.add_argument("--print-only", action="store_true", help="Print plan without writing .env")
    args = parser.parse_args()

    env_file = PACKAGE_ROOT / ".env"
    if not env_file.is_file():
        example = PACKAGE_ROOT / ".env.example"
        if example.is_file():
            env_file.write_text(example.read_text(encoding="utf-8"), encoding="utf-8")
        else:
            print("ERROR: .env missing", file=sys.stderr)
            return 1

    plan = build_plan(PACKAGE_ROOT, env_file, force_cpu=args.cpu)
    print(f"strategy={plan.strategy}")
    print(f"mode={plan.mode}")
    print(f"gpu_layers={plan.gpu_layers}")
    print(f"ctx_size={plan.context_size}")
    print(f"model={plan.model_bytes_human} free_vram={plan.free_vram_human}")
    for n in plan.notes:
        print(f"note: {n}")
    if args.print_only:
        return 0
    apply_plan_to_env(env_file, plan)
    save_plan(PACKAGE_ROOT, plan, extra={"source": "optimize_start.py"})
    print("Applied to .env")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
