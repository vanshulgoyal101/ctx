/**
 * Test helper: build a gzipped tar (like a GitHub repo tarball) from a map of
 * path -> content, nested under a top-level directory. Not a test file.
 */

function writeString(buf: Uint8Array, str: string, offset: number, len: number): void {
  const bytes = new TextEncoder().encode(str);
  for (let i = 0; i < Math.min(bytes.length, len); i++) buf[offset + i] = bytes[i];
}

function makeTar(files: Record<string, Uint8Array>): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const [name, data] of Object.entries(files)) {
    const header = new Uint8Array(512);
    writeString(header, name, 0, 100);
    writeString(header, '0000644', 100, 8);
    writeString(header, '0000000', 108, 8);
    writeString(header, '0000000', 116, 8);
    writeString(header, data.length.toString(8).padStart(11, '0'), 124, 11);
    writeString(header, '00000000000', 136, 12);
    header[156] = 0x30; // typeflag '0' (regular file)
    writeString(header, 'ustar\0', 257, 6);
    writeString(header, '00', 263, 2);
    // checksum: spaces, sum, then octal
    for (let i = 148; i < 156; i++) header[i] = 0x20;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += header[i];
    writeString(header, sum.toString(8).padStart(6, '0'), 148, 6);
    header[154] = 0;
    header[155] = 0x20;

    blocks.push(header);
    const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
    padded.set(data);
    blocks.push(padded);
  }
  blocks.push(new Uint8Array(1024)); // two zero blocks terminate the archive

  const total = blocks.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const b of blocks) {
    out.set(b, offset);
    offset += b.length;
  }
  return out;
}

/** Build a gzipped tarball nested under `topdir/`, ready to serve as a fetch body. */
export async function makeTarball(
  files: Record<string, string | Uint8Array>,
  topdir = 'owner-repo-deadbeefcafe',
): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const nested: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(files)) {
    nested[`${topdir}/${path}`] = typeof content === 'string' ? enc.encode(content) : content;
  }
  const tar = makeTar(nested);
  const gzStream = new Response(tar).body!.pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(gzStream).arrayBuffer());
}

/** A fetch stub that returns the given gzipped tarball bytes as the body. */
export function tarballResponse(gz: Uint8Array, status = 200): Response {
  return new Response(gz, { status, headers: { 'content-type': 'application/gzip' } });
}
