import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  try {
    const progressPath = resolve(process.cwd(), '..', 'WIRE-ROADMAP-PROGRESS.json');
    const [contents, fileInfo] = await Promise.all([
      readFile(progressPath, 'utf8'),
      stat(progressPath),
    ]);
    const progress: unknown = JSON.parse(contents);

    if (
      !progress
      || typeof progress !== 'object'
      || !('phases' in progress)
      || !Array.isArray(progress.phases)
    ) {
      throw new Error('Invalid roadmap progress data');
    }

    return NextResponse.json(
      { ...(progress as Record<string, unknown>), updatedAt: fileInfo.mtime.toISOString() },
      { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
    );
  } catch {
    return NextResponse.json(
      { error: 'No se pudo leer el avance del proyecto.' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
