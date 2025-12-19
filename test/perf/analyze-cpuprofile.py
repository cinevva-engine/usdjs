#!/usr/bin/env python3
import json
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: analyze-cpuprofile.py <file.cpuprofile> [topN]", file=sys.stderr)
        return 2
    p = Path(sys.argv[1])
    topn = int(sys.argv[2]) if len(sys.argv) >= 3 else 25

    prof = json.loads(p.read_text(encoding="utf-8"))
    nodes = prof.get("nodes", [])
    samples = prof.get("samples", [])
    time_deltas = prof.get("timeDeltas", [])

    by_id = {n["id"]: n for n in nodes if "id" in n}

    # Build parent pointers
    parent_by_id = {}
    for n in nodes:
        for child in n.get("children", []) or []:
            parent_by_id[child] = n["id"]

    # If timeDeltas missing, fall back to 1000us per sample
    if not time_deltas or len(time_deltas) != len(samples):
        time_deltas = [1000] * len(samples)

    self_us = {}
    total_us = {}

    # Accumulate self time per sampled node
    for nid, dt in zip(samples, time_deltas):
        self_us[nid] = self_us.get(nid, 0) + dt
        # Attribute inclusive time up the stack by walking parents (cheap enough for our profile sizes)
        cur = nid
        while cur is not None:
            total_us[cur] = total_us.get(cur, 0) + dt
            cur = parent_by_id.get(cur)

    def label(nid: int) -> str:
        n = by_id.get(nid, {})
        cf = (n.get("callFrame") or {})
        fn = cf.get("functionName") or "(anonymous)"
        url = cf.get("url") or ""
        line = cf.get("lineNumber")
        if url:
            loc = f"{url}:{(line + 1) if isinstance(line, int) else ''}"
            return f"{fn}  [{loc}]"
        return fn

    def fmt_ms(us: int) -> str:
        return f"{us/1000.0:9.3f} ms"

    total_profile_us = sum(time_deltas)
    print(f"profile: {p}")
    print(f"samples: {len(samples)} total_time: {total_profile_us/1000.0:.3f} ms")
    print()

    # Top by self time
    top_self = sorted(self_us.items(), key=lambda kv: kv[1], reverse=True)[:topn]
    print(f"Top {topn} by SELF time:")
    for nid, us in top_self:
        pct = (us / total_profile_us * 100.0) if total_profile_us else 0.0
        print(f"  {fmt_ms(us)}  {pct:6.2f}%  {label(nid)}")
    print()

    # Top by total time
    top_total = sorted(total_us.items(), key=lambda kv: kv[1], reverse=True)[:topn]
    print(f"Top {topn} by TOTAL time (inclusive):")
    for nid, us in top_total:
        pct = (us / total_profile_us * 100.0) if total_profile_us else 0.0
        print(f"  {fmt_ms(us)}  {pct:6.2f}%  {label(nid)}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())


