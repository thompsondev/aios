/**
 * Detect Prisma / driver errors where retrying later is appropriate
 * (Neon cold start, brief network loss, DNS blips).
 */
export function isTransientDatabaseError(error: unknown): boolean {
  const e = error as {
    code?: string;
    message?: string;
    meta?: {
      driverAdapterError?: { cause?: { kind?: string } };
    };
  };

  if (e?.code === 'P1001' || e?.code === 'P2010') return true;

  const kind = e?.meta?.driverAdapterError?.cause?.kind;
  if (kind === 'DatabaseNotReachable') return true;

  const msg = String(e?.message ?? error ?? '').toLowerCase();
  if (
    msg.includes("can't reach database") ||
    msg.includes('cannot reach database') ||
    msg.includes('database server') ||
    msg.includes('econnrefused') ||
    msg.includes('etimedout') ||
    msg.includes('enotfound')
  ) {
    return true;
  }

  return false;
}
