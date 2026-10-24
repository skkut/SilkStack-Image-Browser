// @vitest-environment node
//
// Covers the source-file check behind cached thumbnails
// (electron/thumbnailSource.mjs). The decision it drives — withhold a
// thumbnail and drop the image — is irreversible from the renderer's side
// (the file is gone; the row must be rediscovered by a scan), so the tests
// pin down both halves of the rule:
//
//   - only a well-formed `${root}::${relative}-${timestamp}` key is probed at
//     all (a mis-parse must never stat a path that could then "go missing"),
//   - a negative answer is believed only when the library root is readable, the
//     parent directory lists without the file, and a final stat agrees;
//     everything else is "unknown" and keeps serving the cached bytes.
import { describe, expect, it } from 'vitest';
import path from 'node:path';

import {
  classifyThumbnailSource,
  parseThumbnailKey,
} from '../../electron/thumbnailSource.mjs';

/** Platform-appropriate root: `C:\Photos` on Windows, `/Photos` elsewhere. */
const ROOT = path.join(path.parse(process.cwd()).root, 'Photos');
const RELATIVE = 'subdir/ghost image.png';
const FILE = path.join(ROOT, 'subdir', 'ghost image.png');
const TIMESTAMP = 1761312345678;
const KEY = `${ROOT}::${RELATIVE}-${TIMESTAMP}`;

type ProbeResult = 'yes' | 'no' | 'unknown';

/**
 * Scripted IO port that answers `stat`/`list` from queues and records the paths
 * it was asked about. Running out of scripted answers is a failure — it means
 * the classification took a path it should not have.
 */
const makeIo = (
  { stats = [], listings = [] }: {
    stats?: ProbeResult[];
    listings?: Array<string[] | null>;
  } = {},
) => {
  const statCalls: string[] = [];
  const listCalls: string[] = [];
  const io = {
    stat: async (filePath: string): Promise<ProbeResult> => {
      statCalls.push(filePath);
      const answer = stats.shift();
      if (answer === undefined) {
        throw new Error(`unexpected stat: ${filePath}`);
      }
      return answer;
    },
    list: async (directoryPath: string): Promise<string[] | null> => {
      listCalls.push(directoryPath);
      const answer = listings.shift();
      if (answer === undefined) {
        throw new Error(`unexpected list: ${directoryPath}`);
      }
      return answer;
    },
  };
  return { io, statCalls, listCalls };
};

const PARENT = path.dirname(FILE);
const BASE = path.basename(FILE);

describe('parseThumbnailKey', () => {
  it('splits a normal key into root, relative path and absolute file', () => {
    expect(parseThumbnailKey(KEY)).toEqual({
      imageId: `${ROOT}::${RELATIVE}`,
      root: ROOT,
      relativePath: RELATIVE,
      file: FILE,
    });
  });

  it('takes the LAST dash as the timestamp separator (names contain dashes)', () => {
    const key = `${ROOT}::my-folder/my-image-name-${TIMESTAMP}`;
    const parsed = parseThumbnailKey(key);

    expect(parsed?.relativePath).toBe('my-folder/my-image-name');
    expect(parsed?.file).toBe(
      path.join(ROOT, 'my-folder', 'my-image-name'),
    );
  });

  it('rejects a legacy id with no directory separator', () => {
    expect(parseThumbnailKey(`legacy-file.png-${TIMESTAMP}`)).toBeNull();
  });

  it('rejects an id whose timestamp is missing (the `-undefined` key)', () => {
    expect(parseThumbnailKey(`${ROOT}::a.png-undefined`)).toBeNull();
  });

  it('rejects a relative root', () => {
    const relativeRoot = path.join('relative', 'Photos');
    expect(parseThumbnailKey(`${relativeRoot}::a.png-${TIMESTAMP}`)).toBeNull();
  });

  it('rejects a relative path that escapes the root', () => {
    expect(parseThumbnailKey(`${ROOT}::../outside.png-${TIMESTAMP}`)).toBeNull();
  });

  it('rejects non-string keys', () => {
    expect(parseThumbnailKey(undefined)).toBeNull();
    expect(parseThumbnailKey(42)).toBeNull();
  });
});

describe('classifyThumbnailSource', () => {
  interface TestIo {
    stat: (filePath: string) => Promise<ProbeResult>;
    list: (directoryPath: string) => Promise<string[] | null>;
  }
  const classify = (io: TestIo) =>
    classifyThumbnailSource(KEY, io, { confirmDelayMs: 0 });

  it('reports "present" when the file is there', async () => {
    const { io, statCalls, listCalls } = makeIo({ stats: ['yes', 'yes'] });

    await expect(classify(io)).resolves.toBe('present');
    expect(statCalls).toEqual([ROOT, FILE]);
    expect(listCalls).toEqual([]);
  });

  it('reports "missing" only when the parent listing excludes the file', async () => {
    const { io, statCalls, listCalls } = makeIo({
      stats: ['yes', 'no', 'no'],
      listings: [['someone-else.png']],
    });

    await expect(classify(io)).resolves.toBe('missing');
    expect(statCalls).toEqual([ROOT, FILE, FILE]);
    expect(listCalls).toEqual([PARENT]);
  });

  it('serves the thumbnail when the listing still has the file', async () => {
    // Listed but not stat-able is not deletion — a just-created file or a
    // permission quirk must keep its cached thumbnail.
    const { io, statCalls } = makeIo({
      stats: ['yes', 'no'],
      listings: [[BASE]],
    });

    await expect(classify(io)).resolves.toBe('present');
    expect(statCalls).toEqual([ROOT, FILE]);
  });

  it('serves the thumbnail when the file is recreated after the listing', async () => {
    // The listing is a snapshot; the final stat closes the creation race so a
    // file written in that window cannot lose its row.
    const { io } = makeIo({
      stats: ['yes', 'no', 'yes'],
      listings: [['someone-else.png']],
    });

    await expect(classify(io)).resolves.toBe('present');
  });

  it('never probes the file when the library root is unreachable', async () => {
    const { io, statCalls, listCalls } = makeIo({ stats: ['no'] });

    await expect(classify(io)).resolves.toBe('unknown');
    expect(statCalls).toEqual([ROOT]);
    expect(listCalls).toEqual([]);
  });

  it('treats an unreadable root as unknown, not as deletion', async () => {
    const { io } = makeIo({ stats: ['unknown'] });

    await expect(classify(io)).resolves.toBe('unknown');
  });

  it('treats an unreadable file as unknown (EACCES, EBUSY, I/O error)', async () => {
    const { io, listCalls } = makeIo({ stats: ['yes', 'unknown'] });

    await expect(classify(io)).resolves.toBe('unknown');
    expect(listCalls).toEqual([]);
  });

  it('stays unknown when the parent directory cannot be listed', async () => {
    // This is the network-share guard: a transient ENOENT from stat is not
    // enough to drop rows if the directory itself cannot be read.
    const { io, statCalls } = makeIo({
      stats: ['yes', 'no'],
      listings: [null],
    });

    await expect(classify(io)).resolves.toBe('unknown');
    expect(statCalls).toEqual([ROOT, FILE]);
  });

  it('stays unknown when the final stat fails', async () => {
    const { io } = makeIo({
      stats: ['yes', 'no', 'unknown'],
      listings: [[]],
    });

    await expect(classify(io)).resolves.toBe('unknown');
  });

  it.skipIf(process.platform !== 'win32')(
    'matches listing entries case-insensitively on Windows',
    async () => {
      const { io } = makeIo({
        stats: ['yes', 'no'],
        listings: [[BASE.toUpperCase()]],
      });

      await expect(classify(io)).resolves.toBe('present');
    },
  );

  it('does not touch the filesystem for an unparseable key', async () => {
    const { io, statCalls, listCalls } = makeIo();

    await expect(
      classifyThumbnailSource('legacy-file.png-1761312345678', io, {
        confirmDelayMs: 0,
      }),
    ).resolves.toBe('unknown');
    expect(statCalls).toEqual([]);
    expect(listCalls).toEqual([]);
  });
});
