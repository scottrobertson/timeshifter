import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// A fake ffmpeg that does what the real remux does for our purposes: copies
// the -i input to the last argument (the output path).
const COPY_SCRIPT = `#!/bin/sh
prev=""
input=""
out=""
for arg in "$@"; do
  if [ "$prev" = "-i" ]; then input="$arg"; fi
  prev="$arg"
  out="$arg"
done
cat "$input" > "$out"
`;

const FAIL_SCRIPT = `#!/bin/sh
echo "corrupt input" >&2
exit 1
`;

/**
 * Put a fake ffmpeg first on PATH so download() can be tested without the real
 * one. Returns a restore function to call in afterEach.
 */
export async function installFakeFfmpeg(kind: "copy" | "fail"): Promise<() => void> {
  const dir = await mkdtemp(path.join(tmpdir(), "fake-ffmpeg-"));
  const script = kind === "copy" ? COPY_SCRIPT : FAIL_SCRIPT;
  await writeFile(path.join(dir, "ffmpeg"), script, { mode: 0o755 });
  const realPath = process.env.PATH;
  process.env.PATH = `${dir}:${realPath}`;
  return () => {
    process.env.PATH = realPath;
  };
}

// A fake comskip. It's given the video as the last argument. The "edl" variant
// writes an .edl and exits 0; "empty" writes an (empty) .edl but exits non-zero,
// like real comskip when it finds no commercials; "fail" writes nothing and
// exits non-zero, like a genuine error.
const COMSKIP_EDL_SCRIPT = `#!/bin/sh
for arg in "$@"; do input="$arg"; done
printf '0.00\\t30.00\\t0\\n120.00\\t150.00\\t0\\n' > "\${input%.*}.edl"
: > "\${input%.*}.log"
`;

const COMSKIP_EMPTY_SCRIPT = `#!/bin/sh
for arg in "$@"; do input="$arg"; done
: > "\${input%.*}.edl"
exit 1
`;

const COMSKIP_FAIL_SCRIPT = `#!/bin/sh
echo "no video stream" >&2
exit 1
`;

/**
 * Write a fake comskip and return its path to set as COMSKIP_PATH. Restore
 * COMSKIP_PATH yourself in afterEach.
 */
export async function installFakeComskip(kind: "edl" | "empty" | "fail"): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "fake-comskip-"));
  const script =
    kind === "edl" ? COMSKIP_EDL_SCRIPT : kind === "empty" ? COMSKIP_EMPTY_SCRIPT : COMSKIP_FAIL_SCRIPT;
  const bin = path.join(dir, "comskip");
  await writeFile(bin, script, { mode: 0o755 });
  return bin;
}
